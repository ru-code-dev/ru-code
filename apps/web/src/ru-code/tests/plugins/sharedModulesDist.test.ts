// @effect-diagnostics nodeBuiltinImport:off -- this suite reads the BUILT artefact off disk
// ru-code v2: the BUILT artefact's half of the shared-runtime contract.
//
// The original finding was literally `grep -c importmap dist/index.html` → 0: a web artifact that
// arrives after the build has no mechanism to import react by name. This suite is that measurement
// turned into a gate. After `pnpm build`, the shipped `index.html` must carry ONE import map, it
// must precede everything that could resolve a specifier, it must list exactly the ten shared
// specifiers, every URL must be a real ESM chunk with real exports — and the whole dist must
// contain exactly ONE copy of React's module body, which is the property the mechanism exists for.
//
// Skipped (not failed) when `dist/` is absent: `vp run -r test` runs without a build, and a unit
// suite must not depend on an artefact that tier does not produce. The e2e gate always builds first.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import sharedJson from "../../plugins/shared.json";

const SHARED = Object.keys(sharedJson);

const webRoot = NodePath.resolve(
  NodePath.dirname(new URL(import.meta.url).pathname),
  "../../../..",
);
const distDir = NodePath.join(webRoot, "dist");
const indexHtmlPath = NodePath.join(distDir, "index.html");
const hasDist = NodeFS.existsSync(indexHtmlPath);

const IMPORT_MAP_RE = /<script type="importmap">([\s\S]*?)<\/script>/g;

describe.skipIf(!hasDist)("dist/index.html import map", () => {
  const html = hasDist ? NodeFS.readFileSync(indexHtmlPath, "utf8") : "";
  const matches = [...html.matchAll(IMPORT_MAP_RE)];
  const imports: Record<string, string> =
    matches.length === 1
      ? (JSON.parse(matches[0]?.[1] ?? "{}") as { imports: Record<string, string> }).imports
      : {};

  it("carries exactly ONE import map", () => {
    expect(matches).toHaveLength(1);
  });

  it("puts the map BEFORE the entry module script and before every modulepreload", () => {
    const mapAt = html.indexOf('<script type="importmap">');
    const moduleAt = html.indexOf('<script type="module"');
    const preloadAt = html.indexOf('rel="modulepreload"');
    expect(mapAt).toBeGreaterThanOrEqual(0);
    expect(moduleAt).toBeGreaterThan(mapAt);
    expect(preloadAt).toBeGreaterThan(mapAt);
  });

  it("maps EXACTLY the ten shared specifiers and nothing else", () => {
    expect(Object.keys(imports).sort()).toEqual([...SHARED].sort());
  });

  it.each(SHARED)(
    "%s resolves to an emitted ESM file with a non-empty export list",
    (specifier) => {
      const url = imports[specifier];
      expect(url).toBeTypeOf("string");
      const file = NodePath.join(distDir, (url ?? "").replace(/^\//, ""));
      expect(NodeFS.existsSync(file)).toBe(true);
      const source = NodeFS.readFileSync(file, "utf8");
      // A static grep, deliberately: these are browser chunks, so `import()`ing them in Node is not
      // possible — what matters is that the file really is an ES module that exports something, not
      // an empty facade Rollup tree-shook down to nothing.
      const exportClause = /export\s*\{([^}]*)\}/.exec(source);
      expect(exportClause).not.toBeNull();
      expect((exportClause?.[1] ?? "").trim().length).toBeGreaterThan(0);
    },
  );

  it("emits the diagnostics manifest alongside the chunks", () => {
    const manifestPath = NodePath.join(distDir, "assets/shared-modules.json");
    expect(NodeFS.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      modules: ReadonlyArray<{ specifier: string; url: string }>;
    };
    expect(manifest.modules.map((entry) => entry.specifier).sort()).toEqual([...SHARED].sort());
    for (const entry of manifest.modules) expect(imports[entry.specifier]).toBe(entry.url);
  });
});

describe.skipIf(!hasDist)("one instance of every shared library", () => {
  const assetsDir = NodePath.join(distDir, "assets");
  const jsFiles = hasDist
    ? NodeFS.readdirSync(assetsDir, { recursive: true, encoding: "utf8" }).filter((name) =>
        name.endsWith(".js"),
      )
    : [];
  const contains = (needle: string) =>
    jsFiles.filter((name) =>
      NodeFS.readFileSync(NodePath.join(assetsDir, name), "utf8").includes(needle),
    );

  it("ships exactly one copy of React's module body", () => {
    // React's client internals are assigned exactly once per copy of react's own module — the
    // cheapest one-per-instance fingerprint in the bundle.
    expect(
      contains("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE="),
    ).toHaveLength(1);
  });

  it("makes the `react` entry RE-EXPORT that same chunk instead of inlining a second copy", () => {
    const reactChunk = NodePath.basename(
      contains("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=")[0] ?? "",
    );
    const html = NodeFS.readFileSync(indexHtmlPath, "utf8");
    const imports = (
      JSON.parse([...html.matchAll(IMPORT_MAP_RE)][0]?.[1] ?? '{"imports":{}}') as {
        imports: Record<string, string>;
      }
    ).imports;
    const entrySource = NodeFS.readFileSync(
      NodePath.join(distDir, (imports["react"] ?? "").replace(/^\//, "")),
      "utf8",
    );
    expect(entrySource).toContain(reactChunk);
    expect(entrySource).not.toContain(
      "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=",
    );
  });

  it("does NOT publish a shared entry for anything a plugin is expected to bundle", () => {
    // The dist grew 50 entries in v1, one of which pinned lucide's whole ≈ 1 MB barrel into every
    // user's build for plugins nobody had installed. base-ui joined the list at V2-13 for the
    // opposite reason — it does NOT tree-shake per plugin — and lucide still does not.
    const html = NodeFS.readFileSync(indexHtmlPath, "utf8");
    const imports = (
      JSON.parse([...html.matchAll(IMPORT_MAP_RE)][0]?.[1] ?? '{"imports":{}}') as {
        imports: Record<string, string>;
      }
    ).imports;
    for (const specifier of ["lucide-react", "@smart-tools/qwen-cli-ui-kit", "recharts"]) {
      expect(imports[specifier]).toBeUndefined();
    }
    // A SUBPATH is never published: the plugin build folds it onto the root it publishes.
    for (const specifier of ["@base-ui/react/dialog", "effect/Effect"]) {
      expect(imports[specifier]).toBeUndefined();
    }
  });
});
