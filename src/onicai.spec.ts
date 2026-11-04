import { describe, expect, it, vi } from "vitest";
import { Onicai, OnicaiError, type Round } from "./onicai";
import { course } from "./test/fixtures";

function answering(status: number, body: unknown) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

const ROUND: Round = {
    id: 5,
    day: 20_761,
    level: 13,
    name: "anon",
    strokes: 0,
    status: "playing",
    ball: { x: 3, y: 0.2 },
    shots: [],
};

describe("Onicai", () => {
    it("starts a round with the name and level, a line each, the name on one line", async () => {
        const fetchFn = answering(200, { ...ROUND, key: "k" });
        await new Onicai("https://play.onicai.com", fetchFn).createGolfRound("Open\nChat ", 13);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe("https://play.onicai.com/api/golf/round");
        expect(init).toMatchObject({ method: "POST", body: "Open Chat\n13" });
    });

    it("plays a shot with the round's key, angle and power", async () => {
        const fetchFn = answering(200, { frames: [[3, 0.2]], round: ROUND });
        await new Onicai("https://x", fetchFn).golfShot(5, "secret", 43.5, 81.5);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe("https://x/api/golf/round/5/shot");
        expect(init.body).toBe("secret\n43.5\n81.5");
    });

    it("fetches today's hole at a level", async () => {
        const fetchFn = answering(200, { course: course(7), leaderboard: {} });
        expect(await new Onicai("https://x", fetchFn).golfToday(7)).toEqual(course(7));
        expect(fetchFn.mock.calls[0][0]).toBe("https://x/api/golf/today?level=7");
    });

    it("reads a round as it stands", async () => {
        const fetchFn = answering(200, { round: ROUND, course: course() });
        expect(await new Onicai("https://x", fetchFn).golfRound(5)).toEqual(ROUND);
        expect(fetchFn.mock.calls[0][0]).toBe("https://x/api/golf/round/5");
    });

    it("throws the canister's error when it refuses", async () => {
        const fetchFn = answering(400, { error: "round over" });
        const call = new Onicai("https://x", fetchFn).golfShot(5, "k", 1, 1);
        await expect(call).rejects.toEqual(new OnicaiError("round over", 400));
    });

    it("throws when the canister can't be reached", async () => {
        const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        await expect(new Onicai("https://x", fetchFn).golfToday(1)).rejects.toBeInstanceOf(
            OnicaiError,
        );
    });

    it("throws when an answer isn't as expected, so nothing in it reaches a page", async () => {
        const onicai = (body: unknown) => new Onicai("https://x", answering(200, body));
        const bad = new OnicaiError("onicai's answer wasn't as expected");
        await expect(onicai({ course: null }).golfToday(1)).rejects.toEqual(bad);
        await expect(onicai({ course: { ...course(), par: "<b>4</b>" } }).golfToday(1)).rejects.toEqual(bad);
        await expect(onicai(ROUND).createGolfRound("", 1)).rejects.toEqual(bad);
        const round = { ...ROUND, status: "won" };
        await expect(onicai({ frames: [], round }).golfShot(5, "k", 1, 1)).rejects.toEqual(bad);
        await expect(onicai({ frames: [[1]], round: ROUND }).golfShot(5, "k", 1, 1)).rejects.toEqual(bad);
    });
});
