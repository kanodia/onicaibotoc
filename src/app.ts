// The bot's HTTP routes: its definition, the `/play` command, the MiniApp service's calls, the
// app's requests and the app itself.
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { definition } from "./definition";
import type { Deps } from "./deps";
import { golfShot, settings } from "./handlers/api";
import { join, leave, start } from "./handlers/miniApp";
import { executeCommand } from "./handlers/play";

type Handler = (req: Request, res: Response, deps: Deps) => Promise<void>;

export function createApp(deps: Deps, appDir: string): Express {
    const app = express();
    const handle = (handler: Handler) => (req: Request, res: Response) => {
        handler(req, res, deps).catch((err) => {
            console.error(`${req.method} ${req.path} failed:`, err);
            if (!res.headersSent) res.status(500).json({ error: "Something went wrong" });
        });
    };

    app.use(cors());
    app.get(["/", "/bot_definition"], (_req, res) => {
        res.json(definition);
    });
    app.post("/execute_command", express.text({ type: "*/*" }), handle(executeCommand));

    // The MiniApp service, with its token in a header and no body
    app.post("/mini_app/join", handle(join));
    app.post("/mini_app/leave", handle(leave));
    app.post("/mini_app/start", handle(start));

    // Players' apps, with a player token in a header
    app.post("/api/settings", express.json(), handle(settings));
    app.post("/api/golf/shot", express.json(), handle(golfShot));

    // The app, which OpenChat opens in a frame, and frames afresh each time its card is back on
    // screen, so it's cached. Vite names the bundles by their content, so they're kept for good;
    // the page, which names them, for a minute; the rest, eg. the cards' artwork, for an hour.
    const index = path.resolve(appDir, "index.html");
    app.get(["/app", "/app/", "/app/index.html"], (_req, res) => {
        res.sendFile(index, { headers: { "Cache-Control": "private, max-age=60" } });
    });
    app.use(
        "/app/assets",
        express.static(path.resolve(appDir, "assets"), {
            index: false,
            immutable: true,
            maxAge: "1y",
        }),
    );
    app.use("/app", express.static(path.resolve(appDir), { index: false, maxAge: "1h" }));

    return app;
}
