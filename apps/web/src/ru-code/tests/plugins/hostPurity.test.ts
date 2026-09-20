// @effect-diagnostics nodeBuiltinImport:off -- this suite walks the SOURCE TREE off disk
// ru-code: plugins — THE APP KNOWS NOTHING ABOUT THE PORTED ASSISTANT (S44).
//
// "Zero plugin knowledge in the host" (architecture.md §1) is the rule the whole seam model rests
// on, and for this port it was checked by reading. It is a test now, because the failure mode is
// silent: an import, a panel id, a method name or a CSS import added back for a "quick fix" costs
// nothing at build time and undoes the port.
//
// WHY ONE NAME AND NOT EVERY SHIPPED ID. The obvious generalisation — read
// `shipped-plugins.json` and forbid every id — does not survive contact: `demo` and `analytics`
// are ordinary English words that appear legitimately in `packages/shared/src/git.ts`, in theme
// fixtures and in a dozen test names (measured: 12 files). A checker that has to be taught which
// occurrences are innocent is a checker nobody trusts. This one forbids a name that is not an
// English word and that this app has no other reason to say.
//
// WHAT IS SCANNED: every source file under `apps/` and `packages/`. NOT scanned, deliberately:
//   · `ru-code/e2e/**` — the suite drives the real plugin through the real app, so it names it on
//     purpose: it boots the fake MCP server the plugin dials and imports the plugin's contracts
//     for that endpoint. Integration truth, not app knowledge.
//   · `ru-code/packaging/shipped-plugins.json` — the shipped LIST is data and is allowed (V2-46).
//   · `pnpm-workspace.yaml` — the catalog entry the e2e suite's own dependency resolves through.
//   · build outputs (`dist`, `dist-electron`, `dist-lib`, `.vite-plus`), `node_modules`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/** Repo root: this file is `apps/web/src/ru-code/tests/plugins/`. */
const APP_ROOT = NodePath.resolve(import.meta.dirname, "../../../../../..");

/**
 * The name the app must not say.
 *
 * Built from fragments so THIS file does not trip its own check when the grep is run by hand —
 * the run-time value is the plain word.
 */
const FORBIDDEN = ["pi", "xso"].join("");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "dist-lib",
  ".vite-plus",
  ".turbo",
  "coverage",
]);
const SOURCE = /\.(?:ts|tsx|css|json|mjs|cjs|js)$/;

const sourceFiles = (dir: string, out: Array<string> = []): ReadonlyArray<string> => {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(full, out);
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

describe("the app carries no trace of the ported assistant", () => {
  it("scans a real tree", () => {
    // A traversal that found nothing would make the assertion below vacuous.
    const files = [
      ...sourceFiles(NodePath.join(APP_ROOT, "apps")),
      ...sourceFiles(NodePath.join(APP_ROOT, "packages")),
    ];
    expect(files.length).toBeGreaterThan(500);
  });

  it("names it nowhere under apps/ or packages/", () => {
    const files = [
      ...sourceFiles(NodePath.join(APP_ROOT, "apps")),
      ...sourceFiles(NodePath.join(APP_ROOT, "packages")),
    ];
    const self = NodePath.resolve(import.meta.filename);
    const offenders: Array<string> = [];
    for (const file of files) {
      if (file === self) continue;
      const source = NodeFS.readFileSync(file, "utf8");
      if (source.toLowerCase().includes(FORBIDDEN)) {
        offenders.push(NodePath.relative(APP_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
