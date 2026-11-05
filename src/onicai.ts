// onicai's games canister, through the HTTP API its own pages use (https://play.onicai.com/api/..).
// The bodies are plain text, a field per line, and the answers JSON, with `error` when refused.
// A new round and a shot are update calls on the canister, so a second or two each on mainnet.
// Each answer is checked before it's used, as what it holds goes into every player's page.
import type { Course, Point, RoundStatus, ShotHow } from "./games/golf/types";

export type RoundShot = {
    angle: number;
    power: number;
    end: Point;
    how: ShotHow;
    instructions: number;
};

/** A golf round, as the canister has it */
export type Round = {
    id: number;
    day: number;
    level: number;
    name: string;
    strokes: number;
    status: RoundStatus;
    ball: Point;
    shots: RoundShot[];
};

/** A new round, with the key that plays its shots */
export type NewRound = Round & { key: string };

/** A shot: the ball's flight, a point every other physics step, and the round after it */
export type ShotResult = { frames: [number, number][]; round: Round };

export class OnicaiError extends Error {
    constructor(
        message: string,
        /** The HTTP status, or undefined when the canister couldn't be reached */
        readonly status?: number,
    ) {
        super(message);
        this.name = "OnicaiError";
    }
}

const TIMEOUT_MS = 20_000;

export class Onicai {
    constructor(
        private readonly baseUrl: string,
        private readonly fetchFn: typeof fetch = fetch,
        private readonly timeoutMs = TIMEOUT_MS,
    ) {}

    /** Today's hole at a level, 1 to 20 */
    async golfToday(level: number): Promise<Course> {
        const answer = await this.#call<{ course: Course }>("GET", `/api/golf/today?level=${level}`);
        return checked(answer.course, isCourse(answer.course));
    }

    /**
     * Starts a round of today's hole at a level. `name` is what onicai's leaderboard shows for it,
     * or "anon" if it's empty.
     */
    async createGolfRound(name: string, level: number): Promise<NewRound> {
        const round = await this.#call<NewRound>("POST", "/api/golf/round", `${oneLine(name)}\n${level}`);
        return checked(round, isRound(round) && typeof round.key === "string");
    }

    /** Plays a round's next shot, which the canister simulates with Box2D */
    async golfShot(roundId: number, key: string, angle: number, power: number): Promise<ShotResult> {
        const shot = await this.#call<ShotResult>(
            "POST",
            `/api/golf/round/${roundId}/shot`,
            `${key}\n${angle}\n${power}`,
        );
        return checked(shot, isFrames(shot.frames) && isRound(shot.round));
    }

    /** A round as it stands, as anyone can see it, without its key */
    async golfRound(roundId: number): Promise<Round> {
        const answer = await this.#call<{ round: Round }>("GET", `/api/golf/round/${roundId}`);
        return checked(answer.round, isRound(answer.round));
    }

    /**
     * Posts a finished race to onicai's feed, as one post: each round with its key, which proves
     * the bot played it. The post names only the golfers who saved their round to an onicai
     * profile with a username, as the bot never sends anyone's OpenChat name. Posting the same race
     * again gives the same post.
     */
    async postRace(rounds: readonly { id: number; key: string }[]): Promise<{ id: number }> {
        const body = rounds.map((r) => `${r.id} ${oneLine(r.key)}`).join("\n");
        const post = await this.#call<{ id: number }>("POST", "/api/feed/race", body);
        return checked(post, isNumber(post.id));
    }

    /**
     * The page that saves a round to the player's onicai profile: it keeps the round's key in the
     * browser, as a round played there, and the profile takes it once they log in. The key is in
     * the fragment, so it never reaches a server.
     */
    saveUrl(roundId: number, key: string): string {
        return `${this.baseUrl}/golf/${roundId}#save=${encodeURIComponent(key)}`;
    }

    async #call<T>(method: "GET" | "POST", path: string, body?: string): Promise<T> {
        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseUrl}${path}`, {
                method,
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            throw new OnicaiError(`Couldn't reach onicai: ${String(err)}`);
        }
        const data = (await response.json().catch(() => undefined)) as
            | (T & { error?: string })
            | undefined;
        if (!response.ok || data === undefined) {
            const error = data?.error ?? `HTTP ${response.status}`;
            throw new OnicaiError(error, response.status);
        }
        return data;
    }
}

/** A field can't hold a line break, which would start the next field */
function oneLine(text: string): string {
    return text.replace(/[\r\n]+/g, " ").trim();
}

/** The answer, if it's as the call gives it */
function checked<T>(value: T, ok: boolean): T {
    if (!ok) throw new OnicaiError("onicai's answer wasn't as expected");
    return value;
}

const STATUSES: readonly unknown[] = ["playing", "holed", "gave_up"] satisfies RoundStatus[];

function isNumber(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n);
}

function isPoint(p: unknown): p is Point {
    return typeof p === "object" && p !== null && isNumber((p as Point).x) && isNumber((p as Point).y);
}

function isFrames(frames: unknown): frames is [number, number][] {
    return Array.isArray(frames) && frames.every((f) => Array.isArray(f) && isNumber(f[0]) && isNumber(f[1]));
}

function isRound(r: unknown): r is Round {
    const round = r as Partial<Round> | null | undefined;
    return (
        typeof round === "object" &&
        round !== null &&
        [round.id, round.day, round.level, round.strokes].every(isNumber) &&
        STATUSES.includes(round.status) &&
        isPoint(round.ball) &&
        Array.isArray(round.shots)
    );
}

function isCourse(c: unknown): c is Course {
    const course = c as Partial<Course> | null | undefined;
    return (
        typeof course === "object" &&
        course !== null &&
        [course.day, course.par, course.level, course.wind, course.ball_radius].every(isNumber) &&
        isPoint(course.tee) &&
        isPoint(course.cup) &&
        isNumber(course.cup.half_w) &&
        isNumber(course.cup.depth) &&
        isFrames(course.ground) &&
        Array.isArray(course.boxes)
    );
}
