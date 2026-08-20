// ru-code: process liveness + signalling is the ONE cross-platform kill floor the
// whole daemon rests on (process.kill — a syscall, no shell/taskkill). We prove it
// against a real throwaway process: alive → signalled → gone, plus the dead-pid and
// own-pid edges that `stop`'s stale-pid pre-check depends on.

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isProcessAlive, signalProcess } from "@ru-code/daemon/signal";

import { awaitPidDead, withSleeper } from "./spawnSleeper.ts";

describe("daemon signal (liveness + signalling)", () => {
  it.live("reports our own process as alive", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isProcessAlive(process.pid));
    }),
  );

  it.live("reports a live child as alive, then dead once signalled", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          assert.isTrue(yield* isProcessAlive(pid));
          yield* signalProcess(pid, "SIGKILL");
          assert.isTrue(yield* awaitPidDead(pid));
          assert.isFalse(yield* isProcessAlive(pid));
        }),
      ),
    ),
  );

  it.live("reports a reaped pid as not alive", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          yield* signalProcess(pid, "SIGKILL");
          yield* awaitPidDead(pid);
          assert.isFalse(yield* isProcessAlive(pid));
        }),
      ),
    ),
  );

  it.live("signalling a dead pid is a no-op (never fails)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          yield* signalProcess(pid, "SIGKILL");
          yield* awaitPidDead(pid);
          // Second signal to the now-dead pid must succeed cleanly.
          yield* signalProcess(pid, "SIGTERM");
        }),
      ),
    ),
  );
});
