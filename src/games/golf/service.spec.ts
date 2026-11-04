import { GroupChatIdentifier, type MiniAppServiceClient } from "@open-ic/openchat-botclient-ts";
import { describe, expect, it, vi } from "vitest";
import { OnicaiError, type NewRound, type Onicai } from "../../onicai";
import { Publisher } from "../../publisher";
import { GameStore } from "../../store";
import { GolfRace } from "./race";
import { course } from "../../test/fixtures";
import { GolfService } from "./service";

const NOW = 20_761 * 86_400_000 + 60_000;
const GAME = { chat: new GroupChatIdentifier("g"), thread: undefined, messageId: 1n };

function newRound(id: number): NewRound {
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
    };
}

function setup(onicai: Partial<Onicai>) {
    const store = new GameStore(undefined, () => NOW);
    const update = vi.fn().mockResolvedValue(undefined);
    const client = { update } as unknown as MiniAppServiceClient;
    const publisher = new Publisher(() => client, store, 0);
    const golf = new GolfService(onicai as Onicai, store, publisher, "", () => NOW);
    const race = GolfRace.create(undefined, undefined, { now: () => NOW });
    store.create(GAME, race);
    return { golf, race, update };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GolfService", () => {
    it("fetches a lobby's hole once, and gives it to the race", async () => {
        const golfToday = vi.fn().mockResolvedValue(course());
        const { golf, race } = setup({ golfToday });
        golf.prepare(GAME);
        golf.prepare(GAME);
        await flush();
        expect(golfToday).toHaveBeenCalledTimes(1);
        expect(golfToday).toHaveBeenCalledWith(10);
        expect(race.holeWanted()).toBeUndefined();
    });

    it("waits a while before asking again for a hole it couldn't fetch", async () => {
        const golfToday = vi.fn().mockRejectedValue(new OnicaiError("down"));
        const { golf } = setup({ golfToday });
        golf.prepare(GAME);
        await flush();
        golf.prepare(GAME);
        await flush();
        expect(golfToday).toHaveBeenCalledTimes(1);
    });

    it("starts each golfer's round once the race starts, and plays their shots with its key", async () => {
        const createGolfRound = vi.fn().mockResolvedValue(newRound(9));
        const golfShot = vi.fn().mockResolvedValue({
            frames: [
                [3, 0.2],
                [40, 0.5],
            ],
            round: { ...newRound(9), strokes: 1, status: "holed", ball: { x: 40, y: 0.5 } },
        });
        const { golf, race } = setup({ createGolfRound, golfShot });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        golf.prepare(GAME);
        await flush();
        expect(createGolfRound).toHaveBeenCalledWith("", 10);

        const answer = await golf.shoot(GAME, "alice", 45, 60);
        expect(golfShot).toHaveBeenCalledWith(9, "key-9", 45, 60);
        expect(answer).toMatchObject({ ok: true, golfer: { status: "holed", strokes: 1 } });
        expect(race.phase).toBe("finished");
    });

    it("starts a golfer's round as they shoot, if it isn't yet", async () => {
        const createGolfRound = vi.fn().mockResolvedValue(newRound(3));
        const golfShot = vi.fn().mockResolvedValue({ frames: [], round: newRound(3) });
        const { golf, race } = setup({ createGolfRound, golfShot });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        expect((await golf.shoot(GAME, "alice", 45, 60)).ok).toBe(true);
        expect(golfShot).toHaveBeenCalledWith(3, "key-3", 45, 60);
    });

    it("lets a golfer shoot again when the canister refuses a shot", async () => {
        const golfShot = vi.fn().mockRejectedValueOnce(new OnicaiError("out of fuel", 503));
        const golfRound = vi.fn().mockResolvedValue(newRound(4));
        const { golf, race } = setup({ golfShot, golfRound });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        race.setRound("alice", newRound(4));
        expect(await golf.shoot(GAME, "alice", 45, 60)).toEqual({
            ok: false,
            error: "The chain didn't take the shot: out of fuel",
        });
        expect(golfRound).toHaveBeenCalledWith(4);
        expect(race.golfer("alice")).toMatchObject({ status: "playing", strokes: 0 });
        expect(race.beginShot("alice")).toBeUndefined();
    });

    it("takes the round as the canister has it when it refuses a shot, eg. one an earlier lost shot ended", async () => {
        const golfShot = vi.fn().mockRejectedValue(new OnicaiError("round over", 400));
        const golfRound = vi
            .fn()
            .mockResolvedValue({ ...newRound(4), strokes: 3, status: "holed", ball: { x: 40, y: 0.5 } });
        const { golf, race } = setup({ golfShot, golfRound });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        race.setRound("alice", newRound(4));
        expect((await golf.shoot(GAME, "alice", 45, 60)).ok).toBe(false);
        expect(golfRound).toHaveBeenCalledWith(4);
        expect(race.golfer("alice")).toMatchObject({ status: "holed", strokes: 3 });
        expect(race.phase).toBe("finished");
        expect(race.result()).toMatch(/won with 3 strokes/);
    });

    it("doesn't read the round when the canister couldn't be reached", async () => {
        const golfShot = vi.fn().mockRejectedValue(new OnicaiError("Couldn't reach onicai"));
        const golfRound = vi.fn();
        const { golf, race } = setup({ golfShot, golfRound });
        race.join("alice", "Alice");
        race.setHole(course());
        race.start();
        race.setRound("alice", newRound(4));
        await golf.shoot(GAME, "alice", 45, 60);
        expect(golfRound).not.toHaveBeenCalled();
    });
});
