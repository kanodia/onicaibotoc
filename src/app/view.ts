// What the page needs from each game's view, and what it gives them
import type { MiniAppClient } from "@open-ic/openchat-botclient-ts/mini_app";
import type { SettingSpec } from "../games/settings";

export type Seat = { id: string; name: string };

/** What every state the bot publishes has, whichever game it's for */
export type BaseState = { version: number; game: string };

/** What the page's lobby shows for a game before it starts */
export type Lobby = {
    /** What the game is, as HTML */
    blurb: string;
    seats: Seat[];
    /** The host's settings, which only they can change */
    settings?: {
        specs: readonly SettingSpec[];
        current: Record<string, number>;
        host?: string;
        hostName?: string;
    };
    /** Under the Start button, eg. what starting does */
    hint: string;
};

export type ViewContext = {
    readonly oc: MiniAppClient<unknown, unknown, unknown>;
    /** Shows a message over the page for a few seconds */
    notice(text: string): void;
    /** Draws the page again, eg. after a request changed what it shows */
    render(): void;
};

export interface GameView {
    /** The game's id, as the state's `game` names it */
    readonly id: string;
    readonly title: string;
    /** The version of the state the view reads */
    readonly stateVersion: number;
    attach(root: HTMLElement, ctx: ViewContext): void;
    /** The header's clock, eg. "2:14 left" */
    clock(): string;
    isOpen(state: BaseState): boolean;
    lobby(state: BaseState): Lobby;
    /** Draws the game, eg. the hole, in the lobby's preview */
    renderPreview(part: HTMLElement, state: BaseState): void;
    renderLive(body: HTMLElement, state: BaseState): void;
    /** Draws how the game ended, from the card's end state, or false if it can't read it */
    renderEnd(body: HTMLElement, endState: unknown): boolean;
    /** A button with this `data-action` was clicked */
    onAction(action: string, button: HTMLElement): void;
}
