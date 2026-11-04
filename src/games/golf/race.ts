// A Chain Golf race: everyone seated plays the same hole, onicai's hole of the day at the level the
// host picks, each with their own round on onicai's canister, which simulates every shot with Box2D.
// The fewest strokes wins, and the first to hole it wins a tie. When the time's up, only those who
// have holed it can win.
//
// The race itself makes no calls: `service.ts` fetches the hole, starts each golfer's round and
// plays their shots on the canister, and tells the race what came back.
import { openRace, Race, type RaceData, type RaceOptions, type RaceSpec } from "../race";
import type { GameKind, Host, Seat } from "../game";
import type { Settings } from "../settings";
import type { NewRound, Round, ShotResult } from "../../onicai";
import {
    GAME_ID,
    GOLF_SETTINGS,
    MAX_PLAYERS,
    STATE_VERSION,
    utcDay,
    type Course,
    type GolfEnded,
    type GolferStatus,
    type GolferView,
    type GolfShared,
    type Point,
} from "./types";

/** A golfer as the bot keeps them, with their round's key, which no one else sees */
export type Golfer = Seat & {
    status: GolferStatus;
    strokes: number;
    ball: Point;
    roundId?: number;
    key?: string;
    doneAt?: number;
    last?: { shot: number; path: [number, number][]; frames: number };
    /** When their shot went to the canister, while it's out */
    shotSince?: number;
};

export type GolfData = RaceData<Golfer, GolfEnded> & {
    /** The hole: before the start, the one for the settings' level; from it, the one played */
    course?: Course;
};

const SPEC: RaceSpec = { settings: GOLF_SETTINGS, maxPlayers: MAX_PLAYERS };

/**
 * How long the race waits past its time for shots that went to the canister before it: long enough
 * for a golfer's round to start and their shot to be played, each of which can take 20 seconds
 */
export const SHOT_GRACE_MS = 45_000;
/** A shot out for longer than this is taken to be lost, so the golfer can shoot again */
export const SHOT_LOST_MS = 60_000;
/** The most points of a shot's flight everyone's sent, so a state stays small */
const PATH_POINTS = 60;

export class GolfRace extends Race<Golfer, GolfEnded, GolfData, GolfShared> {
    readonly kind: GameKind = GAME_ID;

    constructor(data: GolfData, options: RaceOptions = {}) {
        super(SPEC, data, options);
    }

    static create(host: Host | undefined, settings?: Settings, options: RaceOptions = {}): GolfRace {
        return new GolfRace(openRace({ ...options, host, settings }), options);
    }

    /** The hole: in the lobby, the latest for the settings' level; from the start, the one played */
    hole(): Course | undefined {
        return this.data.course;
    }

    /** The settings' level */
    level(): number {
        return this.settings().level;
    }

    /**
     * The level whose hole the lobby needs: it has none yet, or one for another level, or from
     * another day. Undefined once the race has started, as its hole is fixed then.
     */
    holeWanted(): number | undefined {
        const d = this.data;
        if (d.phase !== "open") return undefined;
        const level = this.level();
        const course = d.course;
        const current =
            course !== undefined && course.level === level && course.day === utcDay(this.now());
        return current ? undefined : level;
    }

    /** Takes the hole the lobby needs, if it still does. Whether the race changed. */
    setHole(course: Course): boolean {
        if (this.holeWanted() !== course.level || course.day !== utcDay(this.now())) return false;
        this.data.course = course;
        this.changed();
        return true;
    }

    override cannotStart(): string | undefined {
        const nobody = super.cannotStart();
        if (nobody !== undefined) return nobody;
        if (this.data.phase === "open" && this.holeWanted() !== undefined) {
            return "Today's hole is still on its way from the chain. Try again in a moment.";
        }
        return undefined;
    }

    protected begin(seats: readonly Seat[]): Golfer[] {
        const tee = this.data.course!.tee;
        return seats.map((s) => ({ ...s, status: "teeing", strokes: 0, ball: { ...tee } }));
    }

    /** The golfers still waiting for their round on the canister, until the time's up */
    teeing(): Golfer[] {
        const d = this.data;
        if (d.phase !== "active" || (d.endsAt !== undefined && this.now() >= d.endsAt)) return [];
        return d.players.filter((g) => g.status === "teeing" && g.roundId === undefined);
    }

    golfer(userId: string): Golfer | undefined {
        return this.racer(userId);
    }

    /** The golfer's new round on the canister. Whether the race changed. */
    setRound(userId: string, round: NewRound): boolean {
        const golfer = this.racer(userId);
        if (this.data.phase !== "active" || golfer === undefined || golfer.roundId !== undefined) {
            return false;
        }
        golfer.roundId = round.id;
        golfer.key = round.key;
        this.#fromRound(golfer, round);
        return true;
    }

    /** Why the golfer can't shoot now, or undefined as their shot goes to the canister */
    beginShot(userId: string): string | undefined {
        const golfer = this.racer(userId);
        if (this.data.phase === "open") return "The race hasn't started";
        if (this.data.phase === "finished") return "The race is over";
        if (golfer === undefined) return "You're not in this race";
        if (golfer.status === "holed") return "You've holed it";
        if (golfer.status === "gave_up") return "You're out of shots";
        const now = this.now();
        if (golfer.shotSince !== undefined && now - golfer.shotSince < SHOT_LOST_MS) {
            return "Your last shot is still in the air";
        }
        if (this.data.endsAt !== undefined && now >= this.data.endsAt) return "Time's up";
        golfer.shotSince = now;
        return undefined;
    }

    /** The golfer's shot didn't reach the canister, or wasn't played: they can shoot again */
    shotFailed(userId: string): void {
        const golfer = this.racer(userId);
        if (golfer !== undefined) golfer.shotSince = undefined;
    }

    /**
     * The golfer's shot, as the canister played it. Their round is as the canister says, whatever
     * the race had, so a shot lost as the bot restarted is counted all the same. Ends the race once
     * everyone's done. A golfer who holes it is done as they shot, not as the canister answered,
     * which can take seconds longer for one than another. The golfer's view, or undefined if the
     * race was over before the shot came back.
     */
    recordShot(userId: string, shot: ShotResult): GolferView | undefined {
        const golfer = this.racer(userId);
        if (golfer === undefined) return undefined;
        const shotAt = golfer.shotSince;
        golfer.shotSince = undefined;
        if (this.data.phase !== "active") return undefined;
        golfer.last = {
            shot: shot.round.shots.length,
            path: thin(shot.frames),
            frames: shot.frames.length,
        };
        this.#fromRound(golfer, shot.round, shotAt);
        return view(golfer);
    }

    /**
     * The golfer's round as the canister has it, after it refused their shot: a shot whose answer
     * was lost, eg. as the bot restarted, may have ended the round. Whether the race changed.
     */
    syncRound(userId: string, round: Round): boolean {
        const golfer = this.racer(userId);
        if (this.data.phase !== "active" || golfer === undefined || golfer.roundId !== round.id) {
            return false;
        }
        if (golfer.status === round.status && golfer.strokes === round.strokes) return false;
        this.#fromRound(golfer, round);
        return true;
    }

    /**
     * Takes the golfer's round as the canister has it, after a shot at `shotAt` if it's known, and
     * ends the race once everyone's done
     */
    #fromRound(golfer: Golfer, round: Round, shotAt?: number) {
        const now = this.now();
        golfer.status = round.status;
        golfer.strokes = round.strokes;
        golfer.ball = { ...round.ball };
        if (round.status !== "playing" && golfer.doneAt === undefined) {
            const startedAt = this.data.startedAt ?? now;
            golfer.doneAt = Math.max(0, (shotAt ?? now) - startedAt);
        }
        this.changed();
        if (this.data.players.every((g) => g.status === "holed" || g.status === "gave_up")) {
            this.finish("all_done", this.leader(), now);
        }
    }

    /** Waits past the time for any shot that went to the canister before it, for a while */
    override endIfTimeUp(): boolean {
        const d = this.data;
        if (d.phase !== "active" || d.endsAt === undefined) return false;
        const now = this.now();
        if (now < d.endsAt) return false;
        const endsAt = d.endsAt;
        const inFlight = d.players.some((g) => g.shotSince !== undefined && g.shotSince < endsAt);
        if (inFlight && now < endsAt + SHOT_GRACE_MS) return false;
        this.finish("time", this.leader(), inFlight ? now : endsAt);
        return true;
    }

    /** Shots out as the bot stopped are lost to it: the next shot gets the round as it is */
    override resume(downMs: number): boolean {
        let changed = super.resume(downMs);
        for (const golfer of this.data.players) {
            if (golfer.shotSince !== undefined) {
                golfer.shotSince = undefined;
                changed = true;
            }
        }
        return changed;
    }

    /** The winner: the best of those who've holed it, if anyone has */
    protected leader(): string | undefined {
        const best = this.ranking()[0];
        return best?.status === "holed" ? best.id : undefined;
    }

    /**
     * Best first: those who've holed it, by strokes and then who was first, and then everyone
     * else, by how near the cup their ball lies
     */
    ranking(): Golfer[] {
        const cup = this.data.course?.cup;
        const away = (g: Golfer) => (cup === undefined ? 0 : Math.abs(g.ball.x - cup.x));
        return [...this.data.players].sort((a, b) => {
            const aIn = a.status === "holed" ? 0 : 1;
            const bIn = b.status === "holed" ? 0 : 1;
            if (aIn !== bIn) return aIn - bIn;
            if (aIn === 0) {
                return a.strokes - b.strokes || (a.doneAt ?? 0) - (b.doneAt ?? 0);
            }
            return away(a) - away(b) || a.strokes - b.strokes;
        });
    }

    shared(): GolfShared {
        return {
            version: STATE_VERSION,
            game: GAME_ID,
            ...this.base(),
            course: this.data.course,
            golfers: this.ranking().map(view),
        };
    }

    result(): string | undefined {
        const d = this.data;
        if (d.phase !== "finished") return undefined;
        const course = d.course;
        const hole = course === undefined ? "" : ` · level ${course.level}, par ${course.par}`;
        const winner = d.players.find((g) => g.id === d.winner);
        if (winner === undefined) return `Nobody holed it${hole}`;
        const strokes = winner.strokes === 1 ? "a hole in one" : `${winner.strokes} strokes`;
        return `@UserId(${winner.id}) won with ${strokes}${hole}`;
    }

    /** The final standings and the hole, without the flights, which can't be replayed anyway */
    override endState(): GolfShared | undefined {
        const shared = this.data.phase === "finished" ? this.shared() : undefined;
        if (shared === undefined) return undefined;
        return { ...shared, golfers: shared.golfers.map(({ last: _, ...g }) => g) };
    }
}

function view(g: Golfer): GolferView {
    return {
        id: g.id,
        name: g.name,
        status: g.status,
        strokes: g.strokes,
        ball: g.ball,
        roundId: g.roundId,
        doneMs: g.doneAt,
        last: g.last,
    };
}

/** A shot's flight, cut down to `PATH_POINTS` points, its end kept, each to the centimetre */
export function thin(frames: [number, number][]): [number, number][] {
    if (frames.length === 0) return [];
    const step = Math.max(1, Math.ceil(frames.length / PATH_POINTS));
    const points: [number, number][] = [];
    for (let i = 0; i < frames.length; i += step) points.push(frames[i]);
    if (points[points.length - 1] !== frames[frames.length - 1]) {
        points.push(frames[frames.length - 1]);
    }
    return points.map(([x, y]) => [round2(x), round2(y)]);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
