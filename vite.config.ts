// Builds the browser app OpenChat opens from a game's card, at `<endpoint>/app`, into `dist/app`.
// The server serves that folder as static files.
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: "src/app",
    base: "/app/",
    build: {
        outDir: "../../dist/app",
        emptyOutDir: true,
        target: "es2022",
        sourcemap: true,
    },
    test: {
        root: ".",
        include: ["src/**/*.spec.ts"],
    },
});
