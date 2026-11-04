// The Chain Golf race: everyone's ball on today's hole, and for a golfer, their aim and their
// shots, which the bot plays on onicai's canister. A golfer's own shot comes back with the ball's
// whole flight, which the page plays; everyone else's comes in the state, cut down, so the page
// plays it too, for each golfer as their shot lands.
import {
    GAME_ID,
    GOLF_SETTINGS,
    MAX_ANGLE,
    MAX_POWER,
    MIN_ANGLE,
    MIN_POWER,
    ONICAI_SITE,
    STATE_VERSION,
    levelLabel,
    type Course,
    type GolferView,
    type GolfShared,
    type Point,
    type ShotResponse,
} from "../../games/golf/types";
import { escape, minutesSeconds } from "../format";
import type { BaseState, GameView, Lobby, ViewContext } from "../view";
import { drawHole, frame, type Ball } from "./draw";

const COLOURS = [
    "#ff8a65",
    "#4fc3f7",
    "#ffd54f",
    "#ba68c8",
    "#81c784",
    "#f06292",
    "#4db6ac",
    "#9575cd",
    "#e57373",
    "#aed581",
];

/**
 * A flight being played: its points, how long it lasts, when it started, once it has, and where
 * the ball is along it
 */
type Flight = { path: readonly [number, number][]; ms: number; start?: number; at: [number, number] };

/** How many of the canister's frames a flight plays a second, whatever the screen's refresh rate */
const FLIGHT_FPS = 60;
/** How near their ball, in CSS pixels, a player must press to aim, so a swipe over the card can't shoot */
const GRAB_PX = 40;
/** How far to pull back from the ball for full power, as a share of the canvas's width */
const FULL_PULL = 0.3;

let ctx: ViewContext;
let shared: GolfShared | undefined;
/** The player's golfer from their latest shot's answer, until the state catches up with it */
let answered: GolferView | undefined;
/** Renders again as the time's up, which takes the controls away */
let timeUpTimer: ReturnType<typeof setTimeout> | undefined;
/** The latest shot each golfer's had played, so each is played once */
const seen = new Map<string, number>();
const flights = new Map<string, Flight>();
/** The player's own last flight, drawn behind their ball */
let trail: [number, number][] = [];
let angle = 45;
let power = 60;
/** The player's shot is out, at the canister */
let shooting = false;
let aiming: { x: number; y: number; dragged: boolean } | undefined;
let animating = false;
let canvas: HTMLCanvasElement | undefined;
/** The hole and balls the canvas shows, when it isn't the live race's, eg. the lobby's preview */
let still: { course: Course; golfers: GolferView[] } | undefined;

function me(): string | undefined {
    return ctx.oc.role === "player" ? ctx.oc.userId : undefined;
}

function myGolfer(): GolferView | undefined {
    const id = me();
    return shared?.golfers.find((g) => g.id === id);
}

function canShoot(): boolean {
    const g = myGolfer();
    return (
        shared?.phase === "active" &&
        g !== undefined &&
        (g.status === "playing" || g.status === "teeing") &&
        !shooting &&
        (shared.endsAt === undefined || Date.now() < shared.endsAt)
    );
}

/** Each golfer's colour, by their place among everyone's ids, so it's the same on every page */
function colours(golfers: readonly GolferView[]): Map<string, string> {
    const ids = golfers.map((g) => g.id).sort();
    return new Map(ids.map((id, i) => [id, COLOURS[i % COLOURS.length]]));
}

function read(state: BaseState): GolfShared {
    return state as unknown as GolfShared;
}

export const golfView: GameView = {
    id: GAME_ID,
    title: "Chain Golf race",
    stateVersion: STATE_VERSION,

    attach(_root, context) {
        ctx = context;
        window.addEventListener("resize", () => draw());
    },

    clock() {
        if (shared === undefined) return "";
        if (shared.phase === "finished") return "Finished";
        if (shared.phase === "active" && shared.endsAt !== undefined) {
            return `${minutesSeconds(shared.endsAt - Date.now())} left`;
        }
        return "";
    },

    isOpen(state) {
        return read(state).phase === "open";
    },

    lobby(state): Lobby {
        const s = read(state);
        const course = s.course;
        const hole =
            course === undefined
                ? "Fetching today's hole from the chain…"
                : `Today's hole, ${escape(levelLabel(course.level).toLowerCase())}, par ${course.par}.`;
        return {
            blurb:
                `Everyone plays the same hole, each with their own round inside onicai's canister, ` +
                `which simulates every shot with Box2D, so nobody can fake a score. Fewest strokes ` +
                `wins; holing it first breaks a tie. ${hole}`,
            seats: s.seats,
            settings: { specs: GOLF_SETTINGS, current: s.settings, host: s.host, hostName: s.hostName },
            hint: "Everyone who's joined tees off at once.",
        };
    },

    renderPreview(part, state) {
        const s = read(state);
        shared = s;
        if (s.course === undefined) {
            part.innerHTML = "";
            canvas = undefined;
            still = undefined;
            return;
        }
        if (part.querySelector("canvas") === null) {
            part.innerHTML = `<canvas class="hole"></canvas>`;
        }
        canvas = part.querySelector("canvas")!;
        still = { course: s.course, golfers: [] };
        draw();
    },

    renderLive(body, state) {
        const s = withAnswer(read(state));
        const first = shared === undefined || shared.phase === "open";
        shared = s;
        still = undefined;
        watchFlights(s.golfers, first);
        let section = body.querySelector<HTMLElement>(":scope > section.golf");
        if (section === null) {
            body.innerHTML = liveSkeleton();
            section = body.querySelector<HTMLElement>(":scope > section.golf")!;
            attachCanvas(section.querySelector("canvas")!);
            attachControls(section);
        }
        update(section);
    },

    renderEnd(body, endState) {
        const s = endState as GolfShared | null;
        if (s === null || typeof s !== "object" || s.game !== GAME_ID || s.course === undefined) {
            return false;
        }
        // The last shot plays out first, on the live hole: `animate` renders again once it lands
        if (flights.size > 0 && canvas !== undefined && body.contains(canvas)) return true;
        shared = s;
        flights.clear();
        trail = [];
        body.innerHTML = `<section class="golf">
            <canvas class="hole"></canvas>
            <p class="hud">${hud(s.course)}</p>
            <p class="status">${escape(finishedText(s))}</p>
            <ol class="standings">${standings(s)}</ol>
            <p class="muted small center">Every shot was simulated on onicai's canister. Tap ↗ to check a round on-chain.</p>
        </section>`;
        canvas = body.querySelector("canvas")!;
        still = { course: s.course, golfers: s.golfers };
        draw();
        return true;
    },

    onAction(action) {
        if (action === "shoot") void shoot();
    },
};

function liveSkeleton(): string {
    return `<section class="golf">
        <canvas class="hole"></canvas>
        <p class="hud" data-part="hud"></p>
        <div class="controls" data-part="controls">
            <label><span>Angle</span><input type="range" data-aim="angle" min="${MIN_ANGLE}" max="${MAX_ANGLE}" step="0.5"><output data-out="angle"></output></label>
            <label><span>Power</span><input type="range" data-aim="power" min="${MIN_POWER}" max="${MAX_POWER}" step="0.5"><output data-out="power"></output></label>
            <button class="primary" data-action="shoot">Shoot</button>
        </div>
        <p class="status" data-part="status"></p>
        <ol class="standings" data-part="standings"></ol>
    </section>`;
}

function update(section: HTMLElement) {
    const s = shared!;
    const part = (name: string) => section.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
    part("hud").innerHTML = s.course === undefined ? "" : hud(s.course, myGolfer());
    const controls = part("controls");
    const golfer = myGolfer();
    const done = golfer?.status === "holed" || golfer?.status === "gave_up";
    controls.hidden = !(s.phase === "active" && golfer !== undefined && !done);
    for (const input of controls.querySelectorAll<HTMLInputElement>("input, button")) {
        input.disabled = !canShoot();
    }
    clearTimeout(timeUpTimer);
    const left = s.phase === "active" && s.endsAt !== undefined ? s.endsAt - Date.now() : 0;
    if (left > 0) timeUpTimer = setTimeout(() => ctx.render(), left);
    syncAim(section);
    part("status").textContent = s.phase === "finished" ? finishedText(s) : statusText();
    const rows = standings(s);
    if (part("standings").innerHTML !== rows) part("standings").innerHTML = rows;
    draw();
}

function hud(course: Course, golfer?: GolferView): string {
    const wind =
        course.wind === 0
            ? ""
            : ` · wind <b>${course.wind < 0 ? "←" : "→"} ${Math.abs(course.wind).toFixed(1)}</b>`;
    const strokes = golfer === undefined ? "" : ` · strokes <b>${golfer.strokes}</b>`;
    return `Level <b>${course.level}</b> · par <b>${course.par}</b>${wind}${strokes}`;
}

function statusText(): string {
    const g = myGolfer();
    if (g === undefined) return "You're watching the race.";
    if (shooting) return "The canister is simulating your shot on 13 nodes…";
    switch (g.status) {
        case "teeing":
            return "Teeing off: your round is starting on the chain. Aim meanwhile.";
        case "holed":
            return g.strokes === 1 ? "Hole in one! The chain saw it." : `In the cup in ${g.strokes}.`;
        case "gave_up":
            return "Out of shots for this round.";
        default:
            return g.strokes === 0
                ? "Drag back from your ball to aim, or use the sliders, then shoot."
                : `Shot ${g.strokes + 1}: you play from where your ball stopped.`;
    }
}

function finishedText(s: GolfShared): string {
    const winner = s.golfers.find((g) => g.id === s.winner);
    if (winner === undefined) return "Nobody holed it.";
    const strokes = winner.strokes === 1 ? "a hole in one" : `${winner.strokes} strokes`;
    return `${winner.name} won with ${strokes}.`;
}

function standings(s: GolfShared): string {
    const colour = colours(s.golfers);
    const cup = s.course?.cup;
    return s.golfers
        .map((g) => {
            const you = g.id === me() ? " <em>(you)</em>" : "";
            const trophy = g.id === s.winner ? " 🏆" : "";
            const away = cup === undefined ? undefined : Math.abs(g.ball.x - cup.x);
            const what =
                g.status === "holed"
                    ? `⛳ in ${g.strokes}`
                    : g.status === "gave_up"
                      ? `out of shots · ${g.strokes}`
                      : g.status === "teeing"
                        ? "teeing off…"
                        : `${g.strokes} stroke${g.strokes === 1 ? "" : "s"}${away === undefined ? "" : ` · ${away.toFixed(1)} m to go`}`;
            const check =
                g.roundId === undefined
                    ? ""
                    : ` <a class="check" href="${ONICAI_SITE}/golf/${g.roundId}" target="_blank" rel="noopener" title="Check this round on-chain">↗</a>`;
            return `<li><span class="dot" style="background:${colour.get(g.id)}"></span><span class="name">${escape(g.name)}${you}${trophy}</span><span class="what">${what}${check}</span></li>`;
        })
        .join("");
}

/** Plays each golfer's newest shot once, but none on the first state, which only marks them seen */
function watchFlights(golfers: readonly GolferView[], first: boolean) {
    const mine = me();
    for (const g of golfers) {
        const shot = g.last?.shot ?? 0;
        if (shot <= (seen.get(g.id) ?? 0)) continue;
        seen.set(g.id, shot);
        // The player's own shot is played from its answer, which has the whole flight
        if (first || (g.id === mine && shooting) || g.last === undefined) continue;
        const f = flight(g.last.path, g.last.frames ?? g.last.path.length);
        if (f !== undefined) flights.set(g.id, f);
        if (g.id === mine) trail = [];
    }
    if (flights.size > 0) animate();
}

/** A flight to play along `path`, as long as the canister's `frames` of it took */
function flight(path: readonly [number, number][], frames: number): Flight | undefined {
    if (path.length === 0) return undefined;
    return { path, ms: (Math.max(1, frames) / FLIGHT_FPS) * 1000, at: path[0] };
}

/** The point `i` points along a path, between two of them when `i` isn't whole */
function along(path: readonly [number, number][], i: number): [number, number] {
    const n = Math.floor(i);
    const [x0, y0] = path[n];
    const [x1, y1] = path[Math.min(n + 1, path.length - 1)];
    return [x0 + (x1 - x0) * (i - n), y0 + (y1 - y0) * (i - n)];
}

/** Plays every flight by the time since it started, then renders once they've all landed */
function animate() {
    if (animating) return;
    animating = true;
    const step = (now: number) => {
        for (const [id, f] of flights) {
            f.start ??= now;
            const done = Math.min(1, (now - f.start) / f.ms);
            const i = done * (f.path.length - 1);
            f.at = along(f.path, i);
            if (id === me()) trail = [...f.path.slice(0, Math.floor(i) + 1), f.at];
            if (done >= 1) flights.delete(id);
        }
        draw();
        if (flights.size > 0) {
            requestAnimationFrame(step);
        } else {
            animating = false;
            ctx.render();
        }
    };
    requestAnimationFrame(step);
}

function draw() {
    if (canvas === undefined || !canvas.isConnected) return;
    const course = still?.course ?? shared?.course;
    if (course === undefined) return;
    const golfers = still?.golfers ?? shared?.golfers ?? [];
    const colour = colours(golfers);
    const mine = me();
    const balls: Ball[] = golfers.map((g) => ({ at: ballAt(g), color: colour.get(g.id)!, mine: g.id === mine }));
    if (still !== undefined && golfers.length === 0) {
        balls.push({ at: course.tee, color: "#fff", mine: true });
    }
    const golfer = still === undefined ? myGolfer() : undefined;
    const aimFrom = golfer === undefined || flights.has(golfer.id) ? undefined : golfer.ball;
    drawHole(
        canvas,
        course,
        balls,
        still === undefined ? trail : [],
        aimFrom !== undefined && canShoot() ? { from: aimFrom, angle, power } : undefined,
    );
}

/** Where the golfer's ball is drawn: along its flight while it's being played */
function ballAt(g: GolferView): Point {
    const f = flights.get(g.id);
    if (f === undefined) return g.ball;
    const [x, y] = f.at;
    return { x, y };
}

/** The state, with the player's golfer as their shot's answer has it, if the state is behind it */
function withAnswer(s: GolfShared): GolfShared {
    const mine = answered;
    if (mine === undefined) return s;
    const behind = s.golfers.some((g) => g.id === mine.id && (g.last?.shot ?? 0) < (mine.last?.shot ?? 0));
    if (!behind) {
        answered = undefined;
        return s;
    }
    return { ...s, golfers: s.golfers.map((g) => (g.id === mine.id ? mine : g)) };
}

function syncAim(section: ParentNode) {
    const a = section.querySelector<HTMLInputElement>('[data-aim="angle"]');
    const p = section.querySelector<HTMLInputElement>('[data-aim="power"]');
    if (a === null || p === null) return;
    if (document.activeElement !== a) a.value = String(angle);
    if (document.activeElement !== p) p.value = String(power);
    section.querySelector('[data-out="angle"]')!.textContent = `${angle.toFixed(1)}°`;
    section.querySelector('[data-out="power"]')!.textContent = `${power.toFixed(0)}%`;
}

function attachControls(section: HTMLElement) {
    section.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input.dataset.aim === "angle") angle = Number(input.value);
        if (input.dataset.aim === "power") power = Number(input.value);
        syncAim(section);
        draw();
    });
}

/**
 * Aiming by pressing on the ball and pulling back from it, as on onicai's page. A press away from
 * the ball does nothing, so a swipe across the card can't shoot; a tap, or a press that doesn't
 * move, only cancels.
 */
function attachCanvas(element: HTMLCanvasElement) {
    canvas = element;
    element.addEventListener("pointerdown", (e) => {
        if (!canShoot() || e.button !== 0) return;
        const ball = ballPx(element);
        const r = element.getBoundingClientRect();
        if (ball === undefined || Math.hypot(e.clientX - r.left - ball.x, e.clientY - r.top - ball.y) > GRAB_PX) {
            return;
        }
        aiming = { x: e.clientX, y: e.clientY, dragged: false };
        element.setPointerCapture(e.pointerId);
    });
    element.addEventListener("pointermove", (e) => {
        if (aiming === undefined) return;
        if (Math.hypot(e.clientX - aiming.x, e.clientY - aiming.y) > 12) aiming.dragged = true;
        if (aiming.dragged) aimFrom(element, e);
    });
    element.addEventListener("pointerup", () => {
        const a = aiming;
        aiming = undefined;
        if (a?.dragged) void shoot();
    });
    element.addEventListener("pointercancel", () => {
        aiming = undefined;
    });
}

function aimFrom(element: HTMLCanvasElement, e: PointerEvent) {
    const ball = ballPx(element);
    if (ball === undefined) return;
    const r = element.getBoundingClientRect();
    // Pulled back to shoot forward, with the canvas's y running down
    const dx = ball.x - (e.clientX - r.left);
    const dy = e.clientY - r.top - ball.y;
    let a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (a < 0) a = dx >= 0 ? 0 : 180;
    angle = Math.round(Math.min(MAX_ANGLE, a) * 10) / 10;
    const pull = (Math.hypot(dx, dy) / (FULL_PULL * r.width)) * 100;
    power = Math.round(Math.max(MIN_POWER, Math.min(MAX_POWER, pull)) * 10) / 10;
    const section = element.closest("section");
    if (section !== null) syncAim(section);
    draw();
}

/** Where the player's ball is on the canvas, in CSS pixels */
function ballPx(element: HTMLCanvasElement): Point | undefined {
    const golfer = myGolfer();
    const course = shared?.course;
    if (golfer === undefined || course === undefined) return undefined;
    const v = frame(element, course);
    return { x: v.toX(golfer.ball.x), y: v.toY(golfer.ball.y) };
}

async function shoot() {
    if (!canShoot()) return;
    shooting = true;
    ctx.render();
    try {
        const response = await ctx.oc.fetch("/api/golf/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ angle, power }),
        });
        const answer = (await response.json()) as ShotResponse;
        if (answer.ok) {
            const id = answer.golfer.id;
            seen.set(id, Math.max(seen.get(id) ?? 0, answer.golfer.last?.shot ?? 0));
            // So the controls and status are the round's as it is now, before the state comes
            answered = answer.golfer;
            trail = [];
            const f = flight(answer.frames, answer.frames.length);
            if (f !== undefined) flights.set(id, f);
            aimAtCup(answer.golfer.ball);
            animate();
        } else {
            ctx.notice(answer.error);
        }
    } catch {
        ctx.notice("Couldn't reach the game");
    }
    shooting = false;
    ctx.render();
}

/** Past the cup, the aim turns back towards it, or the next shot would fly off the course */
function aimAtCup(ball: Point) {
    const cup = shared?.course?.cup;
    if (cup === undefined) return;
    const back = ball.x > cup.x;
    if (back !== angle > 90) angle = Math.round((180 - angle) * 10) / 10;
}
