// ru-code PIN HARNESS — fault-injection boots of the REAL installed app.
//
// Each pin test boots its OWN daemonised app (real release layout, real daemon, real server,
// built web client) with a fault dialled in — a slow fake CLI, a CPU-pinned server, a frozen
// process, a poisoned session row — and then asserts the same core invariants:
//
//   · the app reaches STABLE (paired page open, no connection banner) within a budget;
//   · ZERO connection-error notifications across an observation window;
//   · the `/ws` upgrade is ANSWERED fast (any status — answered ≠ stalled).
//
// The suite reports findings; it deliberately fixes nothing. Background:
// the field reconnect loop («не удалось установить WebSocket-соединение» every 8–15s).
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { Page } from "@playwright/test";

import { buildLayout, type Layout, type Prepared, prepareArtifacts } from "./artifacts.ts";
import { readSentinel } from "./daemon.ts";
import { getFreePort, getHealthz, log, mkTemp, poll, REPO_ROOT, sleep } from "./primitives.ts";

export const PIN_VERSION = "1.0.0";

const PIN_DIR = NodePath.resolve(REPO_ROOT, "ru-code/e2e/harness");
const FAKE_ENTRY = NodePath.resolve(
  REPO_ROOT,
  "apps/server/src/ru-code/tests/qwen/fake-acp/fake-acp-server.ts",
);
export const ARTIFACTS_DIR = NodePath.resolve(REPO_ROOT, "ru-code/e2e/.artifacts-pins");

// The texts the connection layer shows for a lost/failed connection (client-runtime, RU locale).
// Matching TEXT rather than a testid is deliberate: it is exactly what the field user reported.
export const CONNECTION_ERROR_PATTERN =
  /не удалось подключиться|не удалось установить|переподключение|could not establish|disconnected\./i;

// ── one-time artifacts (release bundle + web client), shared by every pin ────────────────────
let preparedOnce: Prepared | null = null;
export function prepared(): Prepared {
  preparedOnce ??= prepareArtifacts({ version: PIN_VERSION, withClient: true });
  return preparedOnce;
}

export interface PinnedApp {
  readonly layout: Layout;
  readonly baseDir: string;
  readonly port: number;
  /** The SERVER's pid (from the runtime sentinel) — the SIGSTOP/SIGCONT target. */
  readonly pid: number;
  readonly pairingUrl: string;
  readonly webUrl: string;
  /** The daemon journal — server stdout/stderr both land here. */
  readonly daemonLog: string;
  readonly env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

const pinCleanups: Array<() => Promise<void>> = [];
export async function runPinCleanups(): Promise<void> {
  while (pinCleanups.length > 0) {
    const cleanup = pinCleanups.pop();
    if (cleanup) await cleanup().catch(() => {});
  }
}

/**
 * Boot one pinned app. `wrap` prefixes the launcher command (e.g. ["taskset","-c","0"]) — Linux
 * CPU affinity and niceness are inherited by the daemonised server and every CLI child it spawns,
 * so wrapping the launcher constrains the whole subtree.
 */
export async function bootPin(options: {
  readonly name: string;
  readonly env?: Record<string, string | undefined>;
  readonly wrap?: ReadonlyArray<string>;
  /** Boot budget — generous for the wrapped/pinned variants. */
  readonly bootTimeoutMs?: number;
}): Promise<PinnedApp> {
  const layout = buildLayout(prepared(), PIN_VERSION);
  const sandbox = mkTemp(`pin-${options.name}-`);
  const homeDir = NodePath.join(sandbox, "home");
  const cliConfigDir = NodePath.join(homeDir, ".qwen");
  const controlFile = NodePath.join(sandbox, "fake-control.json");
  NodeFS.mkdirSync(NodePath.join(cliConfigDir, "bin"), { recursive: true });
  // Detection stub only — RU_CODE_CLI_JS wins the actual spawn.
  NodeFS.writeFileSync(NodePath.join(cliConfigDir, "bin", "cli.js"), "// pin detection stub\n");
  NodeFS.writeFileSync(controlFile, JSON.stringify({ delayMs: 0, historyTurns: 0 }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    T3CODE_HOME: NodePath.join(sandbox, "t3home"),
    RU_CODE_CLI_JS: NodePath.join(PIN_DIR, "pinFakeCli.mjs"),
    RU_CODE_PIN_REAL_FAKE: FAKE_ENTRY,
    RU_CODE_FAKE_ACP: "FLOW",
    RU_CODE_FAKE_CONTROL_FILE: controlFile,
    RU_CODE_FAKE_CLI_CONFIG_DIR: cliConfigDir,
    RU_CODE_FAKE_LOG_FILE: NodePath.join(ARTIFACTS_DIR, `${options.name}-fake-acp.log`),
    T3CODE_NO_BROWSER: "1",
    T3CODE_LOG_LEVEL: "Debug",
    TZ: "UTC",
    ...options.env,
  };

  const port = await getFreePort();
  const launcher = [
    ...(options.wrap ?? []),
    process.execPath,
    NodePath.join(layout.appRoot, "cli.js"),
    "start",
    "--port",
    String(port),
    "--no-browser",
    "--base-dir",
    layout.baseDir,
  ];
  const startResult = NodeChildProcess.spawnSync(launcher[0] as string, launcher.slice(1), {
    env,
    encoding: "utf8",
    timeout: options.bootTimeoutMs ?? 90_000,
  });
  if (startResult.status !== 0) {
    throw new Error(
      `pin boot '${options.name}' failed (${String(startResult.status)}):\n${startResult.stdout}\n${startResult.stderr}`,
    );
  }

  const health = await poll(() => getHealthz(readSentinel(layout.baseDir)?.port ?? port), {
    timeoutMs: options.bootTimeoutMs ?? 90_000,
    intervalMs: 400,
    label: `pin '${options.name}' /healthz`,
  });
  void health;
  const sentinel = readSentinel(layout.baseDir);
  if (sentinel === null || sentinel.pairingUrl === undefined) {
    throw new Error(`pin boot '${options.name}': no sentinel/pairingUrl after healthz`);
  }

  const app: PinnedApp = {
    layout,
    baseDir: layout.baseDir,
    port: sentinel.port,
    pid: sentinel.pid,
    pairingUrl: sentinel.pairingUrl,
    webUrl: `http://127.0.0.1:${sentinel.port}`,
    daemonLog: NodePath.join(layout.baseDir, "userdata", "daemon.log"),
    env,
    stop: async () => {
      // A frozen server ignores everything except SIGKILL/SIGCONT — thaw first so the graceful
      // stop has a chance, then make sure nothing survives.
      try {
        process.kill(sentinel.pid, "SIGCONT");
      } catch {
        /* not frozen / already gone */
      }
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(layout.appRoot, "cli.js"), "stop", "--base-dir", layout.baseDir, "--force"],
        { env, encoding: "utf8", timeout: 20_000 },
      );
      try {
        process.kill(sentinel.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
  pinCleanups.push(app.stop);
  return app;
}

// ── invariants ───────────────────────────────────────────────────────────────────────────────

/** Open the pairing URL and wait until the app shell is up and quiet (no connection banner). */
export async function awaitStable(
  page: Page,
  app: PinnedApp,
  options: { readonly budgetMs?: number; readonly quietMs?: number } = {},
): Promise<void> {
  const budget = options.budgetMs ?? 60_000;
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: budget });
  // Pairing exchanges the token and lands on "/". A bounced (already-authenticated) pair page
  // also lands on "/" — both are fine here; A1 asserts the difference explicitly.
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: budget });
  await assertQuietFor(page, options.quietMs ?? 6_000, "awaitStable");
}

/** Fail the moment a connection-error notification shows up within the window. */
export async function assertQuietFor(page: Page, windowMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < windowMs) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const match = CONNECTION_ERROR_PATTERN.exec(bodyText);
    if (match !== null) {
      const context = bodyText
        .split("\n")
        .filter((line) => CONNECTION_ERROR_PATTERN.test(line))
        .slice(0, 4)
        .join(" | ");
      throw new Error(`[${label}] connection-error notification visible: "${context}"`);
    }
    await sleep(400);
  }
}

/** Count connection-error sightings over a window WITHOUT failing — for pins that expect them. */
export async function countConnectionErrors(page: Page, windowMs: number): Promise<number> {
  let sightings = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < windowMs) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (CONNECTION_ERROR_PATTERN.test(bodyText)) sightings += 1;
    await sleep(500);
  }
  return sightings;
}

/**
 * Time how long the server takes to ANSWER a `/ws` upgrade request. Any answer counts — 101, 4xx,
 * even a plain close: the invariant under test is "never stalled", not "accepted" (an
 * unauthenticated dial legitimately gets refused).
 */
export function upgradeAnswerMs(
  port: number,
  options: { readonly timeoutMs?: number; readonly path?: string; readonly host?: string } = {},
): Promise<{
  readonly ms: number;
  readonly kind: "upgrade" | "response";
  readonly status?: number;
}> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port,
      path: options.path ?? "/ws",
      headers: {
        ...(options.host !== undefined ? { Host: options.host } : {}),
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": NodeCrypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`/ws upgrade not answered within ${timeoutMs}ms`));
    }, timeoutMs);
    request.on("upgrade", (_response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms: Date.now() - startedAt, kind: "upgrade" });
    });
    request.on("response", (response) => {
      clearTimeout(timer);
      response.resume();
      request.destroy();
      resolve({ ms: Date.now() - startedAt, kind: "response", status: response.statusCode ?? 0 });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

// ── process + db levers ──────────────────────────────────────────────────────────────────────

export const freeze = (pid: number): void => process.kill(pid, "SIGSTOP");
export const thaw = (pid: number): void => process.kill(pid, "SIGCONT");

/** Run SQL against the pinned app's live database (WAL — safe cross-process). */
export function runSql<T>(
  app: PinnedApp,
  fn: (db: InstanceType<typeof NodeSqlite.DatabaseSync>) => T,
): T {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(app.baseDir, "userdata", "state.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function readDaemonLog(app: PinnedApp): string {
  try {
    return NodeFS.readFileSync(app.daemonLog, "utf8");
  } catch {
    return "";
  }
}

export function saveEvidence(name: string, content: string): void {
  NodeFS.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(ARTIFACTS_DIR, name), content);
}

// ── the AV shim (LD_PRELOAD open/stat delay) ─────────────────────────────────────────────────

const AV_SHIM_SOURCE = `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <time.h>
#include <stdlib.h>
static void pin_delay(void) {
  static long ns = -1;
  if (ns < 0) { const char *raw = getenv("PIN_AV_DELAY_US"); ns = (raw ? atol(raw) : 0) * 1000L; }
  if (ns > 0) { struct timespec ts = {0, ns}; nanosleep(&ts, 0); }
}
typedef int (*openat_fn)(int, const char *, int, ...);
int openat(int dirfd, const char *path, int flags, ...) {
  static openat_fn real = 0;
  if (!real) real = (openat_fn)dlsym(RTLD_NEXT, "openat");
  pin_delay();
  __builtin_va_list args; __builtin_va_start(args, flags);
  int mode = __builtin_va_arg(args, int); __builtin_va_end(args);
  return real(dirfd, path, flags, mode);
}
`;

/** Compile the AV-latency shim; null when the toolchain is unavailable (pin reports "blocked"). */
export function buildAvShim(): string | null {
  try {
    const dir = mkTemp("pin-avshim-");
    const sourcePath = NodePath.join(dir, "avshim.c");
    const libPath = NodePath.join(dir, "avshim.so");
    NodeFS.writeFileSync(sourcePath, AV_SHIM_SOURCE);
    const result = NodeChildProcess.spawnSync(
      "gcc",
      ["-shared", "-fPIC", "-O2", "-o", libPath, sourcePath, "-ldl"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (result.status !== 0) {
      log(`[pin] avshim compile failed: ${result.stderr}`);
      return null;
    }
    return libPath;
  } catch {
    return null;
  }
}
