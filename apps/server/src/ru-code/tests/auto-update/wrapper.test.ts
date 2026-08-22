// ru-code: drives the REAL frozen wrapper (`<appRoot>/cli.js`) end-to-end. Each test builds a throwaway
// installed layout in a fresh tmp dir — the emitted wrapper + a `current.json` pointer and/or
// `versions/<v>/` dirs whose entries are tiny .js scripts that print a marker and exit 0 — then EXECUTES
// the wrapper on the system `node` (the current process's execPath) and asserts on its exit code, stdout
// (the booted entry's marker + argv), and stderr (the branded error banners). Plain vitest here — the
// wrapper has no Effect surface; it is emitted plain-ESM source run by a child node.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off

import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeWrapperSource } from "../../auto-update/wrapper/wrapperSource.ts";

const DEFAULT_PARAMS = {
  appName: "Ru Code",
  appCommand: "ru-code",
  supportUrl: "https://support.example/help",
} as const;

const roots: Array<string> = [];

const mkdirp = (dir: string): void => {
  NodeFS.mkdirSync(dir, { recursive: true });
};

const mkTempRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-wrapper-e2e-"));
  roots.push(root);
  return root;
};

const writeWrapper = (
  appRoot: string,
  params: { readonly appName: string; readonly appCommand: string; readonly supportUrl: string },
): string => {
  const wrapperPath = NodePath.join(appRoot, "cli.js");
  NodeFS.writeFileSync(wrapperPath, makeWrapperSource(params));
  return wrapperPath;
};

// A tiny CJS entry that prints a boot marker + the passed-through argv (argv[2..]), then returns cleanly.
const markerEntrySource = (version: string): string =>
  'console.log("BOOTED:" + ' +
  JSON.stringify(version) +
  ');\nconsole.log("ARGV:" + JSON.stringify(process.argv.slice(2)));\n';

// An entry that throws during module evaluation → the wrapper's `await import()` rejects.
const throwingEntrySource = (): string => 'throw new Error("BOOM-MARKER");\n';

interface VersionOpts {
  readonly entrySource: string;
  readonly main?: string;
  readonly engines?: Record<string, string>;
  /** Omit/blank the package.json `version` to make the dir INVALID for the fallback scan. */
  readonly packageVersion?: string | null;
}

// Lay down versions/<version>/{package.json, <main>}. Returns the entry path relative to appRoot.
const writeVersion = (appRoot: string, version: string, opts: VersionOpts): string => {
  const dir = NodePath.join(appRoot, "versions", version);
  const mainRel = opts.main ?? "cli.js";
  mkdirp(NodePath.dirname(NodePath.join(dir, mainRel)));
  const pkg: Record<string, unknown> = { name: "app", main: mainRel };
  if (opts.packageVersion !== null) pkg["version"] = opts.packageVersion ?? version;
  if (opts.engines !== undefined) pkg["engines"] = opts.engines;
  NodeFS.writeFileSync(NodePath.join(dir, "package.json"), JSON.stringify(pkg));
  NodeFS.writeFileSync(NodePath.join(dir, mainRel), opts.entrySource);
  return NodePath.join("versions", version, mainRel);
};

const writePointer = (appRoot: string, version: string, entryRel: string): void => {
  NodeFS.writeFileSync(
    NodePath.join(appRoot, "current.json"),
    JSON.stringify({ schema: 1, version, entry: entryRel.split(NodePath.sep).join("/") }),
  );
};

interface WrapperResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runWrapper = (
  wrapperPath: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<WrapperResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      process.execPath,
      [wrapperPath, ...args],
      { cwd },
      (error, stdout, stderr) => {
        const rawCode = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof rawCode === "number" ? rawCode : error === null ? 0 : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

afterEach(() => {
  for (const root of roots) {
    try {
      NodeFS.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
  roots.length = 0;
});

describe("wrapper cli.js (end-to-end on the system node)", () => {
  it("boots the pointed entry with argv passthrough and exits 0", async () => {
    const appRoot = mkTempRoot();
    const entryRel = writeVersion(appRoot, "1.2.0", { entrySource: markerEntrySource("1.2.0") });
    writePointer(appRoot, "1.2.0", entryRel);
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, ["--flag", "passed-through"], appRoot);

    assert.strictEqual(result.code, 0);
    assert.include(result.stdout, "BOOTED:1.2.0");
    // argv[2..] flows through unchanged because the entry runs in the SAME process.
    assert.include(result.stdout, '"--flag"');
    assert.include(result.stdout, '"passed-through"');
  });

  it("falls back to the newest valid versions/ dir when current.json is corrupt", async () => {
    const appRoot = mkTempRoot();
    writeVersion(appRoot, "1.0.0", { entrySource: markerEntrySource("1.0.0") });
    writeVersion(appRoot, "2.3.1", { entrySource: markerEntrySource("2.3.1") });
    NodeFS.writeFileSync(NodePath.join(appRoot, "current.json"), "\x00\x01 not json at all }{");
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 0);
    assert.include(result.stdout, "BOOTED:2.3.1");
  });

  it("falls back to the newest valid versions/ dir when current.json is missing", async () => {
    const appRoot = mkTempRoot();
    writeVersion(appRoot, "1.0.0", { entrySource: markerEntrySource("1.0.0") });
    writeVersion(appRoot, "2.3.1", { entrySource: markerEntrySource("2.3.1") });
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 0);
    assert.include(result.stdout, "BOOTED:2.3.1");
  });

  it("prints banner A with the support link and exits 1 when nothing valid is on disk", async () => {
    const appRoot = mkTempRoot();
    mkdirp(NodePath.join(appRoot, "versions")); // present but empty; no pointer
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 1);
    assert.include(result.stderr, "Переустановите");
    assert.include(result.stderr, DEFAULT_PARAMS.supportUrl);
    assert.notInclude(result.stdout, "BOOTED:");
  });

  it("prints banner B stating the required node version and exits 1 when node is too old", async () => {
    const appRoot = mkTempRoot();
    const entryRel = writeVersion(appRoot, "1.0.0", {
      entrySource: markerEntrySource("1.0.0"),
      engines: { node: ">=99" },
    });
    writePointer(appRoot, "1.0.0", entryRel);
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 1);
    assert.include(result.stderr, "Node.js");
    assert.include(result.stderr, "99");
    assert.notInclude(result.stdout, "BOOTED:");
  });

  it("prints banner A with the technical first line when the entry throws on import", async () => {
    const appRoot = mkTempRoot();
    const entryRel = writeVersion(appRoot, "1.0.0", { entrySource: throwingEntrySource() });
    writePointer(appRoot, "1.0.0", entryRel);
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 1);
    assert.include(result.stderr, "Переустановите");
    assert.include(result.stderr, "BOOM-MARKER");
  });

  it("omits the support line from banner A when supportUrl is empty", async () => {
    const appRoot = mkTempRoot();
    mkdirp(NodePath.join(appRoot, "versions"));
    const wrapper = writeWrapper(appRoot, { ...DEFAULT_PARAMS, supportUrl: "" });

    const result = await runWrapper(wrapper, [], appRoot);

    assert.strictEqual(result.code, 1);
    assert.include(result.stderr, "Переустановите");
    assert.notInclude(result.stderr, "Поддержка");
  });

  it("resolves the entry relative to appRoot, so it boots even from a different cwd", async () => {
    const appRoot = mkTempRoot();
    const entryRel = writeVersion(appRoot, "1.5.0", { entrySource: markerEntrySource("1.5.0") });
    writePointer(appRoot, "1.5.0", entryRel);
    const wrapper = writeWrapper(appRoot, DEFAULT_PARAMS);
    const otherCwd = mkTempRoot(); // an unrelated directory to launch from

    const result = await runWrapper(wrapper, [], otherCwd);

    assert.strictEqual(result.code, 0);
    assert.include(result.stdout, "BOOTED:1.5.0");
  });
});
