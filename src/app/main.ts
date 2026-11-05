// The bot's page, which OpenChat shows in a game's card, in a frame at the size the card declares
// (`appSize` in the registry), or full screen. It connects to OpenChat with the SDK's browser
// client and shows whichever game the card is for, by the `game` in the shared state, or in the end
// state once the game's over. The lobby before a game starts is the page's own, the same for every
// game, with the game's own blurb and preview. Adapted from OpenChat's MiniGameBot.
import { connectToOpenChat, type MiniAppClient } from "@open-ic/openchat-botclient-ts/mini_app";
import { escape } from "./format";
import { golfView } from "./golf/view";
import type { BaseState, GameView, Lobby, Seat, ViewContext } from "./view";

const VIEWS: readonly GameView[] = [golfView];

const root = document.getElementById("app") as HTMLElement;

const SPINNER = `<div class="loading" role="status"><span class="spinner"></span><span class="visually-hidden">Loading the game…</span></div>`;

let oc: MiniAppClient<unknown, unknown, unknown> | undefined;
/** The game's view, once the page knows which game the card is for */
let view: GameView | undefined;
let notice: string | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let starting = false;

const ctx: ViewContext = {
    get oc() {
        return oc!;
    },
    notice: showNotice,
    render,
};

async function main() {
    try {
        oc = await connectToOpenChat();
    } catch (err) {
        root.innerHTML = `<p class="notice">Open this game from its card in OpenChat.<br><small>${escape(
            String(err),
        )}</small></p>`;
        return;
    }
    applyTheme(oc.darkMode);
    oc.onDarkModeChange(applyTheme);
    oc.onStateChange(render);
    oc.onRoleChange(render);
    oc.onEndState(render);

    // The host's settings form in the lobby
    root.addEventListener("change", (event) => {
        const select = event.target as HTMLSelectElement;
        if (select.dataset.setting === undefined) return;
        void configure(select.dataset.setting, Number(select.value));
    });
    root.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
        if (button === null) return;
        const action = button.dataset.action!;
        switch (action) {
            case "start":
                void start();
                break;
            case "reload":
                location.reload();
                break;
            default:
                view?.onAction(action, button);
        }
    });
    // The clock
    setInterval(() => {
        byId("clock").textContent = view?.clock() ?? "";
    }, 1000);

    render();
}

/** The state's `version` and `game`, if it has them */
function base(state: unknown): BaseState | undefined {
    if (state === null || typeof state !== "object") return undefined;
    const s = state as Record<string, unknown>;
    return typeof s.version === "number" && typeof s.game === "string"
        ? (s as unknown as BaseState)
        : undefined;
}

/** The view for the game named in the state, attached the first time it's known */
function viewFor(state: BaseState | undefined): GameView | undefined {
    if (view !== undefined || state === undefined) return view;
    view = VIEWS.find((v) => v.id === state.game);
    if (view !== undefined) {
        view.attach(root, ctx);
        document.title = view.title;
    }
    return view;
}

async function start() {
    if (oc === undefined || oc.role !== "player" || oc.finished || starting) return;
    starting = true;
    render();
    try {
        const { accepted, message } = await oc.start();
        if (!accepted) showNotice(message ?? "The game couldn't start");
    } catch (err) {
        showNotice(String(err));
    }
    starting = false;
    render();
}

/** The host's change to a setting, which comes back to everyone in the next state */
async function configure(id: string, value: number) {
    if (oc === undefined || oc.role !== "player") return;
    try {
        const response = await oc.fetch("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [id]: value }),
        });
        const result = (await response.json()) as { ok: boolean; error?: string };
        if (!result.ok) {
            undoSetting(id, value);
            showNotice(result.error ?? "The setting wasn't changed");
        }
    } catch {
        undoSetting(id, value);
        showNotice("Couldn't reach the game");
    }
}

/** Puts a setting's dropdown back to what the game has, unless the host has picked again since */
function undoSetting(id: string, value: number) {
    const select = document.querySelector<HTMLSelectElement>(`select[data-setting="${id}"]`);
    if (select === null || select.value !== String(value)) return;
    for (const option of Array.from(select.options)) option.selected = option.defaultSelected;
}

function showNotice(text: string) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        notice = undefined;
        render();
    }, 4000);
    render();
}

function applyTheme(dark: boolean) {
    const theme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    // So a reload starts in the theme as it is
    try {
        history.replaceState(history.state, "", `#oc_theme=${theme}`);
    } catch {
        // eg. too many changes too quickly
    }
}

function byId(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
}

function render() {
    if (oc === undefined) return;
    const toast = byId("toast");
    toast.hidden = notice === undefined;
    toast.textContent = notice ?? "";
    const body = byId("body");

    const endState = oc.endState;
    const state = oc.state;
    const live = base(state?.shared);
    const current = viewFor(base(endState) ?? live);
    byId("title").textContent = current?.title ?? "Game";
    byId("clock").textContent = current?.clock() ?? "";
    let loading = false;

    if (endState !== undefined) {
        if (current === undefined || !current.renderEnd(body, endState)) {
            body.innerHTML = `<p class="notice">The game is over.</p>`;
        }
    } else if (oc.finished || state === undefined) {
        // Opened on a finished card, whose end state follows, or nothing from the bot yet
        loading = true;
    } else if (live === undefined || current === undefined || live.version > current.stateVersion) {
        body.innerHTML = `<p class="notice">This game needs a newer page.</p>
            <p class="center"><button class="primary" data-action="reload">Reload</button></p>`;
    } else if (live.version < current.stateVersion) {
        // From an older bot, which is about to publish the game afresh
        loading = true;
    } else if (current.isOpen(live)) {
        renderLobby(body, current, live);
    } else {
        current.renderLive(body, live);
    }

    byId("top").hidden = loading;
    if (loading && body.querySelector(":scope > .loading") === null) body.innerHTML = SPINNER;
    // OpenChat shows the card's artwork until the page has drawn the game
    if (!loading) oc.drawn();
}

const LOBBY_PARTS = ["preview", "blurb", "settings", "seats", "action"] as const;

/** A setting's dropdown, with its label, in the host's form */
type Field = { id: string; html: string };

/** What each part of the lobby last drew */
const drawn = new WeakMap<Element, string>();

/**
 * The lobby: the game's preview, who's joined, the host's settings, and the Start button for a
 * player. It's drawn in parts, and a part is only replaced when what it shows has changed, as
 * replacing a dropdown closes it.
 */
function renderLobby(body: HTMLElement, current: GameView, state: BaseState) {
    let section = body.querySelector<HTMLElement>(":scope > section.lobby");
    if (section === null) {
        body.innerHTML = `<section class="lobby">
            ${LOBBY_PARTS.map((name) => `<div class="part" data-part="${name}"></div>`).join("")}
        </section>`;
        section = body.querySelector<HTMLElement>(":scope > section.lobby")!;
    }
    current.renderPreview(section.querySelector<HTMLElement>('[data-part="preview"]')!, state);
    const parts = lobbyParts(current.lobby(state));
    for (const name of LOBBY_PARTS) {
        if (name === "preview") continue;
        const part = section.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
        const content = parts[name];
        if (typeof content === "string") {
            draw(part, content);
        } else {
            draw(
                part,
                `<div class="settings">${content.map((f) => `<label data-field="${f.id}"></label>`).join("")}</div>`,
            );
            for (const field of content) {
                draw(part.querySelector(`[data-field="${field.id}"]`)!, field.html);
            }
        }
    }
}

function draw(part: Element, html: string) {
    if (drawn.get(part) !== html) {
        drawn.set(part, html);
        part.innerHTML = html;
    }
}

function lobbyParts(info: Lobby): Record<Exclude<(typeof LOBBY_PARTS)[number], "preview">, string | Field[]> {
    const player = oc?.role === "player";
    const seats = info.seats;
    return {
        blurb: `<p class="muted">${info.blurb}</p>`,
        settings: info.settings === undefined ? "" : settingsForm(info.settings, seats, player),
        seats:
            seats.length === 0
                ? `<p class="muted">Nobody has joined yet.</p>`
                : `<ul class="seats">${seats
                      .map((s) => `<li>${escape(s.name)}${s.id === oc?.userId ? " <em>(you)</em>" : ""}</li>`)
                      .join("")}</ul>`,
        // Only OpenChat's Join button, under the card, can join someone, so the lobby points to it
        action: player
            ? `<p class="center"><button class="primary" data-action="start" ${starting ? "disabled" : ""}>
               ${starting ? "Starting…" : "Start the race"}</button></p>
           <p class="muted center small">${info.hint} Waiting for friends? They tap <b>Join</b> under this card.</p>`
            : `<p class="join-here">👇 Tap <b>Join</b> under this card to play</p>
           <p class="muted center small">Up to ${info.maxPlayers} can race. Once you've joined, the host starts it.</p>`,
    };
}

/** The host's form for the game's settings; everyone else sees who can change them */
function settingsForm(
    settings: NonNullable<Lobby["settings"]>,
    seats: Seat[],
    player: boolean,
): string | Field[] {
    const { specs, current, host, hostName } = settings;
    if (host === undefined || host !== oc?.userId || !player) {
        const seat = seats.find((s) => s.id === host);
        const name = seat?.name ?? hostName;
        const once = host !== undefined && seat === undefined ? " once they've joined" : "";
        const values = specs
            .map((spec) => spec.choices.find((c) => c.value === current[spec.id])?.label ?? "")
            .filter((label) => label !== "")
            .map(escape)
            .join(" · ");
        return `<p class="small">${values}</p><p class="muted small">${name === undefined ? "The host" : escape(name)} can change these${once}.</p>`;
    }
    return specs.map((spec) => {
        const value = current[spec.id] ?? spec.default;
        const choices = spec.choices.some((c) => c.value === value)
            ? spec.choices
            : [{ value, label: String(value) }, ...spec.choices];
        const options = choices
            .map((c) => `<option value="${c.value}" ${c.value === value ? "selected" : ""}>${escape(c.label)}</option>`)
            .join("");
        return {
            id: spec.id,
            html: `<span>${escape(spec.label)}</span><select data-setting="${spec.id}">${options}</select>`,
        };
    });
}

void main();
