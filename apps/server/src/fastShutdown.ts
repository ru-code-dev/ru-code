// @effect-diagnostics nodeBuiltinImport:off
/**
 * Hot-cleanup shared by the `/shutdown` HTTP route and the SIGINT/SIGTERM
 * listener in `server.ts`.
 *
 * Both call sites need the same sequence:
 *   1. SIGKILL every provider session (`providerService.stopAll`).
 *   2. SIGKILL every PTY (`terminalManager.killAll`).
 *   3. Remove the persisted runtime-state file so the next launcher run
 *      doesn't see a stale pid.
 *
 * Step ordering matters: kill child processes first (those are what
 * blocks the node process from exiting fast) then drop bookkeeping.
 * Each step swallows its own errors — by the time we reach this code
 * the user has asked the daemon to stop, so reporting partial failures
 * is less useful than continuing on to `process.exit(0)`.
 *
 * The two call sites differ only in how they sequence the exit:
 *   - `/shutdown` returns 200 then `forkDetach`-delays `process.exit(0)`
 *     so the response flushes first.
 *   - the signal listener runs this synchronously via `Effect.runSync`
 *     and calls `process.exit(0)` directly — no HTTP response to flush.
 */
import * as nodeFs from "node:fs";
import * as Effect from "effect/Effect";

import { ServerConfig } from "./config.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";

export const runFastShutdownCleanup = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  yield* providerService.stopAll().pipe(Effect.ignoreCause({ log: true }));
  yield* terminalManager.killAll;
  yield* Effect.sync(() => {
    try {
      nodeFs.unlinkSync(config.serverRuntimeStatePath);
    } catch {
      // Already absent or another writer touched it — fine.
    }
  });
});
