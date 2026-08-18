// @effect-diagnostics nodeBuiltinImport:off -- vite build plugin runs in Node, not an Effect runtime
// ru-code: build plugin for the PWA service worker.
//
// Compiles `sw.ts` (TypeScript, self-contained, import-free) into a single ES
// module served at the ROOT path `/sw.js` — unhashed and root-scoped so the
// worker controls the whole origin and the registration URL is stable. It is
// deliberately its OWN standalone output, never part of the app's module graph:
// a service worker must be a self-contained script, not an app chunk.
//
// Uses vite-plus's bundled `transformWithOxc` (no extra dependency — unlike the
// deprecated `transformWithEsbuild`, which now needs a separately-installed
// `esbuild`). Oxc is a transpiler: it strips the TS types and leaves the ESM
// `export {}` marker, so the output is an ES module — hence it is registered with
// `{ type: "module" }` in main.tsx. The worker has no imports; if it ever needs
// to import helpers, swap this for a bundling build.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import type { Plugin } from "vite";
import { transformWithOxc } from "vite-plus";

const SW_SOURCE = NodeURL.fileURLToPath(new URL("./sw.ts", import.meta.url));
const SW_URL = "sw.js";

const compileServiceWorker = async (): Promise<string> => {
  const source = NodeFS.readFileSync(SW_SOURCE, "utf8");
  const result = await transformWithOxc(source, SW_SOURCE, { lang: "ts" });
  return result.code;
};

export const serviceWorkerPlugin = (): Plugin => {
  let compiled: string | null = null;

  return {
    name: "ru-code-service-worker",

    // Dev: serve the compiled worker at /sw.js with a root-scope grant.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = (req.url ?? "").split("?")[0]!.replace(/^\/+/, "");
        if (urlPath !== SW_URL) {
          next();
          return;
        }
        void compileServiceWorker()
          .then((code) => {
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Service-Worker-Allowed", "/");
            res.end(code);
          })
          .catch(next);
      });
    },

    // Build: emit the compiled worker to dist/sw.js (unhashed, root path).
    async generateBundle() {
      compiled ??= await compileServiceWorker();
      this.emitFile({ type: "asset", fileName: SW_URL, source: compiled });
    },
  };
};
