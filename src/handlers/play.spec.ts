// `/play`, with OpenChat and the MiniApp service stubbed: who's on the card, and how it answers
import {
    GroupChatIdentifier,
    MiniAppMessage,
    MiniAppServiceError,
    type MiniAppSize,
} from "@open-ic/openchat-botclient-ts";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { Deps } from "../deps";
import type { GolfShared } from "../games/golf/types";
import { CHAIN_GOLF } from "../games/registry";
import { GameStore } from "../store";
import { executeCommand } from "./play";

const GROUP = "aaaaa-aa";
const MESSAGE_ID = 7n;
const GAME = { chat: new GroupChatIdentifier(GROUP), messageId: MESSAGE_ID };

/** A post token for the command's message, which the bot only reads */
function postToken(): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
        claim_type: "MiniAppPost",
        game: { chat: { Group: GROUP }, message_id: MESSAGE_ID.toString() },
    };
    return `${part({ alg: "none" })}.${part(claims)}.`;
}

/** `/play` Chain Golf in a group, from alice, or from no one, as for a card posted autonomously */
function setUp(post: () => Promise<unknown>, from: string | null = "alice") {
    const initiator = from ?? undefined;
    const store = new GameStore();
    const options: unknown[] = [];
    const client = {
        commandName: "play",
        stringArg: (name: string) => (name === "game" ? CHAIN_GOLF.id : undefined),
        chatScope: { toString: () => `group ${GROUP}` },
        apiGateway: "gateway",
        initiator,
        createMiniAppMessage: async (app: string, text: string, size: MiniAppSize) =>
            new MiniAppMessage(app, text, size).setContextMessageId<MiniAppMessage>(MESSAGE_ID),
        miniAppPostToken: async () => postToken(),
        createTextMessage: async (text: string) => ({
            makeEphemeral: () => ({
                setFinalised: () => ({ toResponse: () => ({ ephemeral: true, text }) }),
            }),
        }),
    };
    const deps = {
        factory: { createClientFromCommandJwt: () => client },
        store,
        publisher: { publish: vi.fn() },
        golf: { prepare: vi.fn() },
        names: { lookup: async (id: string) => id.toUpperCase() },
        useApiGateway: () => ({
            post: async (_token: string, _card: MiniAppMessage, opts: unknown) => {
                options.push(opts);
                return post();
            },
        }),
        gameConfig: {},
    } as unknown as Deps;
    return { store, options, deps };
}

/** The command's answers, of which there should be one */
async function run(deps: Deps): Promise<unknown[]> {
    const answers: unknown[] = [];
    const res = {
        headersSent: false,
        status: () => res,
        json(body: unknown) {
            answers.push(body);
            return res;
        },
    } as unknown as Response;
    await executeCommand({ headers: { "x-oc-jwt": "jwt" } } as unknown as Request, res, deps);
    return answers;
}

describe("/play", () => {
    it("has the host playing from the start, and asks the service to put them on the card", async () => {
        const { store, options, deps } = setUp(async () => undefined);

        await run(deps);

        const play = store.get(GAME)!.play;
        expect(play.isSeated("alice")).toBe(true);
        expect(play.shared()).toMatchObject({
            host: "alice",
            seats: [{ id: "alice", name: "ALICE" }],
        });
        expect(options).toEqual([{ joinInitiator: true }]);
    });

    it("asks for no one on the card when there's no one who ran the command", async () => {
        const { store, options, deps } = setUp(async () => undefined, null);

        await run(deps);

        expect((store.get(GAME)!.play.shared() as GolfShared).seats).toEqual([]);
        expect(options).toEqual([{ joinInitiator: false }]);
    });

    it("forgets the game if the card couldn't be posted", async () => {
        const { store, deps } = setUp(async () => {
            throw new MiniAppServiceError("invalid", 400, "The chat is frozen");
        });

        const answers = await run(deps);

        expect(store.get(GAME)).toBeUndefined();
        expect(answers).toMatchObject([{ message: { ephemeral: true } }]);
    });
});
