// The games the bot hosts. Each is a choice in the `/play` command's dropdown, with its card's text
// and limits, and how to make one and read one back from the store. Another of onicai's games adds
// an entry here, its rules under `games/`, its requests under `handlers/api.ts` and its view under
// `app/`.
import type { MiniAppSize } from "@open-ic/openchat-botclient-ts";
import type { Game, GameKind, Host } from "./game";
import { GolfRace, type GolfData } from "./golf/race";
import { GAME_ID as GOLF_ID, GOLF_SETTINGS, MAX_PLAYERS as GOLF_MAX_PLAYERS } from "./golf/types";
import type { SettingSpec, Settings } from "./settings";

/** What a game can be made with, from the bot's config */
export type GameConfig = {
    /** A game's settings unless the host sets them, eg. a short race for a test */
    settings?: Settings;
};

export type GameType = {
    /**
     * The `/play` command's value, the `game` in the shared state, the `kind` in the store and the
     * app's name in the bot's definition, which its card names
     */
    id: GameKind;
    /** What the `/play` dropdown calls it */
    title: string;
    /**
     * The app's image, a path relative to the bot's endpoint, served from `src/app/public`, which
     * OpenChat shows in the card whenever there's no app to show
     */
    image: string;
    /** The card's text, markdown */
    cardText: string;
    maxPlayers: number;
    /** Whether people who aren't playing can watch */
    spectators: boolean;
    /** What the host can set in the lobby, each a choice among a few values with a default */
    settings: readonly SettingSpec[];
    /** The size the page is laid out for, in CSS pixels: the card shows it at this aspect ratio */
    appSize: MiniAppSize;
    /** A new game, as `/play` posts one, with the host, the user who ran it */
    create: (config: GameConfig, host: Host | undefined) => Game;
    /** A game as the store wrote it */
    fromJson: (data: unknown) => Game;
};

export const CHAIN_GOLF: GameType = {
    id: GOLF_ID,
    title: "Chain Golf race",
    image: "app/golf.svg",
    cardText:
        `**Chain Golf race** · up to ${GOLF_MAX_PLAYERS} players on today's hole · ` +
        "every shot simulated by Box2D on-chain, by onicai",
    maxPlayers: GOLF_MAX_PLAYERS,
    spectators: true,
    settings: GOLF_SETTINGS,
    appSize: { width: 440, height: 620 },
    create: (config, host) => GolfRace.create(host, config.settings),
    fromJson: (data) => new GolfRace(data as GolfData),
};

export const GAMES: readonly GameType[] = [CHAIN_GOLF];

export function gameType(id: string | undefined): GameType | undefined {
    return GAMES.find((game) => game.id === id);
}
