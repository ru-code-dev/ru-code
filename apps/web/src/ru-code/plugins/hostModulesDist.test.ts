// @effect-diagnostics nodeBuiltinImport:off -- this suite reads the BUILT artefact off disk
// ru-code: the BUILT artefact's half of D13 — the assertion V3 measured as failing.
//
// V3's finding was literally `grep -c importmap dist/index.html` → 0, i.e. "a web artifact
// that arrives after the build has no mechanism to import react by name". This suite is that
// measurement turned into a gate: after `pnpm build`, the shipped `index.html` must carry ONE
// import map, it must precede everything that could resolve a specifier, every contract
// specifier must be in it, and every URL must be a real ESM file on disk with real exports.
//
// Skipped (not failed) when `dist/` is absent: T0 runs `vp run -r test` without a build, and a
// unit suite must not depend on an artefact that tier does not produce. The T1 gate always
// builds first, so the assertions do run where they matter.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HOST_PROVIDED_MODULES } from "@smart-tools/plugin-sdk/contracts";
import { describe, expect, it } from "vite-plus/test";

const webRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../../..");
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

  it("carries exactly one import map", () => {
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

  it("maps EVERY host-provided specifier and nothing else", () => {
    expect(Object.keys(imports).sort()).toEqual(
      HOST_PROVIDED_MODULES.map((entry) => entry.specifier).sort(),
    );
  });

  it.each(HOST_PROVIDED_MODULES.map((entry) => entry.specifier))(
    "%s resolves to an emitted ESM file with a non-empty export list",
    (specifier) => {
      const url = imports[specifier];
      expect(url).toBeTypeOf("string");
      expect(url?.startsWith("/assets/host-modules/")).toBe(true);
      const file = NodePath.join(distDir, (url ?? "").replace(/^\//, ""));
      expect(NodeFS.existsSync(file)).toBe(true);
      const source = NodeFS.readFileSync(file, "utf8");
      // A static grep, deliberately: these are browser chunks, so `import()`ing them in node
      // is not possible — what matters is that the file really is an ES module that exports
      // something, not an empty facade Rollup tree-shook down to nothing.
      const exportClause = /export\s*\{([^}]*)\}/.exec(source);
      expect(exportClause).not.toBeNull();
      expect((exportClause?.[1] ?? "").trim().length).toBeGreaterThan(0);
    },
  );

  it("emits the diagnostics manifest alongside the chunks", () => {
    const manifestPath = NodePath.join(distDir, "assets/host-modules/manifest.json");
    expect(NodeFS.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      modules: ReadonlyArray<{ specifier: string; version: string; url: string }>;
    };
    expect(manifest.modules.map((entry) => entry.specifier).sort()).toEqual(
      HOST_PROVIDED_MODULES.map((entry) => entry.specifier).sort(),
    );
    for (const entry of manifest.modules) {
      expect(imports[entry.specifier]).toBe(entry.url);
      expect(entry.version.length).toBeGreaterThan(0);
    }
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
    // React's client internals are assigned exactly once per copy of react's own module —
    // the cheapest one-per-instance fingerprint in the bundle.
    expect(
      contains("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE="),
    ).toHaveLength(1);
  });

  it("makes the `react` host-module entry re-export that same shared chunk", () => {
    const reactCopies = contains(
      "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=",
    );
    const reactChunk = NodePath.basename(reactCopies[0] ?? "");
    const html = NodeFS.readFileSync(indexHtmlPath, "utf8");
    const imports = (
      JSON.parse([...html.matchAll(IMPORT_MAP_RE)][0]?.[1] ?? '{"imports":{}}') as {
        imports: Record<string, string>;
      }
    ).imports;
    const entryFile = NodePath.join(distDir, (imports["react"] ?? "").replace(/^\//, ""));
    const entrySource = NodeFS.readFileSync(entryFile, "utf8");
    // The entry must IMPORT the shared chunk, never inline a second copy of React.
    expect(entrySource).toContain(reactChunk);
    expect(entrySource).not.toContain(
      "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=",
    );
  });
});
