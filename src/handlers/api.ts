// A player's requests, from the app, with their player token in `x-oc-jwt`: the host's settings in
// the lobby, and each golfer's shots. The game's own player list is checked on every request: a
// player token outlives a removal by up to an hour.
import {
    MINI_APP_TOKEN_HEADER,
    TokenError,
    type MiniAppGame,
} from "@open-ic/openchat-botclient-ts";
import type { Request, Response } from "express";
import type { Deps } from "../deps";
import type { Game } from "../games/game";
import {
    MAX_ANGLE,
    MAX_POWER,
    MIN_ANGLE,
    MIN_POWER,
    type SaveResponse,
    type ShotRequest,
    type ShotResponse,
} from "../games/golf/types";
import { gameType } from "../games/registry";
import { parseSettings } from "../games/settings";

/**
 * The player the request's token names, and the game it's for, or undefined once the answer's
 * been sent: the token isn't good, or the game's over
 */
async function player(
    req: Request,
    res: Response,
    deps: Deps,
): Promise<{ userId: string; game: MiniAppGame; play: Game } | undefined> {
    let userId: string;
    let game;
    try {
        ({ userId, game } = (await deps.tokens()).verifyPlayer(req.headers[MINI_APP_TOKEN_HEADER]));
    } catch (err) {
        if (err instanceof TokenError) {
            res.status(401).json({ ok: false, error: err.message });
        } else {
            console.error("Couldn't verify the player's token:", err);
            res.status(500).json({ ok: false, error: "Couldn't verify the token" });
        }
        return undefined;
    }
    const entry = deps.store.get(game);
    if (entry === undefined) {
        res.status(404).json({ ok: false, error: "This game is over" });
        return undefined;
    }
    return { userId, game, play: entry.play };
}

/** `POST /api/settings`: the host changes settings in the lobby, eg. `{ "level": 13 }` */
export async function settings(req: Request, res: Response, deps: Deps): Promise<void> {
    const p = await player(req, res, deps);
    if (p === undefined) return;
    const { userId, game, play } = p;
    const parsed = parseSettings(gameType(play.kind)?.settings ?? [], req.body);
    if (!parsed.ok) {
        res.status(400).json(parsed);
        return;
    }
    const result = play.configure(userId, parsed.settings);
    if (!result.ok) {
        res.status(403).json(result);
        return;
    }
    deps.store.save();
    deps.publisher.publish(game);
    // A new level needs its hole
    deps.golf.prepare(game);
    res.json({ ok: true, settings: play.settings() });
}

/**
 * `POST /api/go`: a player sets the race off without OpenChat's start, so entries stay open and
 * whoever joins later plays at once, until the time's up or a player closes entries
 */
export async function go(req: Request, res: Response, deps: Deps): Promise<void> {
    const p = await player(req, res, deps);
    if (p === undefined) return;
    const refusal = p.play.setOff?.(p.userId) ?? "This game starts from OpenChat's Start";
    if (refusal !== undefined) {
        res.status(409).json({ ok: false, error: refusal });
        return;
    }
    deps.store.save();
    deps.publisher.publish(p.game);
    // Each golfer's round on the chain, so it's ready by the time they shoot
    deps.golf.prepare(p.game);
    res.json({ ok: true });
}

/**
 * `POST /api/golf/shot`: a golfer's shot, `{ angle, power }`, which the bot plays on the canister,
 * answered with the ball's whole flight once it has, a second or two later
 */
export async function golfShot(req: Request, res: Response, deps: Deps): Promise<void> {
    const p = await player(req, res, deps);
    if (p === undefined) return;
    const shot = parseShot(req.body);
    if (shot === undefined) {
        const error = `A shot is an angle, ${MIN_ANGLE} to ${MAX_ANGLE}, and a power, ${MIN_POWER} to ${MAX_POWER}`;
        res.status(400).json({ ok: false, error } satisfies ShotResponse);
        return;
    }
    const answer = await deps.golf.shoot(p.game, p.userId, shot.angle, shot.power);
    res.status(answer.ok ? 200 : 409).json(answer);
}

/**
 * `POST /api/golf/save`: the page that saves the player's own round to their onicai profile. Only
 * they get it, as it holds their round's key; their OpenChat name never goes to onicai.
 */
export async function golfSave(req: Request, res: Response, deps: Deps): Promise<void> {
    const p = await player(req, res, deps);
    if (p === undefined) return;
    const url = deps.golf.saveUrl(p.game, p.userId);
    if (url === undefined) {
        const error = "Take your first shot, then your round can be saved";
        res.status(409).json({ ok: false, error } satisfies SaveResponse);
        return;
    }
    res.json({ ok: true, url } satisfies SaveResponse);
}

/** The shot, to a tenth of a degree and a tenth of a percent, as onicai's page sends it */
function parseShot(body: unknown): ShotRequest | undefined {
    const { angle, power } = (body ?? {}) as Partial<Record<keyof ShotRequest, unknown>>;
    if (typeof angle !== "number" || typeof power !== "number") return undefined;
    if (!(angle >= MIN_ANGLE && angle <= MAX_ANGLE && power >= MIN_POWER && power <= MAX_POWER)) {
        return undefined;
    }
    return { angle: Math.round(angle * 10) / 10, power: Math.round(power * 10) / 10 };
}
