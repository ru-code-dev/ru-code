// ru-code: globalSetup — boots the REAL app (server + web via scripts/dev-runner.ts)
// with the fake ACP as the qwen CLI and a fully isolated HOME/T3CODE_HOME. The
// resolved web URL + pids land in .artifacts/harness-state.json for the specs.
//
// Isolation contract (all verified in source):
//  - HOME=<tmp>/home with `.qwen/bin/cli.js` stub → preflight detection passes
//    ("standard" source needs `{home}/.qwen` dir + `bin/cli.js` file,
//    apps/server/src/ru-code/preflight/common/resolve.ts:91-132); the ACTUAL spawn
//    uses the RU_CODE_CLI_JS override (apps/server/src/cli/config.ts:419).
//  - cliConfigDir therefore = <tmp>/home/.qwen — the SAME base the transcript
//    reader uses, so the fake's JSONL lands where the extended view tails.
//  - T3CODE_HOME=<tmp>/t3home → app state (projects/threads/settings) isolated.
//  - The repo itself is the bootstrapped project (--auto-bootstrap-project-from-cwd,
//    runner cwd = repo root): a real git repo, zero onboarding UI to script.
//  - Fake behaviour knobs are read per-spawn from RU_CODE_FAKE_CONTROL_FILE (JSON),
//    so each spec can rewrite them without rebooting the app.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const ARTIFACTS_DIR = NodePath.join(import.meta.dirname, "../.artifacts");
const STATE_FILE = NodePath.join(ARTIFACTS_DIR, "harness-state.json");
const FAKE_ACP_ENTRY = NodePath.join(
  REPO_ROOT,
  "apps/server/src/ru-code/tests/qwen/fake-acp/fake-acp-server.ts",
);
// ru-code: the mock WEB update source the auto-update specs drive (see mockUpdateServer.ts).
const MOCK_UPDATE_ENTRY = NodePath.join(import.meta.dirname, "mockUpdateServer.ts");

const BOOT_TIMEOUT_MS = 240_000;
// Any port — the fetch-until-200 probe below is the real readiness gate.
const WEB_URL_PATTERN = /https?:\/\/localhost:(\d+)/;
// ru-code: the dev-runner logs `serverPort=<n>` — the SERVER (not the vite web
// port) is where /healthz lives; the auto-update specs fetch it there.
const SERVER_PORT_PATTERN = /serverPort=(\d+)/;
// ru-code: the version the mock update source advertises — strictly newer than the
// baked apps/server package.json version so `checkNow` yields an `available` hero.
const NEWER_VERSION = "999.0.0";

export interface HarnessState {
  readonly webUrl: string;
  readonly runnerPid: number;
  readonly tmpRoot: string;
  readonly homeDir: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
  readonly projectCwd: string;
  readonly transcriptFile: string;
  // ── ru-code: auto-update harness facts ──────────────────────────────────────
  /** Origin of the SERVER process (where /healthz lives) — distinct from webUrl (vite). */
  readonly serverUrl: string;
  /** The sandbox install layout root (RU_CODE_APP_ROOT); the install spec asserts current.json/journal here. */
  readonly appRoot: string;
  /** The baked (current) server version + the newer version the mock advertises. */
  readonly currentVersion: string;
  readonly newerVersion: string;
  /** The mock update server: control file (behaviour switch), requests file (counter), origin, pid. */
  readonly mockControlFile: string;
  readonly mockRequestsFile: string;
  readonly mockUrl: string;
  readonly mockServerPid: number;
  /** Candidate paths of the server-runtime sentinel ({host,port,pid}) — the #42 server-pid seam. */
  readonly serverStatePaths: ReadonlyArray<string>;
}

/** qwen utils/paths.ts sanitizeCwd (linux branch) — mirrors chatsPath.ts. */
const sanitizeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export default async function bootApp(): Promise<void> {
  NodeFS.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Vite's dep-optimizer hash is lockfile-keyed, NOT content-keyed — a rebuilt
  // @smart-tools package dist (or a patched node_modules dep) would be served
  // STALE from the cache. Every boot starts from a clean optimizer cache.
  NodeFS.rmSync(NodePath.join(REPO_ROOT, "apps/web/node_modules/.vite"), {
    recursive: true,
    force: true,
  });

  const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-e2e-"));
  const homeDir = NodePath.join(tmpRoot, "home");
  const t3Home = NodePath.join(tmpRoot, "t3home");
  const cliConfigDir = NodePath.join(homeDir, ".qwen");
  const controlFile = NodePath.join(tmpRoot, "fake-control.json");
  NodeFS.mkdirSync(NodePath.join(cliConfigDir, "bin"), { recursive: true });
  NodeFS.mkdirSync(t3Home, { recursive: true });
  // Detection stub only — never executed (RU_CODE_CLI_JS wins the spawn).
  NodeFS.writeFileSync(NodePath.join(cliConfigDir, "bin", "cli.js"), "// e2e detection stub\n");
  NodeFS.writeFileSync(controlFile, JSON.stringify({ delayMs: 0, historyTurns: 0 }));

  // ── ru-code: auto-update harness seams ────────────────────────────────────────
  const autoUpdate = setUpAutoUpdateHarness(tmpRoot, t3Home);

  const projectCwd = REPO_ROOT;
  const transcriptFile = NodePath.join(
    cliConfigDir,
    "projects",
    sanitizeCwd(projectCwd),
    "chats",
    "fake-acp-session.jsonl",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    T3CODE_HOME: t3Home,
    RU_CODE_CLI_JS: FAKE_ACP_ENTRY,
    RU_CODE_FAKE_ACP: "FLOW",
    RU_CODE_FAKE_CONTROL_FILE: controlFile,
    RU_CODE_FAKE_CLI_CONFIG_DIR: cliConfigDir,
    // ru-code: opt into the pre-made starter project (branding default is off) so the
    // harness has a workspace to drive; production leaves RU_CODE_CREATE_STARTER_PROJECT unset.
    RU_CODE_CREATE_STARTER_PROJECT: "1",
    T3CODE_NO_BROWSER: "1",
    // Debug logging — the qwen detection/spawn lines are logDebug; the boot log
    // is the primary diagnostic artifact of this harness.
    T3CODE_LOG_LEVEL: "Debug",
    // Warm pool OFF while the harness stabilizes (pool replacement-spawn
    // interferes with the bound child's reader — investigate separately).
    RU_CODE_WARM_ENGINE: "0",
    RU_CODE_ACP_PROTOCOL_LOG: "1",
    RU_CODE_FAKE_LOG_FILE: NodePath.join(ARTIFACTS_DIR, "fake-acp.log"),
    TZ: "UTC",
    // ru-code: auto-update engine test seams (updateEngineLive.ts:114-130 + envFacts.ts).
    //  · RU_CODE_APP_ROOT makes the running layout `updatable` (install is allowed) and
    //    points the pointer/journal/versions at the sandbox the install spec inspects.
    //  · RU_CODE_UPDATE_WEB_URL redirects the WEB source at the mock server; the GIT
    //    source is pointed at a closed port so it renders (a second card, for the
    //    DOM-order assert) yet fails fast every check and never wins the release verdict.
    //  · RU_CODE_UPDATE_TEST_NO_RELAUNCH makes the install run stop at the `restart`
    //    phase — the dev server must NEVER actually SIGTERM/relaunch mid-suite.
    RU_CODE_APP_ROOT: autoUpdate.appRoot,
    RU_CODE_UPDATE_WEB_URL: autoUpdate.mockUrl,
    RU_CODE_UPDATE_GIT_URL: "http://127.0.0.1:59999/repo.git",
    RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
  };

  const runner = NodeChildProcess.spawn(
    "node",
    [
      "scripts/dev-runner.ts",
      "dev",
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      // ru-code e2e: per-boot server state — fresh DB => pristine bootstrap thread, no cross-run session bindings.
      "--home-dir",
      NodePath.join(tmpRoot, "base"),
    ],
    { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  const logPath = NodePath.join(ARTIFACTS_DIR, "app-boot.log");
  const logStream = NodeFS.createWriteStream(logPath);
  let output = "";
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    logStream.write(text);
  };
  runner.stdout?.on("data", onChunk);
  runner.stderr?.on("data", onChunk);

  const webUrl = await new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const match = WEB_URL_PATTERN.exec(output);
      if (match) {
        clearInterval(poll);
        resolve(match[0]);
        return;
      }
      if (runner.exitCode !== null) {
        clearInterval(poll);
        reject(
          new Error(
            `dev runner exited (${runner.exitCode}) before a web URL appeared — see ${logPath}`,
          ),
        );
        return;
      }
      if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
        clearInterval(poll);
        reject(new Error(`no web URL within ${BOOT_TIMEOUT_MS}ms — see ${logPath}`));
      }
    }, 250);
  });

  // Wait until the web dev server actually serves HTML.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(webUrl);
      if (response.ok) break;
    } catch {
      // still starting
    }
    if (Date.now() > deadline) {
      throw new Error(`web server at ${webUrl} never became ready — see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Pair once with the one-time token the runner prints; the session cookie
  // lands in auth.json (playwright storageState) for every spec's context. The
  // pairing line can lag behind web readiness (server boots slower than vite) —
  // poll for it.
  const pairingDeadline = Date.now() + BOOT_TIMEOUT_MS;
  let pairingMatch: RegExpExecArray | null = null;
  for (;;) {
    pairingMatch = /pairingUrl:\s*(\S+)/.exec(output);
    if (pairingMatch) break;
    if (Date.now() > pairingDeadline) {
      throw new Error(`no pairingUrl in runner output — see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // RETRY the navigation until the app actually serves it. This boot wipes
    // `apps/web/node_modules/.vite` on purpose (the dep-optimizer hash is lockfile-keyed, not
    // content-keyed, so a rebuilt dist would otherwise be served stale), which means the first
    // navigation of every run races a COLD dependency optimize. Vite does not answer until that
    // finishes, and on a loaded machine it can outlast any single navigation timeout — one long
    // `goto` then fails the entire run before a single spec has executed, with a timeout as the
    // only clue.
    //
    // A retry loop waits for the FACT (the page was served) instead of betting on a duration: it
    // returns the moment vite is ready, and its ceiling only has to exceed the worst cold optimize.
    const navigationDeadline = Date.now() + 240_000;
    for (;;) {
      const navigated = await page
        .goto(pairingMatch[1]!, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (navigated) break;
      if (Date.now() > navigationDeadline) {
        throw new Error(
          `the web client never served ${pairingMatch[1]!} — see ${logPath} (vite dep optimize?)`,
        );
      }
    }
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    // WAIT FOR THE APP TO BE LIVE, then capture. This was a 2 s `waitForTimeout`, and what it
    // guards is the reason every spec in the run exists: if it under-waits, `auth.json` is
    // captured before the environment registration is written and every spec fails with «нет
    // подключения».
    //
    // The predicate is the composer being on screen — the same one `smoke.e2e.test.ts` uses to
    // mean "the SPA booted and its environment connection came up". It is the app's own signal
    // that registration has happened, rather than a guess at which IndexedDB store gets a row
    // first (an earlier attempt polled that directly and returned true too soon — the database
    // exists before the registration lands in it, so the capture raced exactly as the sleep did).
    await page
      .locator("div[contenteditable=true]")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    // CRITICAL: the environment-connection registration lives in IndexedDB
    // (apps/web/src/connection/storage.ts) — without indexedDB:true the spec
    // contexts pair fine but the env supervisor has no registration and every
    // env RPC fails with «нет подключения».
    await context.storageState({
      path: NodePath.join(ARTIFACTS_DIR, "auth.json"),
      indexedDB: true,
    });
    // TEST ISOLATION: the boot page lands on the root draft wizard, which
    // persists a composer-draft session into localStorage. Every spec context
    // restores THIS snapshot — once one spec promotes that shared draft into a
    // real thread, the app in every later spec sees a stale draft whose
    // threadId is an existing started thread and REDIRECTS into it
    // (useNewThreadHandler reuse + the draft route's inferred-promotion nav),
    // so all sends silently pile into the first spec's thread. Strip the draft
    // store from the snapshot; each spec then starts draft-clean and the root
    // wizard mints a genuinely fresh draft.
    // + browser-history: upstream's visit-restore would funnel every spec
    // into the boot browser's last thread.
    const authPath = NodePath.join(ARTIFACTS_DIR, "auth.json");
    const snapshot = JSON.parse(NodeFS.readFileSync(authPath, "utf8")) as {
      origins?: Array<{ localStorage?: Array<{ name: string }> }>;
    };
    for (const origin of snapshot.origins ?? []) {
      origin.localStorage = origin.localStorage?.filter(
        (entry) =>
          entry.name !== "ruCode:composer-drafts:v1" && entry.name !== "ruCode:browser-history:v1",
      );
    }
    NodeFS.writeFileSync(authPath, JSON.stringify(snapshot, null, 2));
  } finally {
    await browser.close();
  }

  // ru-code: the SERVER port (where /healthz lives) — the dev-runner logs it well
  // before vite prints the web URL, so it is already in `output` by now.
  const serverPortMatch = SERVER_PORT_PATTERN.exec(output);
  const serverUrl = serverPortMatch !== null ? `http://localhost:${serverPortMatch[1]}` : "";

  const state: HarnessState = {
    webUrl,
    runnerPid: runner.pid ?? -1,
    tmpRoot,
    homeDir,
    cliConfigDir,
    controlFile,
    projectCwd,
    transcriptFile,
    serverUrl,
    appRoot: autoUpdate.appRoot,
    currentVersion: autoUpdate.currentVersion,
    newerVersion: NEWER_VERSION,
    mockControlFile: autoUpdate.mockControlFile,
    mockRequestsFile: autoUpdate.mockRequestsFile,
    mockUrl: autoUpdate.mockUrl,
    mockServerPid: autoUpdate.mockServerPid,
    serverStatePaths: autoUpdate.serverStatePaths,
  };
  NodeFS.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // Keep the runner alive past globalSetup: unref so the setup process can exit.
  runner.unref();
  runner.stdout?.unref?.();
  runner.stderr?.unref?.();
}

// ── ru-code: auto-update harness setup ─────────────────────────────────────────

interface AutoUpdateHarness {
  readonly appRoot: string;
  readonly currentVersion: string;
  readonly mockControlFile: string;
  readonly mockRequestsFile: string;
  readonly mockUrl: string;
  readonly mockServerPid: number;
  readonly serverStatePaths: ReadonlyArray<string>;
}

/**
 * Build the auto-update fixtures the specs drive, all off the SAME temp isolation
 * root as the rest of the harness:
 *   1. a real installed layout under `<tmpRoot>/app-root` (current.json + a
 *      versions/<currentVersion>/cli.js stub) so RU_CODE_APP_ROOT resolves to an
 *      updatable layout the install spec can inspect;
 *   2. a real release tarball (cli.js + __checksums.json) — mirrors the fixture in
 *      updateEngineLive.test.ts — plus its sha256 baked into the mock's control file;
 *   3. the mock WEB update server, started on a free port BEFORE the app so its URL
 *      can be wired into RU_CODE_UPDATE_WEB_URL;
 *   4. a seeded auto-update.json with `autoCheck: false` written to BOTH candidate
 *      state dirs (userdata / dev), so the hourly scheduler never fires an
 *      autonomous tick mid-suite (every check in a spec is an explicit user action).
 */
function setUpAutoUpdateHarness(tmpRoot: string, t3Home: string): AutoUpdateHarness {
  const currentVersion = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/server/package.json"), "utf8"),
  ).version as string;

  // 1. the installed layout sandbox (RU_CODE_APP_ROOT).
  const appRoot = NodePath.join(tmpRoot, "app-root");
  const versionDir = NodePath.join(appRoot, "versions", currentVersion);
  NodeFS.mkdirSync(versionDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(appRoot, "updates"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(versionDir, "cli.js"), "// e2e current version stub\n");
  NodeFS.writeFileSync(
    NodePath.join(appRoot, "current.json"),
    JSON.stringify({
      schema: 1,
      version: currentVersion,
      entry: `versions/${currentVersion}/cli.js`,
    }),
  );

  // 2. the release tarball (cli.js + __checksums.json) + its sha256.
  const tarballFile = NodePath.join(tmpRoot, "release.tgz");
  const sha256 = buildReleaseTarball(tmpRoot, tarballFile);
  const sizeBytes = NodeFS.statSync(tarballFile).size;

  // 3. the mock update server (control-file driven; default mode = notfound).
  const mockControlFile = NodePath.join(tmpRoot, "mock-update-control.json");
  const mockRequestsFile = NodePath.join(tmpRoot, "mock-update-requests.json");
  const mockPortFile = NodePath.join(tmpRoot, "mock-update-port.txt");
  NodeFS.writeFileSync(
    mockControlFile,
    JSON.stringify({
      mode: "notfound",
      version: NEWER_VERSION,
      sha256,
      sizeBytes,
      minNode: ">=18",
    }),
  );
  NodeFS.writeFileSync(mockRequestsFile, JSON.stringify({ count: 0, last: "" }));

  const mockServer = NodeChildProcess.spawn("node", [MOCK_UPDATE_ENTRY], {
    env: {
      ...process.env,
      MOCK_UPDATE_CONTROL_FILE: mockControlFile,
      MOCK_UPDATE_REQUESTS_FILE: mockRequestsFile,
      MOCK_UPDATE_PORT_FILE: mockPortFile,
      MOCK_UPDATE_TARBALL_FILE: tarballFile,
    },
    detached: true,
    stdio: [
      "ignore",
      "ignore",
      NodeFS.openSync(NodePath.join(ARTIFACTS_DIR, "mock-update.log"), "a"),
    ],
  });

  const mockPort = waitForPortFile(mockPortFile, mockServer);
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  mockServer.unref();

  // 4. seed autoCheck:false into both candidate state dirs (kill the scheduler).
  const seededConfig = {
    configVersion: 3,
    autoCheck: false,
    jitterMinute: 30,
    sources: {
      git: {
        enabled: true,
        paused: false,
        authFails: 0,
        transportStreak: 0,
        failingSince: null,
        lastResult: null,
      },
      web: {
        enabled: true,
        paused: false,
        authFails: 0,
        transportStreak: 0,
        failingSince: null,
        lastResult: null,
      },
    },
    availableRelease: null,
    notified: { release: null, problems: null },
    notify: { releasesMuted: false, problemsMuted: false },
  };
  const serverStatePaths: Array<string> = [];
  for (const subdir of ["userdata", "dev"]) {
    const stateDir = NodePath.join(t3Home, subdir);
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "auto-update.json"),
      JSON.stringify(seededConfig, null, 2),
    );
    serverStatePaths.push(NodePath.join(stateDir, "server-runtime.json"));
  }

  return {
    appRoot,
    currentVersion,
    mockControlFile,
    mockRequestsFile,
    mockUrl,
    mockServerPid: mockServer.pid ?? -1,
    serverStatePaths,
  };
}

/**
 * Build a real gzip tarball in the SHIPPING bundle shape — the launcher pair at the archive root
 * and the payload under `versions/<NEWER_VERSION>/` (that subtree, and only it, is what an update
 * copies) — and return its sha256 hex.
 */
function buildReleaseTarball(tmpRoot: string, tarballFile: string): string {
  const bundle = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "release-bundle-"));
  const payload = NodePath.join(bundle, "versions", NEWER_VERSION);
  NodeFS.mkdirSync(payload, { recursive: true });
  const sha = (bytes: Buffer): string =>
    NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  NodeFS.writeFileSync(NodePath.join(payload, "cli.js"), "console.log('app v999')\n");
  NodeFS.writeFileSync(NodePath.join(payload, "lib.js"), "export const x = 1\n");
  const files: Record<string, string> = {};
  for (const name of ["cli.js", "lib.js"]) {
    files[name] = sha(NodeFS.readFileSync(NodePath.join(payload, name)));
  }
  NodeFS.writeFileSync(
    NodePath.join(payload, "__checksums.json"),
    JSON.stringify({ algo: "sha256", files }),
  );
  // The archive root's own launcher pair — a decoy for anything that would grab the first cli.js.
  NodeFS.writeFileSync(NodePath.join(bundle, "cli.js"), "// frozen wrapper (bundle root)\n");
  NodeFS.writeFileSync(
    NodePath.join(bundle, "current.json"),
    JSON.stringify({
      schema: 1,
      version: NEWER_VERSION,
      entry: `versions/${NEWER_VERSION}/cli.js`,
    }),
  );
  NodeChildProcess.execFileSync("tar", ["-czf", tarballFile, "-C", bundle, "."], {
    stdio: "ignore",
  });
  return sha(NodeFS.readFileSync(tarballFile));
}

/** Poll (bounded) for the mock server to write its chosen port; fail loudly if it died. */
function waitForPortFile(portFile: string, child: NodeChildProcess.ChildProcess): number {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (NodeFS.existsSync(portFile)) {
      const text = NodeFS.readFileSync(portFile, "utf8").trim();
      if (text !== "") return Number(text);
    }
    if (child.exitCode !== null) {
      throw new Error(`mock update server exited (${child.exitCode}) before binding a port`);
    }
    if (Date.now() > deadline) throw new Error("mock update server never bound a port");
    // A short BLOCKING wait (globalSetup is synchronous here) — the http listen
    // callback fires within a few ms, so this bounded poll settles almost at once.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
