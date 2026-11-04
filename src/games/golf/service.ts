// Chain Golf's calls to onicai's canister: the hole for each lobby, a round for each golfer once the
// race starts, and their shots. The race only records what comes back; nothing here holds a
// request to the bot for longer than the canister takes.
import { miniAppGameKey, type MiniAppGame } from "@open-ic/openchat-botclient-ts";
import { OnicaiError, type Onicai } from "../../onicai";
import type { Publisher } from "../../publisher";
import type { GameStore } from "../../store";
import { GolfRace } from "./race";
import { utcDay, type Course, type ShotResponse } from "./types";

/** How long a failed call waits before it's tried again by the sweep */
const RETRY_MS = 5000;

export class GolfService {
    /** Each day's holes, by level */
    readonly #holes = new Map<number, Course>();
    readonly #holesLoading = new Map<number, Promise<Course>>();
    /** Rounds being started, by game and golfer */
    readonly #teeing = new Map<string, Promise<void>>();
    /** When a failed call may be tried again, by what it was for */
    readonly #retryAt = new Map<string, number>();

    constructor(
        private readonly onicai: Onicai,
        private readonly store: GameStore,
        private readonly publisher: Publisher,
        /** What onicai's leaderboard shows for each round, or "anon" if empty */
        private readonly playerName: string,
        private readonly now: () => number = Date.now,
    ) {}

    /** Every second, from the sweep: gets every race what it's waiting for from the canister */
    tick(): void {
        for (const { game } of this.store.entries()) this.prepare(game);
    }

    /**
     * Gets a race what it's waiting for: a lobby its hole, or a started race its golfers' rounds.
     * Doesn't wait for the canister.
     */
    prepare(game: MiniAppGame): void {
        const race = this.#race(game);
        if (race === undefined) return;
        if (race.phase === "open") {
            const level = race.holeWanted();
            if (level !== undefined) void this.#holeFor(game, level).catch(() => {});
        } else if (race.phase === "active") {
            for (const golfer of race.teeing()) void this.#teeOff(game, golfer.id).catch(() => {});
        }
    }

    /** Plays the golfer's shot on the canister and records it */
    async shoot(game: MiniAppGame, userId: string, angle: number, power: number): Promise<ShotResponse> {
        const race = this.#race(game);
        if (race === undefined) return { ok: false, error: "This race is over" };
        const refusal = race.beginShot(userId);
        if (refusal !== undefined) return { ok: false, error: refusal };
        try {
            if (race.golfer(userId)?.roundId === undefined) await this.#teeOff(game, userId);
            const golfer = race.golfer(userId);
            if (golfer?.roundId === undefined || golfer.key === undefined) {
                race.shotFailed(userId);
                return { ok: false, error: "Your round couldn't be started on the chain" };
            }
            const shot = await this.onicai.golfShot(golfer.roundId, golfer.key, angle, power);
            const view = race.recordShot(userId, shot);
            this.#changed(game);
            if (view === undefined) return { ok: false, error: "The race was over before the shot landed" };
            return { ok: true, frames: shot.frames, golfer: view };
        } catch (err) {
            race.shotFailed(userId);
            console.error(`A shot in ${miniAppGameKey(game)} failed:`, err);
            // The canister refused it, perhaps as an earlier shot, whose answer was lost, ended the
            // round: the race takes the round as it stands
            if (err instanceof OnicaiError && err.status !== undefined) {
                await this.#syncRound(race, userId);
            }
            this.#changed(game);
            const why = err instanceof OnicaiError ? err.message : "something went wrong";
            return { ok: false, error: `The chain didn't take the shot: ${why}` };
        }
    }

    async #syncRound(race: GolfRace, userId: string): Promise<void> {
        const roundId = race.golfer(userId)?.roundId;
        if (roundId === undefined) return;
        try {
            race.syncRound(userId, await this.onicai.golfRound(roundId));
        } catch (err) {
            console.error(`Couldn't read round ${roundId}:`, err);
        }
    }

    /** Gets the lobby the day's hole at its level, fetching it once for every lobby that wants it */
    async #holeFor(game: MiniAppGame, level: number): Promise<void> {
        const known = this.#holes.get(level);
        if (known !== undefined && known.day === utcDay(this.now())) {
            if (this.#race(game)?.setHole(known)) this.#changed(game);
            return;
        }
        const retryKey = `hole:${level}`;
        if ((this.#retryAt.get(retryKey) ?? 0) > this.now()) return;
        let loading = this.#holesLoading.get(level);
        if (loading === undefined) {
            loading = this.onicai.golfToday(level);
            this.#holesLoading.set(level, loading);
            loading.then(
                (course) => {
                    this.#holes.set(level, course);
                    this.#retryAt.delete(retryKey);
                },
                (err) => {
                    console.error(`Couldn't fetch today's level ${level} hole:`, err);
                    this.#retryAt.set(retryKey, this.now() + RETRY_MS);
                },
            );
            loading.finally(() => this.#holesLoading.delete(level)).catch(() => {});
        }
        try {
            const course = await loading;
            if (this.#race(game)?.setHole(course)) this.#changed(game);
        } catch {
            // Tried again by the sweep
        }
    }

    /** Starts the golfer's round on the canister, once however often it's asked for meanwhile */
    #teeOff(game: MiniAppGame, userId: string): Promise<void> {
        const key = `${miniAppGameKey(game)}/${userId}`;
        const inFlight = this.#teeing.get(key);
        if (inFlight !== undefined) return inFlight;
        const race = this.#race(game);
        const level = race?.hole()?.level;
        if (race === undefined || level === undefined) return Promise.resolve();
        if ((this.#retryAt.get(key) ?? 0) > this.now()) {
            return Promise.reject(new OnicaiError("onicai didn't answer just now; try again shortly"));
        }
        const teeing = (async () => {
            try {
                const round = await this.onicai.createGolfRound(this.playerName, level);
                const course = race.hole();
                if (course !== undefined && round.day !== course.day) {
                    // The race started before midnight UTC and this round after it, on the new hole
                    console.warn(`A round in ${key} is on day ${round.day}'s hole, not ${course.day}'s`);
                }
                if (race.setRound(userId, round)) this.#changed(game);
                this.#retryAt.delete(key);
            } catch (err) {
                console.error(`Couldn't start a round for ${key}:`, err);
                this.#retryAt.set(key, this.now() + RETRY_MS);
                throw err;
            } finally {
                this.#teeing.delete(key);
            }
        })();
        this.#teeing.set(key, teeing);
        return teeing;
    }

    #race(game: MiniAppGame): GolfRace | undefined {
        const play = this.store.get(game)?.play;
        return play instanceof GolfRace ? play : undefined;
    }

    #changed(game: MiniAppGame): void {
        this.store.save();
        this.publisher.publish(game);
    }
}
