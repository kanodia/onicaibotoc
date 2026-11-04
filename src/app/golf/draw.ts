// Draws a Chain Golf hole as onicai's own page does: the level's scenery, the ground, the planks
// and crates, the cup and flag, and every golfer's ball, with the aim and, below level 10, onicai's
// aim guide, which works the flight out with the same gravity, launch speed and drag as the
// canister's Box2D, up to where the ball first lands.
import type { Course, Point } from "../../games/golf/types";

type Scene = {
    sky: [string, string];
    turf: [string, string];
    edge: string;
    wood: [string, string];
    body?: { x: number; y: number; r: number; color: string };
    stars?: boolean;
};

/** onicai's scenery for a level: sunrise, midday, evening, sunset and midnight */
const SCENES: Scene[] = [
    {
        sky: ["#3b5b8c", "#f2a97e"],
        turf: ["#4fae6e", "#2a6b45"],
        edge: "#8be0a4",
        wood: ["#c99a64", "#7a5634"],
        body: { x: 0.16, y: 0.38, r: 0.035, color: "#ffd9a0" },
    },
    {
        sky: ["#3f86d1", "#a9d4f5"],
        turf: ["#43a362", "#1f5a36"],
        edge: "#86dca0",
        wood: ["#c99a64", "#7a5634"],
        body: { x: 0.78, y: 0.16, r: 0.05, color: "#fff4c2" },
    },
    {
        sky: ["#0f1a2b", "#1b2d44"],
        turf: ["#2f7d53", "#173a28"],
        edge: "#5fbf86",
        wood: ["#b98a56", "#6e4f2e"],
    },
    {
        sky: ["#2b1f4a", "#e86a4a"],
        turf: ["#2d6b47", "#14301f"],
        edge: "#79c08e",
        wood: ["#a8774a", "#5e3f22"],
        body: { x: 0.86, y: 0.36, r: 0.038, color: "#ff9e5e" },
    },
    {
        sky: ["#03050c", "#0b1530"],
        turf: ["#1d4a35", "#0b1d14"],
        edge: "#3f8f68",
        wood: ["#8a6a48", "#4a3622"],
        body: { x: 0.8, y: 0.18, r: 0.028, color: "#dfe6f5" },
        stars: true,
    },
];

function scene(level: number): Scene {
    return SCENES[Math.min(4, Math.floor((Math.max(1, Math.min(20, level || 10)) - 1) / 4))];
}

/** Metres across the canvas: the whole hole, flag included */
const SPAN = 64;

/** A ball to draw: the player's own is white and larger, everyone else's in their colour */
export type Ball = { at: Point; color: string; mine: boolean };

export type Aim = { from: Point; angle: number; power: number };

/** Where the canvas puts the hole: metres to pixels and back */
export type Frame = {
    scale: number;
    toX: (x: number) => number;
    toY: (y: number) => number;
    fromX: (px: number) => number;
    fromY: (py: number) => number;
};

export function frame(canvas: HTMLCanvasElement, course: Course): Frame {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const s = w / SPAN;
    const ys = course.ground.map((p) => p[1]);
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2 + 2;
    const x0 = -2;
    return {
        scale: s,
        toX: (x) => (x - x0) * s,
        toY: (y) => h / 2 - (y - midY) * s,
        fromX: (px) => px / s + x0,
        fromY: (py) => midY - (py - h / 2) / s,
    };
}

export function drawHole(
    canvas: HTMLCanvasElement,
    course: Course,
    balls: readonly Ball[],
    trail: readonly [number, number][],
    aim?: Aim,
): void {
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = frame(canvas, course);
    const sc = scene(course.level);

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, sc.sky[0]);
    sky.addColorStop(1, sc.sky[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    if (sc.stars) {
        ctx.fillStyle = "rgba(232,236,243,.7)";
        for (let i = 0; i < 60; i++) {
            ctx.fillRect(((i * 0.618034) % 1) * w, ((i * 0.754878) % 1) * h * 0.6, 1.5, 1.5);
        }
    }
    if (sc.body) {
        const b = sc.body;
        const r = b.r * Math.min(w, h * 2);
        const glow = ctx.createRadialGradient(b.x * w, b.y * h, r * 0.6, b.x * w, b.y * h, r * 3);
        glow.addColorStop(0, b.color + "55");
        glow.addColorStop(1, b.color + "00");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x * w, b.y * h, r, 0, 7);
        ctx.fill();
    }

    // The ground
    const ground = course.ground;
    ctx.beginPath();
    ctx.moveTo(v.toX(ground[0][0]), h);
    for (const [x, y] of ground) ctx.lineTo(v.toX(x), v.toY(y));
    ctx.lineTo(v.toX(ground[ground.length - 1][0]), h);
    ctx.closePath();
    const turf = ctx.createLinearGradient(0, 0, 0, h);
    turf.addColorStop(0, sc.turf[0]);
    turf.addColorStop(1, sc.turf[1]);
    ctx.fillStyle = turf;
    ctx.fill();
    ctx.strokeStyle = sc.edge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ground.forEach(([x, y], i) => (i ? ctx.lineTo(v.toX(x), v.toY(y)) : ctx.moveTo(v.toX(x), v.toY(y))));
    ctx.stroke();

    // The obstacles
    for (const b of course.boxes) {
        ctx.save();
        ctx.translate(v.toX(b.x), v.toY(b.y));
        ctx.rotate(-b.angle);
        ctx.fillStyle = sc.wood[0];
        ctx.strokeStyle = sc.wood[1];
        ctx.lineWidth = 1.5;
        const bw = 2 * b.half_w * v.scale;
        const bh = 2 * b.half_h * v.scale;
        ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
        ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
        ctx.restore();
    }

    // The cup and flag
    const cx = v.toX(course.cup.x);
    const cy = v.toY(course.cup.y);
    ctx.strokeStyle = "#e8ecf3";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 2.4 * v.scale);
    ctx.stroke();
    ctx.fillStyle = "#ff6b6b";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 2.4 * v.scale);
    ctx.lineTo(cx + 0.9 * v.scale, cy - 2.1 * v.scale);
    ctx.lineTo(cx, cy - 1.8 * v.scale);
    ctx.fill();

    // The latest flight
    if (trail.length > 1) {
        ctx.strokeStyle = "rgba(94,242,200,.55)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        trail.forEach(([x, y], i) => (i ? ctx.lineTo(v.toX(x), v.toY(y)) : ctx.moveTo(v.toX(x), v.toY(y))));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Everyone else's balls, then the player's own on top
    const ordered = [...balls.filter((b) => !b.mine), ...balls.filter((b) => b.mine)];
    for (const ball of ordered) {
        const r = Math.max(ball.mine ? 4 : 3, course.ball_radius * v.scale * (ball.mine ? 1 : 0.85));
        ctx.fillStyle = ball.mine ? "#fff" : ball.color;
        ctx.strokeStyle = "#0b0d12";
        ctx.lineWidth = ball.mine ? 1.5 : 1;
        ctx.beginPath();
        ctx.arc(v.toX(ball.at.x), v.toY(ball.at.y), r, 0, 6.2832);
        ctx.fill();
        ctx.stroke();
    }

    if (aim !== undefined) drawAim(ctx, v, course, aim);
}

function drawAim(ctx: CanvasRenderingContext2D, v: Frame, course: Course, aim: Aim) {
    const a = (aim.angle * Math.PI) / 180;
    const len = (0.6 + (aim.power / 100) * 4.5) * v.scale;
    const bx = v.toX(aim.from.x);
    const by = v.toY(aim.from.y);
    const ex = bx + Math.cos(a) * len;
    const ey = by - Math.sin(a) * len;
    ctx.strokeStyle = "#ffd666";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillStyle = "#ffd666";
    ctx.beginPath();
    ctx.arc(ex, ey, 4, 0, 6.2832);
    ctx.fill();
    // Below level 10, the whole flight up to where it lands; from 5, only its start
    const level = course.level ?? 10;
    if (level < 10) drawGuide(ctx, v, course, aim, a, level <= 4 ? 1 : 0.4);
}

function groundAt(course: Course, x: number): number {
    const g = course.ground;
    for (let i = 0; i + 1 < g.length; i++) {
        if (x >= g[i][0] && x <= g[i + 1][0]) {
            return g[i][1] + ((g[i + 1][1] - g[i][1]) * (x - g[i][0])) / (g[i + 1][0] - g[i][0] || 1);
        }
    }
    return -99;
}

function drawGuide(
    ctx: CanvasRenderingContext2D,
    v: Frame,
    course: Course,
    aim: Aim,
    a: number,
    part: number,
) {
    let { x, y } = aim.from;
    let vx = ((26 * aim.power) / 100) * Math.cos(a);
    let vy = ((26 * aim.power) / 100) * Math.sin(a);
    ctx.fillStyle = "rgba(255,214,102,.75)";
    for (let i = 1; i <= 360; i++) {
        vy -= 9.81 / 60;
        vx /= 1 + 0.15 / 60;
        vy /= 1 + 0.15 / 60;
        x += vx / 60;
        y += vy / 60;
        if (i > 3 && y < groundAt(course, x) + course.ball_radius) break;
        if (part < 1 && i > (360 * part * aim.power) / 100 + 20) break;
        if (i % 4 === 0) {
            ctx.beginPath();
            ctx.arc(v.toX(x), v.toY(y), 2.2, 0, 6.2832);
            ctx.fill();
        }
    }
}
