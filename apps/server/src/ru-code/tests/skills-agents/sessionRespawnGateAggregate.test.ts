// ru-code (A22, SDK 0.3.0, owner decision O1-B; A25): the respawn gate as an AGGREGATOR.
//
// The gate runs every `registerSessionHook` a loaded plugin registered and nothing else — A25
// removed the compiled-in catalog half, which now ships as `@smart-tools/plugin-catalogs`. What has
// to be true of the plugin half is a POLICY, not a feature, and it is the whole reason O1-B was
// acceptable at all: plugin code runs inside the spawn path, in the delay between the user pressing
// Enter and the assistant answering.
//
//   1. NO HOOKS ⇒ the gate never respawns and provisions nothing (the no-plugin install);
//   2. a hook that THROWS or rejects is logged and treated as the safe answer — "unchanged" for a
//      fingerprint (a broken plugin must not restart the session every turn) and "done" for a
//      provision (spawn with whatever the checkout had);
//   3. a hook that HANGS is abandoned at its 5 s budget, with the same safe answers;
//   4. and in none of those cases does a spawn fail.
//
// Only `PluginHost` is a fake, because the gate self-provides the real layer and an inner
// `Layer.provide` cannot be overridden from outside — which is why `makeSessionRespawnGate` is
// exported.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { PluginSessionHook } from "@smart-tools/plugin-sdk/host";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  makeSessionRespawnGate,
  SessionRespawnGate,
} from "../../skills-agents/SessionRespawnGate.ts";
import { PluginHost } from "../../plugins/PluginHost.ts";

const PID = "33333333-3333-3333-3333-333333333333";
const THREAD = "thread-agg";

/**
 * A `PluginHost` that answers exactly the hooks the test hands it and nothing else.
 *
 * Everything but `sessionHooks` is unreachable from the gate — it calls one member — so the rest
 * is filled in with the smallest legal values rather than a second implementation of the host.
 */
const fakePluginHost = (hooks: ReadonlyArray<{ pluginId: string; hook: PluginSessionHook }>) =>
  Layer.succeed(PluginHost, {
    start: Effect.void,
    list: Effect.succeed([]),
    manifestsForWeb: Effect.succeed([]),
    invoke: () => Effect.die("not used"),
    resolvePluginDir: () => Effect.sync(() => undefined),
    sessionHooks: Effect.succeed(hooks),
  } as never);

const gateLayer = (hooks: ReadonlyArray<{ pluginId: string; hook: PluginSessionHook }>) =>
  Layer.effect(SessionRespawnGate, makeSessionRespawnGate).pipe(
    Layer.provide(fakePluginHost(hooks)),
    Layer.provideMerge(NodeServices.layer),
  );

// ── 1. no hooks ────────────────────────────────────────────────────────────────────────────────

it.effect(
  "with NO hooks registered the gate never respawns and provisions nothing",
  () =>
    Effect.gen(function* () {
      const gate = yield* SessionRespawnGate;

      yield* gate.record(THREAD, PID);
      assert.isFalse(yield* gate.changedForThread(THREAD, PID), "empty baseline is unchanged");
      // …and it stays unchanged: with no hook there is no source to fingerprint at all, so the
      // reactor's restart decision is decided entirely by its OTHER triggers.
      assert.isFalse(yield* gate.changedForThread(THREAD, PID), "still unchanged on the next turn");

      // The worktree half is a quiet no-op rather than a failure — a spawn is never blocked.
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ru-agg-cwd-" });
      yield* gate.provisionWorktree(THREAD, PID, cwd);
      const entries = yield* fs.readDirectory(cwd);
      assert.deepStrictEqual([...entries], [], "nothing written into the worktree");
    }).pipe(Effect.provide(gateLayer([]))),
  { timeout: 30_000 },
);

// ── 2. a hook contributes ──────────────────────────────────────────────────────────────────────

it.effect(
  "a hook's own fingerprint flips the decision, and a stable one does not",
  () =>
    Effect.gen(function* () {
      const gate = yield* SessionRespawnGate;

      yield* gate.record(THREAD, PID);
      assert.isFalse(yield* gate.changedForThread(THREAD, PID), "same fingerprint → no respawn");

      fingerprint = "v2";
      assert.isTrue(
        yield* gate.changedForThread(THREAD, PID),
        "hook fingerprint changed → respawn",
      );

      yield* gate.record(THREAD, PID);
      assert.isFalse(yield* gate.changedForThread(THREAD, PID), "recorded → no respawn");
    }).pipe(
      Effect.provide(
        gateLayer([{ pluginId: "fp", hook: { changedForThread: async () => fingerprint } }]),
      ),
    ),
  { timeout: 30_000 },
);

let fingerprint = "v1";

// ── 3. a hook that throws ──────────────────────────────────────────────────────────────────────

it.effect(
  "a hook that throws is treated as unchanged and never fails the turn",
  () =>
    Effect.gen(function* () {
      const gate = yield* SessionRespawnGate;

      yield* gate.record(THREAD, PID);
      // The safe direction is "unchanged": a plugin whose fingerprint read fails every turn must
      // not restart the user's live session every turn.
      assert.isFalse(
        yield* gate.changedForThread(THREAD, PID),
        "throwing hook → unchanged, not respawn",
      );
      // …and it does not fail: `provisionWorktree` returns normally, so the spawn proceeds.
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ru-agg-cwd-" });
      yield* gate.provisionWorktree(THREAD, PID, cwd);
      assert.isTrue(true, "provisionWorktree returned");
    }).pipe(
      Effect.provide(
        gateLayer([
          {
            pluginId: "boom",
            hook: {
              // A SYNCHRONOUS throw, not a rejection: it is the shape that escapes a naive
              // `Effect.tryPromise(() => hook())` and the one the host wraps in an async body.
              changedForThread: (): Promise<string | null> => {
                throw new Error("hook exploded");
              },
              provisionWorktree: async () => {
                throw new Error("provision exploded");
              },
            },
          },
        ]),
      ),
    ),
  { timeout: 30_000 },
);

// ── 4. a hook that hangs ───────────────────────────────────────────────────────────────────────

// `it.live`, NOT `it.effect`: `@effect/vitest`'s `it.effect` installs a TEST CLOCK, where time
// only moves when a test advances it — so `Effect.timeoutOption` never fires and this case passes
// for the wrong reason (it looks instant because no time passed at all, and a REMOVED budget would
// look identical). The budget is a wall-clock promise, so this one case is measured on the real one.
it.live(
  "a hook that never settles is abandoned at its budget, not awaited",
  () =>
    Effect.gen(function* () {
      const gate = yield* SessionRespawnGate;

      // The whole point of the 5 s budget: this promise NEVER settles, so without it the turn
      // would hang forever and the user's message would never be sent.
      const started = yield* Clock.currentTimeMillis;
      yield* gate.record(THREAD, PID);
      const changed = yield* gate.changedForThread(THREAD, PID);
      const elapsed = (yield* Clock.currentTimeMillis) - started;

      assert.isFalse(changed, "hanging hook → unchanged");
      // Two budgets are paid here (record + changedForThread), each 5 s, and nothing more.
      assert.isBelow(elapsed, 25_000, `finished in ${String(elapsed)}ms, well inside the budget`);
      assert.isAbove(elapsed, 4_000, "the budget was actually waited out, not skipped");
    }).pipe(
      Effect.provide(
        gateLayer([
          { pluginId: "hang", hook: { changedForThread: () => new Promise<string>(() => {}) } },
        ]),
      ),
    ),
  { timeout: 60_000 },
);
