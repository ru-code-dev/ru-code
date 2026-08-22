// ru-code: E2E HARNESS — daemon control.
//
// Boots the app THE WAY A USER DOES: `cli.js start` through the frozen wrapper, which daemonises
// and exits, leaving a detached server behind. Readiness is proven by polling `/healthz`, never by
// a sleep, and the live port/pid are read from the server's own runtime-state file rather than
// assumed — a daemon that picked a different port is then a visible fact, not a hang.
//
// `readSentinel` also hands back the tokenized PAIRING URL. That is the production way into an
// authenticated tab: a browser spec can simply open it instead of injecting cookies or stubbing
// auth, which is both less code and one more real path under test.
//
// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";

import type { Layout } from "./artifacts.ts";
import {
  assert,
  assertEq,
  cleanups,
  getFreePort,
  getHealthz,
  type HealthzBody,
  poll,
  readJsonFile,
  runNode,
} from "./primitives.ts";

// ── daemon control ───────────────────────────────────────────────────────────────────────────
export const sentinelPath = (baseDir: string): string =>
  NodePath.join(baseDir, "userdata", "server-runtime.json");
export const readSentinel = (
  baseDir: string,
): { pid: number; port: number; pairingUrl?: string } | null => {
  const raw = readJsonFile(sentinelPath(baseDir)) as {
    pid?: number;
    port?: number;
    pairingUrl?: string;
  } | null;
  return raw !== null && typeof raw.pid === "number" && typeof raw.port === "number"
    ? {
        pid: raw.pid,
        port: raw.port,
        ...(typeof raw.pairingUrl === "string" ? { pairingUrl: raw.pairingUrl } : {}),
      }
    : null;
};

/** Spawn `start` (the parent daemonises + exits), then wait for /healthz. Returns the live port + pid + health. */
export async function bootDaemon(
  layout: Layout,
  env: NodeJS.ProcessEnv,
  expectVersion: string | null,
): Promise<{ port: number; pid: number; health: HealthzBody }> {
  const port = await getFreePort();
  await runNode(
    [
      NodePath.join(layout.appRoot, "cli.js"),
      "start",
      "--port",
      String(port),
      "--no-browser",
      "--base-dir",
      layout.baseDir,
    ],
    { env, timeoutMs: 60_000 },
  );
  // register a stop-cleanup for this sandbox's daemon child (survives detached).
  cleanups.push(async () => {
    const sentinel = readSentinel(layout.baseDir);
    await runNode(
      [NodePath.join(layout.appRoot, "cli.js"), "stop", "--base-dir", layout.baseDir, "--force"],
      { env, timeoutMs: 20_000 },
    );
    if (sentinel !== null) {
      try {
        process.kill(sentinel.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
  const health = await poll(() => getHealthz(readSentinel(layout.baseDir)?.port ?? port), {
    timeoutMs: 30_000,
    intervalMs: 400,
    label: "boot /healthz",
  });
  const live = readSentinel(layout.baseDir);
  assert(live !== null, "no sentinel after boot");
  if (expectVersion !== null) assertEq(health.version, expectVersion, "booted version");
  return {
    port: (live as { pid: number; port: number }).port,
    pid: (live as { pid: number; port: number }).pid,
    health,
  };
}

export async function stopDaemon(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  const sentinel = readSentinel(layout.baseDir);
  await runNode(
    [NodePath.join(layout.appRoot, "cli.js"), "stop", "--base-dir", layout.baseDir, "--force"],
    { env, timeoutMs: 20_000 },
  );
  if (sentinel !== null) {
    await poll(
      async () => {
        try {
          process.kill(sentinel.pid, 0);
          return false; // still alive
        } catch {
          return true; // dead
        }
      },
      { timeoutMs: 10_000, intervalMs: 200, label: "old pid exits" },
    );
  }
}
