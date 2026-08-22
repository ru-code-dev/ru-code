// ru-code: the REAL `install` bash script, end to end, against a REAL release bundle.
//
// This is the half of the story the other integration specs assume: they start from a layout the
// harness assembled, this one starts from the artifact a release actually ships and lets the
// shipped installer lay it down. What it proves:
//   · the bundle unpacks into `<appRoot>/bin/` as a launchable install (frozen wrapper + pointer +
//     versions/<v>/payload + the PATH shim + the `.version` sentinel);
//   · the installed app BOOTS through that wrapper and serves /healthz at the pointed version;
//   · a REPAIR reinstall over a machine the in-app updater already moved forward converges back to
//     exactly the bundle's version — and does NOT touch `userdata/` (db, settings, credentials,
//     mcp tokens) or the user's shell rc beyond its single PATH line.
//
// Everything runs inside a temp sandbox: its own HOME (rc files land there), its own clone dir,
// its own app root and base dir. The real `$HOME` is never read or written.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  assert,
  assertEq,
  cleanups,
  getFreePort,
  getHealthz,
  log,
  mkTemp,
  poll,
  REPO_ROOT,
} from "./primitives.ts";
import { assembleBundle, type Layout, type Prepared, VERSION_A, VERSION_B } from "./artifacts.ts";
import { bootDaemon, readSentinel, stopDaemon } from "./daemon.ts";

/** The shipped, committed installer — the same file a user pipes into bash. */
const INSTALL_SCRIPT = NodePath.join(REPO_ROOT, "install");

/** Files a user would lose if a reinstall ever reached into `userdata/`. */
const USER_STATE_FILES = [
  "auto-update.json",
  "auto-update-credentials.enc",
  "state.sqlite",
  NodePath.join("mcp", "tokens.enc"),
] as const;

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly cloneDir: string;
  readonly appRoot: string;
  readonly binDir: string;
  readonly baseDir: string;
  readonly preflight: string;
}

/**
 * A sandbox holding the clone dir the installer bootstraps from (`./ru-code/dist-bundle/*.tgz`)
 * and a fake preflight that resolves every path INTO the sandbox — the installer's only path
 * resolver, so nothing can point at the real machine.
 */
function makeSandbox(): Sandbox {
  const root = mkTemp("ru-au-install-");
  const home = NodePath.join(root, "home");
  const cloneDir = NodePath.join(root, "ru-code");
  const appRoot = NodePath.join(root, "app", ".ru-code");
  const baseDir = NodePath.join(root, "base");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(cloneDir, "dist-bundle"), { recursive: true });
  NodeFS.mkdirSync(baseDir, { recursive: true });

  const preflight = NodePath.join(root, "fake-preflight.mjs");
  const facts = `OUR_ROOT=${appRoot}\nAPP_BIN=ru-code\nNODE_OK=1\nCHECK_NODE=ok\nCHECK_CLI=ok\nCHECK_GIT=ok\nCHECK_CLI_KIND=ok\n`;
  NodeFS.writeFileSync(preflight, `process.stdout.write(${JSON.stringify(facts)});\n`);

  return {
    root,
    home,
    cloneDir,
    appRoot,
    binDir: NodePath.join(appRoot, "bin"),
    baseDir,
    preflight,
  };
}

/**
 * Stage a real release bundle for `version` into the sandbox's dist-bundle: the launcher pair, the
 * real server payload, and the real native node_modules (tar dereferences the symlink, so the
 * archive carries them the way a shipped one does). Mirrors prepare-release's `-C staging package`.
 */
function stageBundle(prepared: Prepared, sandbox: Sandbox, version: string): string {
  const staging = NodePath.join(sandbox.root, `staging-${version}`);
  const bundleRoot = NodePath.join(staging, "package");
  NodeFS.rmSync(staging, { recursive: true, force: true });
  NodeFS.mkdirSync(bundleRoot, { recursive: true });
  // A shipped bundle always carries the built SPA, and the installer refuses an archive without it.
  // The browser layer runs with the REAL client (`prepareArtifacts({withClient:true})`); the
  // headless one has no use for it, so a one-file stand-in keeps the archive structurally honest
  // without a ~30 s web build.
  const clientDir =
    prepared.clientDir ??
    (() => {
      const stub = NodePath.join(sandbox.root, "client-stub");
      NodeFS.mkdirSync(stub, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(stub, "index.html"),
        "<!doctype html><title>stub</title>\n",
      );
      return stub;
    })();
  assembleBundle(prepared.basePayloadDir, bundleRoot, version, clientDir);
  NodeFS.symlinkSync(
    prepared.sharedNodeModules,
    NodePath.join(bundleRoot, "versions", version, "node_modules"),
    "dir",
  );
  // The installer runs the bundled preflight when RU_CODE_PREFLIGHT is unset; ship one anyway so
  // the archive is shaped exactly like a real release.
  NodeFS.copyFileSync(sandbox.preflight, NodePath.join(bundleRoot, "preflight.mjs"));

  const tarball = NodePath.join(sandbox.cloneDir, "dist-bundle", `ru-code-${version}.tgz`);
  for (const name of NodeFS.readdirSync(NodePath.dirname(tarball))) {
    if (name.endsWith(".tgz")) NodeFS.rmSync(NodePath.join(NodePath.dirname(tarball), name));
  }
  // -h dereferences the natives symlink so the tarball is self-contained, like the shipped one.
  NodeChildProcess.execFileSync("tar", ["-czhf", tarball, "-C", staging, "package"], {
    stdio: "ignore",
  });
  return tarball;
}

interface InstallRun {
  readonly status: number;
  readonly output: string;
}

/**
 * Run the installer THE WAY USERS DO — `cat ru-code/install | bash` — i.e. with the script itself
 * on bash's stdin. That is not cosmetic: everything bash launches inherits that pipe, and it closes
 * the moment the installer finishes. Handing it to the app is one of the two ways a launched app
 * died silently after a "successful" install (the other being the launch sharing the installer's
 * process group). `spawnSync(..., { input })` reproduces it exactly: stdin is a pipe, not a TTY.
 */
function runInstallerPiped(sandbox: Sandbox, env: NodeJS.ProcessEnv = {}): InstallRun {
  const script = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
  const result = NodeChildProcess.spawnSync("bash", ["-s", "--", "--keep-source"], {
    cwd: sandbox.root,
    input: script,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: sandbox.home,
      TERM: "dumb",
      RU_CODE_PREFLIGHT: sandbox.preflight,
      ...env,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Run the shipped installer from the sandbox root, with a from-scratch environment. */
function runInstaller(sandbox: Sandbox): InstallRun {
  const result = NodeChildProcess.spawnSync("bash", [INSTALL_SCRIPT, "--keep-source"], {
    cwd: sandbox.root,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: sandbox.home,
      TERM: "dumb",
      RU_CODE_PREFLIGHT: sandbox.preflight,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const readPointerAt = (binDir: string): { version: string; entry: string } | null => {
  const file = NodePath.join(binDir, "current.json");
  if (!NodeFS.existsSync(file)) return null;
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as { version: string; entry: string };
};

const listVersionsAt = (binDir: string): Array<string> => {
  const dir = NodePath.join(binDir, "versions");
  return NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir).sort() : [];
};

/** Seed the files a user must never lose, so the repair run can be checked against them. */
function seedUserState(baseDir: string): void {
  const userdata = NodePath.join(baseDir, "userdata");
  for (const relative of USER_STATE_FILES) {
    const target = NodePath.join(userdata, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, `seeded:${relative}\n`);
  }
}

function assertUserStateIntact(baseDir: string): void {
  const userdata = NodePath.join(baseDir, "userdata");
  for (const relative of USER_STATE_FILES) {
    const target = NodePath.join(userdata, relative);
    assert(NodeFS.existsSync(target), `userdata/${relative} survived the reinstall`);
    assertEq(
      NodeFS.readFileSync(target, "utf8"),
      `seeded:${relative}\n`,
      `userdata/${relative} was not rewritten`,
    );
  }
}

/**
 * Install `version` through the REAL installer into a fresh sandbox and return everything a caller
 * needs to drive the installed app: the sandbox and a `Layout` pointing at `<appRoot>/bin`.
 * This is how a suite gets an installed app WITHOUT the harness assembling the layout itself —
 * the browser acceptance cycle uses it so its click-through runs on an installer-produced tree.
 */
export function installReleaseIntoSandbox(
  prepared: Prepared,
  version: string,
): { readonly sandbox: Sandbox; readonly layout: Layout } {
  const sandbox = makeSandbox();
  cleanups.push(() => {
    NodeFS.rmSync(sandbox.root, { recursive: true, force: true });
  });
  stageBundle(prepared, sandbox, version);
  const run = runInstaller(sandbox);
  assertEq(run.status, 0, `installer exited 0 (output: ${run.output.slice(-400)})`);
  assert(
    NodeFS.existsSync(NodePath.join(sandbox.binDir, "cli.js")),
    "installer produced a launchable bin/",
  );
  // A shipped release carries the native node_modules INSIDE every version payload; the suite's
  // update tarballs are slim (one build, re-versioned) so a version landed by the updater would
  // find none. Node resolves them by walking up from `versions/<v>/cli.js`, so ONE shared dir at
  // the root of bin/ serves every version — the same shortcut `buildLayout` uses, and the only
  // difference between this tree and a production install.
  const shared = NodePath.join(sandbox.binDir, "node_modules");
  if (!NodeFS.existsSync(shared)) NodeFS.symlinkSync(prepared.sharedNodeModules, shared, "dir");
  return { sandbox, layout: { appRoot: sandbox.binDir, baseDir: sandbox.baseDir } };
}

/**
 * THE spec: install → boot → (pretend an in-app update happened) → repair reinstall → boot again.
 */
/**
 * THE regression test for "the app is actually running after install".
 *
 * It reproduces the reported field failure end to end: the documented `cat ru-code/install | bash`
 * invocation (so bash's stdin is the script pipe), the SHIPPED default for START_AFTER_INSTALL (no
 * env override — if that default is ever flipped back, this spec fails, which is the point), and a
 * real bundle. Then it asserts the installed server ANSWERS. Nothing here needs a display: the
 * browser open is best-effort and failing it must never stop the app from starting — which is
 * exactly the property that used to be unobservable, because the launch discarded stdout, stderr
 * and the exit code.
 */
export const specInstallStartsTheApp = async (prepared: Prepared): Promise<string> => {
  const sandbox = makeSandbox();
  cleanups.push(() => {
    NodeFS.rmSync(sandbox.root, { recursive: true, force: true });
  });
  stageBundle(prepared, sandbox, VERSION_A);

  const port = await getFreePort();
  const layout: Layout = { appRoot: sandbox.binDir, baseDir: sandbox.baseDir };
  const appEnv: NodeJS.ProcessEnv = {
    ...process.env,
    T3CODE_PORT: String(port),
    // The base dir is T3CODE_HOME (there is no T3CODE_BASE_DIR); the installer-launched app can
    // only be steered through the environment, since it is started with no arguments.
    T3CODE_HOME: sandbox.baseDir,
    RU_CODE_UPDATE_TEST_VERSION_FROM_DIR: "1",
  };
  // Stop whatever the installer starts, even if an assertion below throws.
  cleanups.push(async () => {
    await stopDaemon(layout, appEnv).catch(() => undefined);
  });

  const run = runInstallerPiped(sandbox, {
    T3CODE_PORT: String(port),
    T3CODE_HOME: sandbox.baseDir,
    RU_CODE_UPDATE_TEST_VERSION_FROM_DIR: "1",
  });
  assertEq(run.status, 0, `piped installer exited 0 (output: ${run.output.slice(-1200)})`);

  // The installer WAITS for the launcher's one JSON line and REPORTS the outcome, so the user is
  // told what happened instead of being left at a prompt. Two things must be on screen: the started
  // banner, and the pairing url it read out of that line — the url is the whole fallback when the
  // browser did not open (there is no display here, so that is the normal case).
  assert(
    run.output.includes("Запущено"),
    `the installer printed the started banner (output: ${run.output.slice(-1200)})`,
  );
  const launchedUrl = /(https?:\/\/\S+)/.exec(run.output.slice(run.output.indexOf("Запущено")));
  assert(
    launchedUrl !== null,
    `the started banner carries the pairing url (output: ${run.output.slice(-1200)})`,
  );

  // The server child is detached, so it outlives the installer — the proof is that it answers on
  // its own afterwards. On failure, surface what the installer said AND its log: a silent
  // "successful install that started nothing" is the exact bug this spec guards.
  const health = await poll(
    async () => {
      const sentinel = readSentinel(sandbox.baseDir);
      return await getHealthz(sentinel?.port ?? port);
    },
    { timeoutMs: 30_000, intervalMs: 300, label: "installed app answers /healthz" },
  ).catch((error: unknown) => {
    const logFile = NodePath.join(sandbox.appRoot, "install.log");
    const installLog = NodeFS.existsSync(logFile)
      ? NodeFS.readFileSync(logFile, "utf8").slice(-2000)
      : "(no install log)";
    throw new Error(
      `${String(error)}\n--- installer output ---\n${run.output.slice(-2000)}\n--- install log ---\n${installLog}`,
    );
  });
  assert(health.ok === true, "the app the INSTALLER started answers /healthz");
  assertEq(health.version, VERSION_A, "and it is the version the bundle carried");

  await stopDaemon(layout, appEnv);
  log(
    `      [install] piped install started the app on port ${readSentinel(sandbox.baseDir)?.port ?? port}`,
  );
  log(`      [install] the installer reported it: «Запущено» + ${launchedUrl?.[1] ?? "?"}`);
  return `cat install | bash → the app is RUNNING (v${VERSION_A}) with no terminal, no display, no manual start — and the installer SAID so, with the url`;
};

export const specRealInstallScript = async (prepared: Prepared): Promise<string> => {
  const sandbox = makeSandbox();
  cleanups.push(() => {
    NodeFS.rmSync(sandbox.root, { recursive: true, force: true });
  });

  // ── 1. a real bundle + the real installer ────────────────────────────────────────────────
  stageBundle(prepared, sandbox, VERSION_A);
  const first = runInstaller(sandbox);
  assertEq(first.status, 0, `installer exited 0 (output: ${first.output.slice(-1200)})`);

  // The installed tree IS the bundle: launcher pair at the root of bin/, payload under versions/.
  assert(
    NodeFS.existsSync(NodePath.join(sandbox.binDir, "cli.js")),
    "bin/cli.js (wrapper) installed",
  );
  assert(
    NodeFS.readFileSync(NodePath.join(sandbox.binDir, "cli.js"), "utf8").includes(
      "FROZEN launcher",
    ),
    "bin/cli.js is the frozen wrapper, not the app bundle",
  );
  assertEq(readPointerAt(sandbox.binDir)?.version, VERSION_A, "pointer at the bundle's version");
  assertEq(
    readPointerAt(sandbox.binDir)?.entry,
    `versions/${VERSION_A}/cli.js`,
    "pointer entry is appRoot-relative",
  );
  assertEq(
    listVersionsAt(sandbox.binDir).join(","),
    VERSION_A,
    "exactly the bundle's version on disk",
  );
  assert(
    NodeFS.existsSync(NodePath.join(sandbox.binDir, "versions", VERSION_A, "node_modules")),
    "natives landed inside the version payload",
  );
  assert(
    !NodeFS.existsSync(NodePath.join(sandbox.binDir, "preflight.mjs")),
    "install-time preflight dropped",
  );
  assert(NodeFS.existsSync(NodePath.join(sandbox.binDir, ".version")), ".version sentinel written");
  const shim = NodePath.join(sandbox.binDir, "ru-code");
  assert(NodeFS.existsSync(shim), "PATH shim written");
  assert((NodeFS.statSync(shim).mode & 0o111) !== 0, "PATH shim is executable");
  assert(
    NodeFS.readFileSync(shim, "utf8").includes("cli.js"),
    "the shim launches the wrapper, not a version dir",
  );

  // ── 2. the installed app boots through the wrapper ───────────────────────────────────────
  const layout: Layout = { appRoot: sandbox.binDir, baseDir: sandbox.baseDir };
  const env: NodeJS.ProcessEnv = { ...process.env, RU_CODE_UPDATE_TEST_VERSION_FROM_DIR: "1" };
  const boot = await bootDaemon(layout, env, VERSION_A);
  assert(boot.health.ok === true, "installed app answers /healthz");
  await stopDaemon(layout, env);
  seedUserState(sandbox.baseDir);

  // ── 3. a machine the in-app updater already moved to B, then a REPAIR reinstall ──────────
  const strayVersionDir = NodePath.join(sandbox.binDir, "versions", VERSION_B);
  NodeFS.mkdirSync(strayVersionDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(strayVersionDir, "cli.js"), "// left behind by an update\n");
  NodeFS.writeFileSync(
    NodePath.join(sandbox.binDir, "current.json"),
    JSON.stringify({ schema: 1, version: VERSION_B, entry: `versions/${VERSION_B}/cli.js` }),
  );

  const repair = runInstaller(sandbox);
  assertEq(repair.status, 0, `repair install exited 0 (output: ${repair.output.slice(-400)})`);
  assertEq(readPointerAt(sandbox.binDir)?.version, VERSION_A, "repair pointed back at the bundle");
  assertEq(
    listVersionsAt(sandbox.binDir).join(","),
    VERSION_A,
    "repair left exactly the bundle's version — no orphan version dirs",
  );
  assertUserStateIntact(sandbox.baseDir);

  // ── 4. and it still boots afterwards ─────────────────────────────────────────────────────
  const rebooted = await bootDaemon(layout, env, VERSION_A);
  const health = await getHealthz(rebooted.port);
  assert(health !== null && health.ok, "repaired install serves /healthz");
  await stopDaemon(layout, env);

  // The rc line is written once, no matter how many times the installer runs.
  const bashrc = NodePath.join(sandbox.home, ".bashrc");
  const pathLines = NodeFS.existsSync(bashrc)
    ? NodeFS.readFileSync(bashrc, "utf8")
        .split("\n")
        .filter((line) => line.includes(sandbox.binDir)).length
    : 0;
  assertEq(pathLines, 1, "exactly one PATH line after two installs");

  log(`      [install] bin=${sandbox.binDir}`);
  return `install → boot v${VERSION_A} → repair over a stray v${VERSION_B} → boot again; userdata + single PATH line intact`;
};
