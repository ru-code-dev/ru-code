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

const BOOT_TIMEOUT_MS = 240_000;
// Any port — the fetch-until-200 probe below is the real readiness gate.
const WEB_URL_PATTERN = /https?:\/\/localhost:(\d+)/;

export interface HarnessState {
  readonly webUrl: string;
  readonly runnerPid: number;
  readonly tmpRoot: string;
  readonly homeDir: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
  readonly projectCwd: string;
  readonly transcriptFile: string;
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
    await page.goto(pairingMatch[1]!);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    // Give the app a beat to persist the environment registration.
    await page.waitForTimeout(2_000);
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
    const authPath = NodePath.join(ARTIFACTS_DIR, "auth.json");
    const snapshot = JSON.parse(NodeFS.readFileSync(authPath, "utf8")) as {
      origins?: Array<{ localStorage?: Array<{ name: string }> }>;
    };
    for (const origin of snapshot.origins ?? []) {
      origin.localStorage = origin.localStorage?.filter(
        (entry) => entry.name !== "ruCode:composer-drafts:v1",
      );
    }
    NodeFS.writeFileSync(authPath, JSON.stringify(snapshot, null, 2));
  } finally {
    await browser.close();
  }

  const state: HarnessState = {
    webUrl,
    runnerPid: runner.pid ?? -1,
    tmpRoot,
    homeDir,
    cliConfigDir,
    controlFile,
    projectCwd,
    transcriptFile,
  };
  NodeFS.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // Keep the runner alive past globalSetup: unref so the setup process can exit.
  runner.unref();
  runner.stdout?.unref?.();
  runner.stderr?.unref?.();
}
