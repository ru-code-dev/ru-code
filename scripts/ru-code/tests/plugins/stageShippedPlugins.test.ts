// @effect-diagnostics nodeBuiltinImport:off - build tooling under test; no Effect runtime here.
//
// ru-code (V2-20): the shipped-set staging contract.
//
// The through-line is the owner's override to the S6 analysis: **a listed path that cannot be
// staged is logged and skipped, never a failure**. A release carrying no plugins is legal, so every
// bad-input case below asserts a SKIP line and a clean exit, not a throw. The only fatal input is
// the list file itself being unreadable — the tool broken rather than an input absent.
//
// The decoder is the REAL one (`loadManifestDecoder` → `@smart-tools/plugin-sdk/contracts`), on
// purpose: staging must accept exactly what `PluginHost` will accept at boot, and a hand-rolled
// stand-in here would let the two drift apart silently.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  loadManifestDecoder,
  readShippedPluginsList,
  stageShippedPlugins,
  type ManifestDecoder,
} from "../../plugins/stageShippedPlugins.ts";

const APP_ROOT = NodePath.resolve(import.meta.dirname, "../../../..");

let decode: ManifestDecoder;
beforeAll(async () => {
  decode = await loadManifestDecoder(APP_ROOT);
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-stage-plugins-"));
  temporaryDirectories.push(directory);
  return directory;
}

const manifestJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: "sample", name: "Sample", version: "1.2.3", apiVersion: 2, ...overrides });

/** A plugin-shaped folder: `plugin.json` + whatever extra files the case needs. */
function writePluginFolder(
  root: string,
  relative: string,
  files: Readonly<Record<string, string>>,
): string {
  const dir = NodePath.join(root, relative);
  for (const [name, content] of Object.entries(files)) {
    const target = NodePath.join(dir, name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
  return dir;
}

function writeList(appRoot: string, plugins: ReadonlyArray<string>): string {
  const listPath = NodePath.join(appRoot, "ru-code/packaging/shipped-plugins.json");
  NodeFS.mkdirSync(NodePath.dirname(listPath), { recursive: true });
  NodeFS.writeFileSync(listPath, JSON.stringify({ _comment: "fixture", plugins }, null, 2));
  return listPath;
}

interface Run {
  readonly lines: ReadonlyArray<string>;
  readonly destDir: string;
  readonly result: ReturnType<typeof stageShippedPlugins>;
}

function run(appRoot: string, listPath: string): Run {
  const destDir = NodePath.join(appRoot, "apps/server/dist/plugins");
  const lines: string[] = [];
  const result = stageShippedPlugins({
    appRoot,
    listPath,
    destDir,
    decode,
    log: (message) => lines.push(message),
  });
  return { lines, destDir, result };
}

describe("readShippedPluginsList", () => {
  it("a missing file is an empty list — nothing to ship is legal", () => {
    const appRoot = makeTemporaryDirectory();
    expect(
      readShippedPluginsList(NodePath.join(appRoot, "ru-code/packaging/shipped-plugins.json")),
    ).toEqual([]);
  });

  it("ignores unknown keys so the file can carry its own _comment", () => {
    const appRoot = makeTemporaryDirectory();
    const listPath = NodePath.join(appRoot, "list.json");
    NodeFS.writeFileSync(
      listPath,
      JSON.stringify({ _comment: ["why", "this", "exists"], plugins: ["a/dist"] }),
    );
    expect(readShippedPluginsList(listPath)).toEqual(["a/dist"]);
  });

  // The ONE fatal input: shipping nothing because the list could not be read is exactly the
  // failure the list exists to prevent.
  it("throws on a list file that is not valid JSON", () => {
    const appRoot = makeTemporaryDirectory();
    const listPath = NodePath.join(appRoot, "list.json");
    NodeFS.writeFileSync(listPath, "{ not json");
    expect(() => readShippedPluginsList(listPath)).toThrow(/not valid JSON/);
  });

  it("throws when plugins is not an array of paths", () => {
    const appRoot = makeTemporaryDirectory();
    const listPath = NodePath.join(appRoot, "list.json");
    NodeFS.writeFileSync(listPath, JSON.stringify({ plugins: [{ package: "x" }] }));
    expect(() => readShippedPluginsList(listPath)).toThrow(/array of folder paths/);
  });
});

describe("stageShippedPlugins", () => {
  it("copies a listed folder to <dest>/<manifest id> and reports it", () => {
    const appRoot = makeTemporaryDirectory();
    writePluginFolder(appRoot, "pkgs/plugin-sample/dist", {
      "plugin.json": manifestJson({ web: "web/index.mjs" }),
      "web/index.mjs": "export const activate = () => {};\n",
    });
    const listPath = writeList(appRoot, ["pkgs/plugin-sample/dist"]);

    const { lines, destDir, result } = run(appRoot, listPath);

    // The id, NOT the listed path's basename (`dist`) — that is what makes the loader's
    // folder-name-is-the-id rule hold by construction.
    expect(NodeFS.existsSync(NodePath.join(destDir, "sample/plugin.json"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(destDir, "sample/web/index.mjs"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(destDir, "dist"))).toBe(false);
    expect(result.bundled).toHaveLength(1);
    expect(result.bundled[0]?.id).toBe("sample");
    expect(result.bundled[0]?.version).toBe("1.2.3");
    expect(result.bundled[0]?.bytes).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^SHIPPED sample 1\.2\.3 \d+$/);
    expect(lines.at(-1)).toBe("shipped plugins: 1 bundled, 0 skipped");
  });

  it("accepts an absolute path as well as one relative to the app root", () => {
    const appRoot = makeTemporaryDirectory();
    const elsewhere = makeTemporaryDirectory();
    const dir = writePluginFolder(elsewhere, "built", { "plugin.json": manifestJson() });
    const listPath = writeList(appRoot, [dir]);

    const { destDir, result } = run(appRoot, listPath);
    expect(result.bundled.map((p) => p.id)).toEqual(["sample"]);
    expect(NodeFS.existsSync(NodePath.join(destDir, "sample/plugin.json"))).toBe(true);
  });

  // R9: a symlinked plugin folder is refused by `scanPluginsDir` (realpath containment) and cannot
  // be extracted by non-admin Windows git-bash. The staged tree must be real files only.
  it("dereferences symlinks — the payload carries files, never links", () => {
    const appRoot = makeTemporaryDirectory();
    const real = writePluginFolder(appRoot, "real/dist", {
      "plugin.json": manifestJson(),
      "web/index.mjs": "export const activate = () => {};\n",
    });
    NodeFS.mkdirSync(NodePath.join(appRoot, "linked"), { recursive: true });
    NodeFS.symlinkSync(real, NodePath.join(appRoot, "linked/dist"), "dir");
    const listPath = writeList(appRoot, ["linked/dist"]);

    const { destDir, result } = run(appRoot, listPath);
    expect(result.bundled.map((p) => p.id)).toEqual(["sample"]);
    const staged = NodePath.join(destDir, "sample");
    expect(NodeFS.lstatSync(staged).isSymbolicLink()).toBe(false);
    expect(NodeFS.lstatSync(NodePath.join(staged, "web/index.mjs")).isSymbolicLink()).toBe(false);
  });

  it("wipes the destination first, so a plugin dropped from the list does not ride along", () => {
    const appRoot = makeTemporaryDirectory();
    writePluginFolder(appRoot, "pkgs/a/dist", { "plugin.json": manifestJson() });
    const destDir = NodePath.join(appRoot, "apps/server/dist/plugins");
    NodeFS.mkdirSync(NodePath.join(destDir, "stale"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(destDir, "stale/plugin.json"),
      manifestJson({ id: "stale" }),
    );
    const listPath = writeList(appRoot, ["pkgs/a/dist"]);

    run(appRoot, listPath);
    expect(NodeFS.readdirSync(destDir)).toEqual(["sample"]);
  });

  describe("a path that cannot be staged is skipped, never fatal", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly reason: RegExp;
      readonly seed: (appRoot: string) => string;
    }> = [
      {
        label: "the folder does not exist",
        reason: /no such folder/,
        seed: () => "pkgs/missing/dist",
      },
      {
        label: "the path is a file",
        reason: /not a directory/,
        seed: (appRoot) => {
          NodeFS.mkdirSync(NodePath.join(appRoot, "pkgs"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(appRoot, "pkgs/afile"), "x");
          return "pkgs/afile";
        },
      },
      {
        label: "the package was never built (no plugin.json)",
        reason: /no plugin\.json/,
        seed: (appRoot) => {
          NodeFS.mkdirSync(NodePath.join(appRoot, "pkgs/unbuilt/dist"), { recursive: true });
          return "pkgs/unbuilt/dist";
        },
      },
      {
        label: "plugin.json is not JSON",
        reason: /not valid JSON/,
        seed: (appRoot) => {
          writePluginFolder(appRoot, "pkgs/broken/dist", { "plugin.json": "{ nope" });
          return "pkgs/broken/dist";
        },
      },
      {
        label: "plugin.json does not decode (the SDK schema refuses it)",
        reason: /does not decode/,
        seed: (appRoot) => {
          writePluginFolder(appRoot, "pkgs/bad/dist", {
            "plugin.json": JSON.stringify({ id: "Not An Id", name: "", apiVersion: "two" }),
          });
          return "pkgs/bad/dist";
        },
      },
    ];

    for (const testCase of cases) {
      it(testCase.label, () => {
        const appRoot = makeTemporaryDirectory();
        const source = testCase.seed(appRoot);
        const listPath = writeList(appRoot, [source]);

        const { lines, destDir, result } = run(appRoot, listPath);
        expect(result.bundled).toEqual([]);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]?.source).toBe(source);
        expect(result.skipped[0]?.reason).toMatch(testCase.reason);
        expect(lines[0]).toMatch(
          new RegExp(`^SKIP ${source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: `),
        );
        expect(lines.at(-1)).toBe("shipped plugins: 0 bundled, 1 skipped");
        // The destination still exists and is empty: `prepare-release` copies whatever is there,
        // and an absent `plugins/` and an empty one must behave the same.
        expect(NodeFS.readdirSync(destDir)).toEqual([]);
      });
    }
  });

  it("a bad entry does not stop the good ones after it", () => {
    const appRoot = makeTemporaryDirectory();
    NodeFS.mkdirSync(NodePath.join(appRoot, "pkgs/unbuilt/dist"), { recursive: true });
    writePluginFolder(appRoot, "pkgs/good/dist", { "plugin.json": manifestJson({ id: "good" }) });
    const listPath = writeList(appRoot, ["pkgs/unbuilt/dist", "pkgs/good/dist"]);

    const { result, destDir } = run(appRoot, listPath);
    expect(result.bundled.map((p) => p.id)).toEqual(["good"]);
    expect(result.skipped).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(destDir, "good/plugin.json"))).toBe(true);
  });

  it("duplicate ids: the first entry wins and the later one is logged", () => {
    const appRoot = makeTemporaryDirectory();
    writePluginFolder(appRoot, "pkgs/first/dist", {
      "plugin.json": manifestJson(),
      "marker.txt": "first",
    });
    writePluginFolder(appRoot, "pkgs/second/dist", {
      "plugin.json": manifestJson({ version: "9.9.9" }),
      "marker.txt": "second",
    });
    const listPath = writeList(appRoot, ["pkgs/first/dist", "pkgs/second/dist"]);

    const { destDir, result } = run(appRoot, listPath);
    expect(result.bundled.map((p) => p.source)).toEqual(["pkgs/first/dist"]);
    expect(result.skipped[0]?.reason).toMatch(/duplicate id "sample"/);
    expect(NodeFS.readFileSync(NodePath.join(destDir, "sample/marker.txt"), "utf8")).toBe("first");
  });

  it("an empty list is a clean no-op, not an error", () => {
    const appRoot = makeTemporaryDirectory();
    const listPath = writeList(appRoot, []);
    const { lines, destDir, result } = run(appRoot, listPath);
    expect(result).toEqual({ bundled: [], skipped: [] });
    expect(lines).toEqual(["shipped plugins: 0 bundled, 0 skipped"]);
    expect(NodeFS.readdirSync(destDir)).toEqual([]);
  });

  // The committed list is not a fixture: a path that no longer resolves to the plugin it claims
  // shows up here. WHICH plugins ship is the owner's call (V2-46), so nothing here pins it.
  it("the repo's own list: every listed plugin is staged or skipped", () => {
    const appRoot = makeTemporaryDirectory();
    const listed = readShippedPluginsList(
      NodePath.join(APP_ROOT, "ru-code/packaging/shipped-plugins.json"),
    );
    expect(listed.length).toBeGreaterThan(0);

    const destDir = NodePath.join(appRoot, "plugins");
    const result = stageShippedPlugins({
      appRoot: APP_ROOT,
      listPath: NodePath.join(APP_ROOT, "ru-code/packaging/shipped-plugins.json"),
      destDir,
      decode,
      log: () => {},
    });
    // The plugin packages may not be built in every checkout — skips are legal by design, so the
    // assertion is on what the list CLAIMS, not on what happened to be on disk.
    for (const staged of result.bundled) {
      expect(NodeFS.existsSync(NodePath.join(destDir, staged.id, "plugin.json"))).toBe(true);
    }
    expect(result.bundled.length + result.skipped.length).toBe(listed.length);
  });
});
