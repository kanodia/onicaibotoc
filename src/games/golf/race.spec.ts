import { describe, expect, it } from "vitest";
import type { NewRound, Round, ShotResult } from "../../onicai";
import { GolfRace, SHOT_GRACE_MS, SHOT_LOST_MS, thin } from "./race";
import { course } from "../../test/fixtures";

const DAY_MS = 86_400_000;
const START = 20_761 * DAY_MS + 10 * 60_000;

function round(id: number, over: Partial<Round> = {}): NewRound {
    return {
        id,
        key: `key-${id}`,
        day: 20_761,
        level: 10,
        name: "",
        strokes: 0,
        status: "playing",
        ball: { x: 3, y: 0.2 },
        shots: [],
        ...over,
    };
}

function shot(r: NewRound, strokes: number, status: Round["status"], x: number): ShotResult {
    const shots = Array.from({ length: strokes }, () => ({
        angle: 45,
        power: 50,
        end: { x, y: 0.5 },
        how: status === "holed" ? ("holed" as const) : ("rest" as const),
        instructions: 1,
    }));
    return {
        frames: [
            [3, 0.2],
            [x, 0.5],
        ],
        round: { ...r, strokes, status, ball: { x, y: 0.5 }, shots },
    };
}

/** A race with alice and bob in it, started on today's level 10 hole */
function started() {
    let now = START;
    const race = GolfRace.create({ id: "alice", name: "Alice" }, undefined, { now: () => now });
    race.join("alice", "Alice");
    race.join("bob", "Bob");
    race.setHole(course());
    race.start();
    race.setRound("alice", round(1));
    race.setRound("bob", round(2));
    return { race, advance: (ms: number) => (now += ms) };
}

describe("the lobby", () => {
    it("wants today's hole at the settings' level before it can start", () => {
        const race = GolfRace.create(undefined, undefined, { now: () => START });
        race.join("alice", "Alice");
        expect(race.holeWanted()).toBe(10);
        expect(race.cannotStart()).toMatch(/on its way/);
        expect(race.setHole(course(13))).toBe(false);
        expect(race.setHole(course(10, 20_760))).toBe(false);
        expect(race.setHole(course(10))).toBe(true);
        expect(race.holeWanted()).toBeUndefined();
        expect(race.cannotStart()).toBeUndefined();
    });

    it("wants another hole when the host changes the level", () => {
        const race = GolfRace.create({ id: "alice", name: "Alice" }, undefined, {
            now: () => START,
        });
        race.setHole(course(10));
        expect(race.configure("bob", { level: 13 }).ok).toBe(false);
        expect(race.configure("alice", { level: 13 }).ok).toBe(true);
        expect(race.holeWanted()).toBe(13);
    });

    it("wants the new day's hole after midnight", () => {
        let now = START;
        const race = GolfRace.create(undefined, undefined, { now: () => now });
        race.setHole(course());
        now += DAY_MS;
        expect(race.holeWanted()).toBe(10);
    });
});

describe("the race", () => {
    it("starts everyone at the tee, waiting for their rounds", () => {
        const race = GolfRace.create(undefined, undefined, { now: () => START });
        race.join("alice", "Alice");
        race.setHole(course());
        expect(race.start()).toEqual(["alice"]);
        expect(race.teeing().map((g) => g.id)).toEqual(["alice"]);
        expect(race.shared().golfers[0]).toMatchObject({ status: "teeing", ball: { x: 3 } });
        expect(race.setRound("alice", round(7))).toBe(true);
        expect(race.teeing()).toEqual([]);
        expect(race.shared().golfers[0]).toMatchObject({ status: "playing", roundId: 7 });
    });

    it("never shares a round's key", () => {
        const { race } = started();
        expect(JSON.stringify(race.shared())).not.toContain("key-");
    });

    it("lets a golfer have one shot in the air at a time", () => {
        const { race, advance } = started();
        expect(race.beginShot("alice")).toBeUndefined();
        expect(race.beginShot("alice")).toMatch(/still in the air/);
        expect(race.beginShot("carol")).toMatch(/not in this race/);
        advance(SHOT_LOST_MS);
        expect(race.beginShot("alice")).toBeUndefined();
        race.shotFailed("alice");
        expect(race.beginShot("alice")).toBeUndefined();
    });

    it("takes each round as the canister has it, and ends once everyone's done", () => {
        const { race, advance } = started();
        advance(1000);
        race.beginShot("alice");
        advance(2000);
        const alice = race.recordShot("alice", shot(round(1), 2, "holed", 40));
        // Done as she shot, not as the canister answered
        expect(alice).toMatchObject({ status: "holed", strokes: 2, doneMs: 1000 });
        expect(alice?.last).toMatchObject({ shot: 2, frames: 2 });
        expect(race.phase).toBe("active");

        race.beginShot("bob");
        race.recordShot("bob", shot(round(2), 3, "holed", 40));
        expect(race.phase).toBe("finished");
        expect(race.shared()).toMatchObject({ ended: "all_done", winner: "alice" });
        expect(race.result()).toBe("@UserId(alice) won with 2 strokes · level 10, par 4");
    });

    it("breaks a tie by who holed it first", () => {
        const { race, advance } = started();
        race.recordShot("bob", shot(round(2), 2, "holed", 40));
        advance(1000);
        race.recordShot("alice", shot(round(1), 2, "holed", 40));
        expect(race.shared().winner).toBe("bob");
    });

    it("breaks a tie by who shot first, though the other's answer came back first", () => {
        const { race, advance } = started();
        race.beginShot("alice");
        advance(500);
        race.beginShot("bob");
        advance(1000);
        race.recordShot("bob", shot(round(2), 2, "holed", 40));
        advance(1500);
        race.recordShot("alice", shot(round(1), 2, "holed", 40));
        expect(race.shared().winner).toBe("alice");
    });

    it("starts no rounds once the time's up", () => {
        let now = START;
        const race = GolfRace.create(undefined, undefined, { now: () => now });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        expect(race.teeing().map((g) => g.id)).toEqual(["alice"]);
        now += 5 * 60_000;
        expect(race.teeing()).toEqual([]);
    });

    it("ranks those who haven't holed it by how near the cup they are", () => {
        const { race } = started();
        race.recordShot("alice", shot(round(1), 1, "playing", 20));
        race.recordShot("bob", shot(round(2), 1, "playing", 35));
        expect(race.shared().golfers.map((g) => g.id)).toEqual(["bob", "alice"]);
    });

    it("waits past the time for a shot that went before it, but not for ever", () => {
        const { race, advance } = started();
        advance(5 * 60_000 - 1000);
        race.beginShot("alice");
        advance(1000);
        expect(race.endIfTimeUp()).toBe(false);
        expect(race.beginShot("bob")).toMatch(/Time's up/);
        advance(SHOT_GRACE_MS);
        expect(race.endIfTimeUp()).toBe(true);
        expect(race.result()).toBe("Nobody holed it · level 10, par 4");
        expect(race.recordShot("alice", shot(round(1), 1, "holed", 40))).toBeUndefined();
    });

    it("ends on time when no shot's in the air, won by whoever's holed it", () => {
        const { race, advance } = started();
        race.recordShot("bob", shot(round(2), 4, "holed", 40));
        advance(5 * 60_000);
        expect(race.endIfTimeUp()).toBe(true);
        expect(race.shared()).toMatchObject({ ended: "time", winner: "bob" });
    });

    it("forgets shots in the air when the bot was down", () => {
        const { race } = started();
        race.beginShot("alice");
        expect(race.resume(10_000)).toBe(true);
        expect(race.beginShot("alice")).toBeUndefined();
    });

    it("ends with the standings, without the flights", () => {
        const { race } = started();
        race.recordShot("alice", shot(round(1), 1, "holed", 40));
        race.recordShot("bob", shot(round(2), 5, "gave_up", 30));
        const end = race.endState()!;
        expect(end.golfers.map((g) => [g.id, g.status])).toEqual([
            ["alice", "holed"],
            ["bob", "gave_up"],
        ]);
        expect(end.golfers.some((g) => g.last !== undefined)).toBe(false);
        expect(end.course?.level).toBe(10);
    });
});

describe("thin", () => {
    it("keeps at most 61 points, the last included, to the centimetre", () => {
        const frames = Array.from({ length: 300 }, (_, i) => [i / 3, i / 7] as [number, number]);
        const path = thin(frames);
        expect(path.length).toBeLessThanOrEqual(61);
        expect(path[0]).toEqual([0, 0]);
        expect(path[path.length - 1]).toEqual([99.67, 42.71]);
    });
});
