// Chain Golf as the bot and its page share it: onicai's hole, as their canister describes it, and
// the race's state, as the page draws it. A golfer's round on the canister has a key, which plays
// its shots; the key stays with the bot, so a player can only shoot through the race.
import type { SettingSpec } from "../settings";

export const GAME_ID = "golf";
export const STATE_VERSION = 1;
export const MAX_PLAYERS = 20;

/** Where onicai's pages are, for a player to check a round on-chain */
export const ONICAI_SITE = "https://play.onicai.com";

export type Point = { x: number; y: number };

/** An obstacle: a plank or a crate, rotated by `angle` radians about its centre */
export type Box = { x: number; y: number; half_w: number; half_h: number; angle: number };

/**
 * A day's hole at a level, as `GET /api/golf/today?level=<n>` gives it, in metres. Every round
 * started that day at that level plays it.
 */
export type Course = {
    /** Days since 1 Jan 1970, UTC: the hole changes at midnight UTC */
    day: number;
    par: number;
    level: number;
    /** Positive blows to the right */
    wind: number;
    cup: { x: number; y: number; half_w: number; depth: number };
    tee: Point;
    ball_radius: number;
    /** The ground's outline, left to right */
    ground: [number, number][];
    boxes: Box[];
};

/** How a shot ended: at rest on the course, in the cup, or off it, which costs a stroke */
export type ShotHow = "rest" | "holed" | "out";

/** A golfer's round, as the canister has it */
export type RoundStatus = "playing" | "holed" | "gave_up";

/**
 * Where a golfer is in the race: waiting for their round on the canister, playing it, in the cup,
 * or out of shots
 */
export type GolferStatus = "teeing" | RoundStatus;

/** A golfer as everyone sees them */
export type GolferView = {
    id: string;
    name: string;
    status: GolferStatus;
    strokes: number;
    /** Where their ball lies */
    ball: Point;
    /** Their round on the canister, which anyone can check there */
    roundId?: number;
    /** When they holed it or ran out of shots, ms since the race started */
    doneMs?: number;
    /**
     * Their latest shot's flight, so everyone's page can show it: `shot` counts their shots, and
     * `frames` is how many the canister's flight had, as `path` is cut down, so it plays as long
     */
    last?: { shot: number; path: [number, number][]; frames: number };
};

/** How a race can end before the time's up: everyone has holed it or run out of shots */
export type GolfEnded = "all_done";

/** The race as everyone sees it, which the page draws */
export type GolfShared = {
    version: typeof STATE_VERSION;
    game: typeof GAME_ID;
    phase: "open" | "active" | "finished";
    settings: Record<string, number>;
    host?: string;
    hostName?: string;
    seats: { id: string; name: string }[];
    startedAt?: number;
    endsAt?: number;
    finishedAt?: number;
    ended?: GolfEnded | "time";
    winner?: string;
    /** The hole, once the bot has it from the canister: before the start, for the settings' level */
    course?: Course;
    /** Everyone racing, best first */
    golfers: GolferView[];
};

/** A shot, as the page asks for it: the same ranges as onicai's own page */
export type ShotRequest = { angle: number; power: number };

/** The bot's answer to a shot: its whole flight, at the canister's frame rate, and the golfer */
export type ShotResponse =
    | { ok: true; frames: [number, number][]; golfer: GolferView }
    | { ok: false; error: string };

export const MIN_ANGLE = 0;
export const MAX_ANGLE = 180;
export const MIN_POWER = 1;
export const MAX_POWER = 100;

/** onicai's levels, 1 to 20, as their own page describes them */
export function levelLabel(n: number): string {
    const what =
        n <= 4
            ? "wide cup, full aim guide"
            : n <= 9
              ? "wider cup, short aim guide"
              : n <= 12
                ? "more obstacles"
                : n <= 15
                  ? "tighter cup, light headwind"
                  : "tight cup, strong headwind";
    return `Level ${n} · ${what}`;
}

const LEVELS = [1, 5, 10, 13, 16, 20];

export const GOLF_SETTINGS: readonly SettingSpec[] = [
    {
        id: "level",
        label: "Level",
        choices: LEVELS.map((n) => ({ value: n, label: levelLabel(n) })),
        default: 10,
    },
    {
        id: "minutes",
        label: "Time limit",
        choices: [3, 5, 10, 15].map((m) => ({ value: m, label: `${m} minutes` })),
        default: 5,
    },
];

/** Today, as the canister numbers its days */
export function utcDay(now: number): number {
    return Math.floor(now / 86_400_000);
}
