// @effect-diagnostics nodeBuiltinImport:off -- vite build plugin runs in Node, not an Effect runtime
// ru-code: build plugin for the PWA service worker.
//
// Compiles `sw.ts` into a single ES module served at the ROOT path `/sw.js` —
// unhashed and root-scoped so the worker controls the whole origin and the
// registration URL is stable. It is deliberately its OWN standalone output,
// never part of the app's module graph: a service worker must be a
// self-contained script, not an app chunk.
//
// The worker imports the sw-kit page emitters (auto-update status pages), so
// this is a BUNDLING build now: a nested single-entry Vite lib build with
// inlined imports produces one self-contained file (the previous
// transformWithOxc transpile-only pass could not resolve imports). The nested
// build is tiny (a handful of pure template modules) and runs once per build /
// on demand in dev.
import * as NodeURL from "node:url";
import { build, type Plugin, type Rollup } from "vite";

const SW_SOURCE = NodeURL.fileURLToPath(new URL("./sw.ts", import.meta.url));
const SW_URL = "sw.js";

const compileServiceWorker = async (): Promise<string> => {
  const result = (await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      target: "es2020",
      lib: { entry: SW_SOURCE, formats: ["es"], fileName: () => SW_URL },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs[0]?.output.find(
    (item): item is Rollup.OutputChunk => item.type === "chunk",
  );
  if (chunk === undefined) throw new Error("service worker build produced no chunk");
  return chunk.code;
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
            res.setHeader("Cache-Control", "no-cache");
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
