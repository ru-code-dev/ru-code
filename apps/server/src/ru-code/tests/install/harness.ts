// @effect-diagnostics nodeBuiltinImport:off - install-flow: the installer under test is a bash
// script; this harness drives it in fully-sandboxed bash subprocesses. No Effect services here.
//
// ru-code: SAFETY-CRITICAL test harness for the standalone `install` bash script. That script
// scrubs shell rc files, removes bin/app/legacy directories, and deletes the clone dir — so
// EVERY run here is hermetically sandboxed:
//   • HOME is a throwaway temp dir (rc files land there, never the real ~).
//   • The install root, the clone dir, and any "legacy" dir all live UNDER that temp dir.
//   • All path/name resolution comes from a FAKE preflight we inject via RU_CODE_PREFLIGHT,
//     so nothing is ever resolved against the real machine.
//   • The subprocess env is built from scratch (PATH/HOME/TERM only) — the real environment
//     is not inherited.
// Nothing here can point at the real repo, the real $HOME, or this worktree. The one seam the
// script exposes for us is RU_CODE_INSTALL_NO_MAIN=1 (source the functions without running main).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// ru-code: the shipping layout contract — same modules the release build and the updater use, so a
// fake bundle can never drift from a real one.
import { VERSION_ENTRY_FILENAME } from "../../auto-update/apply/fetchVersion.ts";
import { VERSIONS_DIRNAME } from "../../auto-update/apply/gc.ts";
import { makePointer, POINTER_FILENAME } from "../../auto-update/apply/pointer.ts";
import {
  WRAPPER_FILENAME,
  WRAPPER_PACKAGE_FILENAME,
  wrapperPackageSource,
} from "../../auto-update/wrapper/installLayout.ts";
import { makeWrapperSource } from "../../auto-update/wrapper/wrapperSource.ts";

/** Absolute path to the installer under test — the repo root of this worktree. */
export const INSTALL_SCRIPT = NodePath.resolve(import.meta.dirname, "../../../../../..", "install");

const SANDBOX_PREFIX = "ru-code-install-test-";
const REAL_TMP = NodeFS.realpathSync(NodeOS.tmpdir());

/** Guard: only ever recursively delete a path that is provably a sandbox under the OS temp dir. */
function assertSandboxPath(target: string): void {
  const resolved = NodePath.resolve(target);
  if (!resolved.startsWith(REAL_TMP + NodePath.sep) || !resolved.includes(SANDBOX_PREFIX)) {
    throw new Error(`refusing to remove non-sandbox path: ${resolved}`);
  }
}

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout + stderr — the installer sends all human output to stderr. */
  readonly all: string;
}

export interface Sandbox {
  /** Isolated root; everything a run may touch lives under here. */
  readonly root: string;
  /** Fake $HOME — rc files land here. */
  readonly home: string;
  /** The clone dir the installer runs from (basename == REPO_NAME "ru-code"); also SOURCE_DIR. */
  readonly cloneDir: string;
  /** Where a fake release tarball lives — cloneDir/dist-bundle. */
  readonly distBundleDir: string;
  /** Default OUR_ROOT the fake preflight reports (the sandbox app root, basename ".ru-code"). */
  readonly appRoot: string;
  path(...segs: string[]): string;
  read(rel: string): string;
  exists(rel: string): boolean;
  write(rel: string, content: string, mode?: number): void;
  cleanup(): void;
}

/**
 * Wait (bounded, busy-poll) for a file the installer's launch writes. The installer waits for the
 * launcher's JSON line, but the app it starts outlives it by design (the server child is detached),
 * so a bare `exists()` right after bash exits is a race, not an assertion.
 */
export function waitForFile(sandbox: Sandbox, rel: string, timeoutMs = 5_000): boolean {
  const STEP_MS = 25;
  const attempts = Math.max(1, Math.ceil(timeoutMs / STEP_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (sandbox.exists(rel)) return true;
    // Synchronous sleep: this harness drives a real bash process, there is no event loop to yield
    // to, and a fixed step keeps it off the wall clock (Effect's globalDate diagnostic).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STEP_MS);
  }
  return sandbox.exists(rel);
}

export function makeSandbox(): Sandbox {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), SANDBOX_PREFIX)),
  );
  const home = NodePath.join(root, "home");
  const cloneDir = NodePath.join(root, "ru-code");
  const distBundleDir = NodePath.join(cloneDir, "dist-bundle");
  const appRoot = NodePath.join(root, "app", ".ru-code");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(distBundleDir, { recursive: true });

  const abs = (rel: string): string => NodePath.join(root, rel);
  return {
    root,
    home,
    cloneDir,
    distBundleDir,
    appRoot,
    path: (...segs) => NodePath.join(root, ...segs),
    read: (rel) => NodeFS.readFileSync(abs(rel), "utf8"),
    exists: (rel) => NodeFS.existsSync(abs(rel)),
    write: (rel, content, mode) => {
      NodeFS.mkdirSync(NodePath.dirname(abs(rel)), { recursive: true });
      NodeFS.writeFileSync(abs(rel), content, mode === undefined ? undefined : { mode });
    },
    cleanup: () => {
      assertSandboxPath(root);
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Curated, from-scratch env — the real environment is never inherited. */
function baseEnv(sandbox: Sandbox, extra?: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sandbox.home,
    TERM: "dumb", // deterministic: no TTY, so the installer emits plain (color-free) output
    ...extra,
  };
}

function toResult(res: NodeChildProcess.SpawnSyncReturns<string>): RunResult {
  if (res.error) throw res.error;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return {
    status: res.status ?? (res.signal ? 128 : -1),
    stdout,
    stderr,
    all: stdout + stderr,
  };
}

/** Single-quote a value for safe interpolation into a bash snippet. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * BLACK-BOX: run the real installer end-to-end (main executes). cwd is the sandbox root, so
 * the script's `./ru-code` clone-dir lookup resolves to sandbox.cloneDir.
 */
export function runInstaller(
  sandbox: Sandbox,
  opts: {
    readonly args?: readonly string[];
    readonly env?: Record<string, string>;
    readonly preflight?: string;
  } = {},
): RunResult {
  const env = baseEnv(sandbox, {
    ...(opts.preflight ? { RU_CODE_PREFLIGHT: opts.preflight } : {}),
    ...opts.env,
  });
  return toResult(
    NodeChildProcess.spawnSync("bash", [INSTALL_SCRIPT, ...(opts.args ?? [])], {
      cwd: sandbox.root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
}

/**
 * WHITE-BOX: source the installer (functions only, no main) then run `body`. Errexit/nounset/
 * pipefail are relaxed AFTER sourcing so the test body can capture exit codes; the sourced
 * function definitions are unchanged. `globals` are assigned before the body (installer state
 * vars like OS / APP_DIR_NAME / BIN_DIR). Runs in its own subprocess — a `die` (exit 1) inside
 * a function surfaces as this call's `status`, killing nothing real.
 */
export function sourceEval(
  sandbox: Sandbox,
  body: string,
  opts: { readonly env?: Record<string, string>; readonly globals?: Record<string, string> } = {},
): RunResult {
  const globalsInit = Object.entries(opts.globals ?? {})
    .map(([key, value]) => `${key}=${shq(value)}`)
    .join("\n");
  const snippet = [
    `export RU_CODE_INSTALL_NO_MAIN=1`,
    `source ${shq(INSTALL_SCRIPT)}`,
    `set +e +u +o pipefail`,
    globalsInit,
    body,
  ].join("\n");
  return toResult(
    NodeChildProcess.spawnSync("bash", ["-c", snippet], {
      cwd: sandbox.root,
      env: baseEnv(sandbox, opts.env),
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
}

/**
 * Write a fake preflight.mjs that prints the given KEY=VALUE lines to stdout and a report to
 * stderr, then exits `status`. This is the installer's sole path/name resolver — the fake keeps
 * every resolved path inside the sandbox. Returns its absolute path (pass as `preflight`).
 */
export function writeFakePreflight(
  sandbox: Sandbox,
  opts: {
    readonly ourRoot?: string;
    readonly appBin?: string;
    readonly nodeOk?: string;
    readonly legacyRoot?: string;
    /** qwen bin path emitted as CLI_JS (drives the warm-up). Omitted → CLI_JS not emitted. */
    readonly cliJs?: string;
    /** HOW the warm-up runs CLI_JS, emitted as CLI_SPAWN_KIND. Omitted → not emitted (≡node). */
    readonly cliSpawnKind?: "node" | "cmd" | "direct";
    /** Package-identity value emitted as CLI_IDENTITY (exported into the warm-up env). */
    readonly cliIdentity?: string;
    /** qwen profile dir emitted as CONFIG_DIR (the warm-up target). */
    readonly configDir?: string;
    /** Linux-relocation alternative profile dir emitted as CONFIG_DIR_ALT. */
    readonly configDirAlt?: string;
    readonly status?: number;
    readonly report?: string;
    readonly emitKeys?: boolean;
    /** Per-check facts. checkNode defaults to nodeOk ("1"→ok); git/cli default "ok". */
    readonly checkNode?: "ok" | "fail";
    readonly checkGit?: "ok" | "fail";
    readonly checkCli?: "ok" | "fail";
    /** CLI-engine kind: missing (→cli-install) / old (→cli-update) / broken (→cli-broken) /
     * slow (→cli-slow). Defaults from checkCli. */
    readonly checkCliKind?: "ok" | "old" | "missing" | "broken" | "slow";
  } = {},
): string {
  const emit = opts.emitKeys ?? true;
  const nodeOk = opts.nodeOk ?? "1";
  const lines: string[] = [];
  if (emit) {
    lines.push(`OUR_ROOT=${opts.ourRoot ?? sandbox.appRoot}`);
    lines.push(`APP_BIN=${opts.appBin ?? "ru-code"}`);
    lines.push(`NODE_OK=${nodeOk}`);
    if (opts.cliJs !== undefined) lines.push(`CLI_JS=${opts.cliJs}`);
    if (opts.cliSpawnKind !== undefined) lines.push(`CLI_SPAWN_KIND=${opts.cliSpawnKind}`);
    if (opts.cliIdentity !== undefined) lines.push(`CLI_IDENTITY=${opts.cliIdentity}`);
    if (opts.configDir !== undefined) lines.push(`CONFIG_DIR=${opts.configDir}`);
    if (opts.configDirAlt !== undefined) lines.push(`CONFIG_DIR_ALT=${opts.configDirAlt}`);
    if (opts.legacyRoot !== undefined) lines.push(`LEGACY_ROOT=${opts.legacyRoot}`);
    lines.push(`CHECK_NODE=${opts.checkNode ?? (nodeOk === "1" ? "ok" : "fail")}`);
    lines.push(`CHECK_CLI=${opts.checkCli ?? "ok"}`);
    lines.push(`CHECK_GIT=${opts.checkGit ?? "ok"}`);
    lines.push(`CHECK_CLI_KIND=${opts.checkCliKind ?? (opts.checkCli === "fail" ? "old" : "ok")}`);
  }
  const stdout = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const js =
    `process.stderr.write(${JSON.stringify(opts.report ?? "[preflight] ok\n")});\n` +
    `process.stdout.write(${JSON.stringify(stdout)});\n` +
    `process.exit(${opts.status ?? 0});\n`;
  const target = NodePath.join(sandbox.root, "fake-preflight.mjs");
  NodeFS.writeFileSync(target, js);
  return target;
}

/**
 * Build a fake release tarball into cloneDir/dist-bundle — in the SHIPPING layout: the archive is
 * the installed `bin/` tree (REAL frozen wrapper + pointer + `versions/<version>/<payload>` +
 * root-level preflight). The wrapper is the production emitter (`makeWrapperSource`), so these runs
 * exercise the real launcher; only the payload's `cli.js` is a fake that answers `--version`
 * (exit `cliVersionExit`), `stop` (exit 0) and records a no-arg launch.
 *
 * `missingPart` drops a member to exercise validate_archive: it is resolved against the version
 * payload first (`client`, `node_modules`, `package.json`, `cli.js`), then against the archive root
 * (`current.json`, the wrapper) — so a caller just names the part.
 */
export function writeFakeRelease(
  sandbox: Sandbox,
  opts: {
    readonly version?: string;
    readonly name?: string;
    readonly cliVersionExit?: number;
    readonly missingPart?: string;
    /**
     * Replace the version payload's `cli.js` ENTIRELY. The launch tests ship a fake that speaks the
     * `--json` launch contract; it must still answer `--version` (verify_app / read_installed_version)
     * and `stop`. `cliVersionExit` is ignored when this is set — the script owns every branch.
     */
    readonly cliScript?: string;
  } = {},
): string {
  const version = opts.version ?? "1.0.0";
  const staging = NodePath.join(sandbox.root, `staging-${version}`);
  NodeFS.rmSync(staging, { recursive: true, force: true });
  NodeFS.mkdirSync(staging, { recursive: true });
  const payload = NodePath.join(staging, VERSIONS_DIRNAME, version);
  NodeFS.mkdirSync(payload, { recursive: true });

  const cliExit = opts.cliVersionExit ?? 0;
  const defaultCli =
    `const a = process.argv[2];\n` +
    // Mirror the REAL app CLI: Effect's `--version` prints `<name> v<version>` (e.g. "ru-code v1.1.2"),
    // NOT a bare version. The installer must extract the bare semver from this (read_installed_version).
    `if (a === "--version") { process.stdout.write("ru-code v" + ${JSON.stringify(version)} + "\\n"); process.exit(${cliExit}); }\n` +
    `if (a === "stop") { process.exit(0); }\n` +
    // A launch (no args = a fresh-install daemon launch; `--no-browser` = the update relaunch,
    // which must NOT open a tab because one is already open). The marker records the ARGS and
    // whether stdin was a TTY, so a spec can assert both the flag and the detachment.
    `if (a !== "--version" && process.env.RU_CODE_TEST_MARKER) {\n` +
    `  require("node:fs").writeFileSync(\n` +
    `    process.env.RU_CODE_TEST_MARKER,\n` +
    `    "started args=" + process.argv.slice(2).join(" ") + " tty=" + String(Boolean(process.stdin.isTTY)) + "\\n",\n` +
    `  );\n` +
    `}\n` +
    `process.exit(0);\n`;
  NodeFS.writeFileSync(
    NodePath.join(payload, VERSION_ENTRY_FILENAME),
    opts.cliScript ?? defaultCli,
  );
  NodeFS.writeFileSync(
    NodePath.join(payload, "package.json"),
    `${JSON.stringify({ name: "ru-code", version })}\n`,
  );
  NodeFS.mkdirSync(NodePath.join(payload, "client"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(payload, "client", "index.html"), "<html></html>\n");
  NodeFS.mkdirSync(NodePath.join(payload, "node_modules"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(payload, "node_modules", ".keep"), "");
  NodeFS.writeFileSync(NodePath.join(payload, "runtime.mjs"), "// bundled sidecar\n");

  // The REAL frozen launcher + the REAL pointer shape — same emitters the release build uses.
  NodeFS.writeFileSync(
    NodePath.join(staging, WRAPPER_FILENAME),
    makeWrapperSource({ appName: "Ru Code", appCommand: "ru-code", supportUrl: "" }),
  );
  // The wrapper's module declaration ships beside it — a fake bundle that omitted it would let a
  // regression back into the real one unnoticed.
  NodeFS.writeFileSync(NodePath.join(staging, WRAPPER_PACKAGE_FILENAME), wrapperPackageSource());
  NodeFS.writeFileSync(
    NodePath.join(staging, POINTER_FILENAME),
    `${JSON.stringify(
      makePointer(version, `${VERSIONS_DIRNAME}/${version}/${VERSION_ENTRY_FILENAME}`),
      null,
      2,
    )}\n`,
  );
  // The install-time preflight ships INSIDE the bundle now — the installer extracts it and runs it
  // when no RU_CODE_PREFLIGHT override is set. This default emits sandbox paths + all-ok checks.
  const bundledPreflight =
    `OUR_ROOT=${sandbox.appRoot}\nAPP_BIN=ru-code\nNODE_OK=1\n` +
    `CHECK_NODE=ok\nCHECK_CLI=ok\nCHECK_GIT=ok\nCHECK_CLI_KIND=ok\n`;
  NodeFS.writeFileSync(
    NodePath.join(staging, "preflight.mjs"),
    `process.stdout.write(${JSON.stringify(bundledPreflight)});\nprocess.exit(0);\n`,
  );

  if (opts.missingPart) {
    const inPayload = NodePath.join(payload, opts.missingPart);
    const target = NodeFS.existsSync(inPayload)
      ? inPayload
      : NodePath.join(staging, opts.missingPart);
    NodeFS.rmSync(target, { recursive: true, force: true });
  }

  const parts = NodeFS.readdirSync(staging);
  const tarball = NodePath.join(sandbox.distBundleDir, `${opts.name ?? "ru-code"}-${version}.tgz`);
  NodeChildProcess.execFileSync("tar", ["-czf", tarball, "-C", staging, ...parts]);
  return tarball;
}

/**
 * Create a dir of executable shims and return its path — prepend to PATH via env to override
 * `uname` / `git` / etc. Each value becomes a script (a `#!` line is added if absent).
 */
export function makeShimDir(sandbox: Sandbox, shims: Record<string, string>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(sandbox.root, "shim-"));
  for (const [name, script] of Object.entries(shims)) {
    const body = script.startsWith("#!") ? script : `#!/usr/bin/env bash\n${script}`;
    NodeFS.writeFileSync(NodePath.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

/** PATH with `dir` prepended (for shim override). */
export function pathWith(dir: string): string {
  return `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

/** The installer's $HOME log (default location), or "" if absent. */
export function readLog(sandbox: Sandbox): string {
  return sandbox.exists("home/.ru-code-install.log")
    ? sandbox.read("home/.ru-code-install.log")
    : "";
}
