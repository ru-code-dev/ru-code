// ru-code: warm-engine FAILURE MODES over the REAL QwenAdapter + fake ACP
// agent. Every scenario mirrors a failure mode verified in the qwen-code 0.13.1
// SOURCE (file:line cites in the fake's script docs and below) — not invented
// shapes. The promise under test: whatever the CLI does — crash at boot, wedge
// before initialize, die mid-`session/load`, poison the stdout parser, die
// while parked in the pool, or answer a cancel with an error — the adapter
// surfaces a TYPED, classified failure (never a hang, never a defect), the
// pool never respawn-loops a broken CLI, and the next start recovers.
//
//   W1 session/load process death — qwen exits(1) mid-load on a corrupt
//      session file (config.ts:998-1002): pooled resume fails typed+bounded,
//      a fresh start right after succeeds.
//   W2 boot-crash CLI (FatalConfigError exit 52 before the ACP loop,
//      settings.ts:726-733): the eager warmup fails, the CHAIN stops dead
//      (v2.1: a failure is never a proof of health), cold starts surface the
//      typed error, and spawning STOPS — no respawn loop.
//   W3 boot-wedge CLI (initialize never answered — e.g. a network-stalled
//      boot auth refresh, gemini.tsx:407): a taken wedged spare trips the
//      bounded start timeout; the pool self-heals on the next start.
//   W4 stdout prelude garbage (console redirect starts only at
//      acpAgent.ts:81-83): the poisoned prewarm is discarded, the cold start
//      succeeds, the breaker re-arms after success and the chain refills.
//   W5 idle death of a parked spare (uncaughtException → exit 1,
//      index.ts:60-71): discarded silently, the next start rides a live spare.
//   W6 cancel-as-error race (non-429 rethrow at Session.ts:330-339): a LATE
//      JSON-RPC error answering a cancelled prompt must not corrupt the
//      already-settled stop — no failed turn, no error banner event.
//   W7 abandoned start (EXTERNAL interrupt — reactor teardown/instance
//      rebuild): the compensating `stopped` event still lands (onExit-based;
//      a cause-tap would be skipped under interruption) — the projection can
//      never stick on "connecting".
//   W8 stop-fiber interrupt hardening: an interruptTurn whose fiber is torn
//      down immediately must never strand the thread — the next start
//      completes (never hangs on a resolverless teardown latch).
//   W9 sendTurn-fiber interrupt hardening: an externally interrupted request
//      fiber still settles the turn exactly once (onExit safety net), and a
//      follow-up stop completes instead of hanging on the finalizer barrier.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { PREWARM_GENERIC_INSTANCES } from "@ru-code/qwen/constants";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import {
  FAKE_SESSION_ID,
  type FakeAcpScript,
  type FakeAcpTransportControls,
} from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { collectAdapterEvents, pollForSpawns, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-failure-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-warm-failure-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Pins the failure SHAPE: a typed fail reason (no defect, no bare hang) whose
// classified text carries the expected fragment — a regression that collapses
// every failure into a generic dump would trip the fragment check.
const expectTypedFailure = <A, E>(exit: Exit.Exit<A, E>, label: string, detailIncludes: string) => {
  assert.strictEqual(Exit.isFailure(exit), true, `${label}: start must fail`);
  if (!Exit.isFailure(exit)) return;
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  assert.isDefined(failure, `${label}: a TYPED fail reason (classified error), not a hang`);
  assert.isUndefined(exit.cause.reasons.find(Cause.isDieReason), `${label}: no defect leaked`);
  const rendered = String(
    failure!.error !== null && typeof failure!.error === "object" && "detail" in failure!.error
      ? (failure!.error as { detail: unknown }).detail
      : failure!.error,
  );
  assert.include(rendered, detailIncludes, `${label}: the failure carries its classified shape`);
};

const PREWARM = PREWARM_GENERIC_INSTANCES;
// ru-code (chained refill): tiny chain gap for the suites that want a filled
// pool; W2–W4 deliberately use a single EAGER slot, because a failing recipe
// must never produce a second one.
const REFILL_DELAY_MS = 50;
// The classifier (the error system's single authority) routes ALL of these
// through its C4 recognizer — `ProviderAdapterProcessError` and transport
// death both classify as connection-lost (recognizers.ts C4_TRANSPORT). The
// CLASS TEXT is the user-facing contract these scenarios pin; a regression to
// a raw Cause dump or an unclassified error breaks the fragment check.
const CONNECTION_LOST_FRAGMENT = "lost. Send a message to reconnect";

// ── W1 — session/load kills the process (corrupt session file) ───────────────

it.effect(
  "warm failure W1: session/load process death (corrupt session file) fails typed; a fresh start recovers",
  () => {
    let spawnCount = 0;
    const loadSessionIds: string[] = [];
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("ответ").respondOk(),
      // The FM-17 shape: qwen exits(1) mid-session/load instead of erroring.
      loadBehavior: "exit",
      onLoadSession: (sessionId) => {
        loadSessionIds.push(sessionId);
      },
    };
    return Effect.gen(function* () {
      // Bounded handshake so even a worst-case dead-transport retry inside the
      // start cannot stretch the test (the classified failure itself is instant).
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        sessionStartTimeoutMs: 1_000,
        poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
      });
      yield* pollForSpawns(() => spawnCount, PREWARM, "boot chain prewarmed the generic target");

      // Healthy first life: warm take + session/new + a streamed turn.
      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));

      // The resume: pooled take, bindAndStart(session/load) — and the child
      // DIES mid-request. Must surface as a typed failure, never a hang.
      const resumeExit = yield* Effect.exit(
        adapter
          .startSession({
            threadId: THREAD_ID,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            resumeCursor: firstSession.resumeCursor,
          })
          .pipe(Effect.timeout("10 seconds")),
      );
      expectTypedFailure(resumeExit, "W1 resume", CONNECTION_LOST_FRAGMENT);
      assert.deepStrictEqual(
        loadSessionIds,
        [FAKE_SESSION_ID],
        "the resume attempted exactly one session/load with the cursor's id",
      );
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);

      // Recovery: a fresh start (no cursor ⇒ session/new, unaffected by the
      // corrupt file) works immediately — the pool still serves.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "снова" })
        .pipe(Effect.timeout("10 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W2 — boot-crash CLI: breaker opens, NO respawn loop ──────────────────────

it.effect(
  "warm failure W2: a boot-crashing CLI opens the refill breaker — typed start failures, no respawn loop",
  () => {
    let spawnCount = 0;
    let disposeCount = 0;
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
      });
      // ru-code (v2.1): the eager chain starts with ONE process. Its warmup
      // fails (exit 52) ⇒ no proof of health ⇒ the chain never produces a
      // second one, even with an eager budget of PREWARM.
      assert.strictEqual(spawnCount, 1, "the eager chain attempted exactly ONE boot process");
      yield* pollUntil(() => disposeCount >= 1, "the crashed prewarm was discarded");

      // Cold start #1: pool empty, the chain stopped, the cold child crashes
      // the same way → a classified typed failure.
      const firstExit = yield* Effect.exit(
        adapter
          .startSession({
            threadId: THREAD_ID,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.timeout("10 seconds")),
      );
      expectTypedFailure(firstExit, "W2 first start", CONNECTION_LOST_FRAGMENT);
      assert.strictEqual(
        spawnCount,
        1 + 1,
        "take refilled NOTHING (take is spawn-free); only the cold spawn",
      );

      // Cold start #2: same — exactly one more spawn.
      const secondExit = yield* Effect.exit(
        adapter
          .startSession({
            threadId: THREAD_ID,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.timeout("10 seconds")),
      );
      expectTypedFailure(secondExit, "W2 second start", CONNECTION_LOST_FRAGMENT);
      assert.strictEqual(spawnCount, 1 + 2, "still one spawn per user action");

      // The no-loop proof: with no user action, NOTHING respawns. (A
      // real-clock window — the one honest way to assert an absence; it can
      // only false-pass on a respawn slower than the window, never flake red.)
      yield* Effect.sleep("300 millis");
      assert.strictEqual(spawnCount, 1 + 2, "a broken CLI is never respawn-looped");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
            onDispose: () => {
              disposeCount += 1;
            },
            // EVERY child is a boot-crasher (FatalConfigError shape, exit 52).
            perSpawnScript: () => ({ initializeBehavior: "exit", initializeExitCode: 52 }),
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W3 — boot-wedge CLI: bounded timeout, pool self-heals ────────────────────

it.effect(
  "warm failure W3: a wedged-at-boot prewarm costs one bounded timeout, then the pool self-heals",
  () => {
    let spawnCount = 0;
    const script: FakeAcpScript = { onPrompt: (steps) => steps.emitText("ok").respondOk() };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        // Tiny handshake ceiling: a wedged slot's bind must convert into a
        // typed error in bounded time (production: ACP_SESSION_START_TIMEOUT_MS).
        // The pool's warmup ceiling stays at its 60s default — the PRODUCTION
        // ratio: the take DISOWNS the pool's warmup watchdog, so the failure
        // below must come from the SESSION's classified start timeout, never
        // from the pool timer (whose interrupt would be an unclassified,
        // cancel-looking death).
        sessionStartTimeoutMs: 500,
        // A wedged spare never proves health, so the chain stops at one — the
        // v2.1 shape of "a broken recipe never fans out".
        poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
      });
      assert.strictEqual(spawnCount, 1, "the eager chain attempted ONE boot process (wedged)");

      // Start #1 takes the wedged spare: the bind awaits the never-finishing
      // warmup and the start timeout converts it into a typed failure. The take
      // spawns nothing, and the FAILED start is no proof of health either.
      const firstExit = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );
      expectTypedFailure(firstExit, "W3 first start (wedged spare)", CONNECTION_LOST_FRAGMENT);
      assert.strictEqual(spawnCount, 1, "take is spawn-free; a failed start refills nothing");

      // Start #2 finds an EMPTY pool and goes cold on a healthy child — the
      // pool self-heals through the user's next action, never through a loop.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(spawnCount, 2, "one cold spawn — the refill is only SCHEDULED");
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));

      // …and the OTHER half of "self-heals": that successful bind was the
      // proof of health, so the chain refills the generic pool back to target
      // with HEALTHY children, one at a time. The next start then rides a WARM
      // spare again — the pool is fully recovered, not merely usable cold.
      yield* pollForSpawns(
        () => spawnCount,
        2 + PREWARM,
        "the healed chain refilled the generic pool to target",
      );
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      const beforeHealed = spawnCount;
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(
        spawnCount,
        beforeHealed,
        "start #3 rode a HEALTHY warm spare — spawn-free, the pool self-healed",
      );
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "снова" })
        .pipe(Effect.timeout("10 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
            // Only the boot-prewarmed child wedges; later spawns are healthy.
            perSpawnScript: (spawnIndex) =>
              spawnIndex <= 1 ? { initializeBehavior: "hang" } : undefined,
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W4 — stdout prelude garbage: poisoned prewarms, cold start recovers ──────

it.effect(
  "warm failure W4: parser-poisoning stdout garbage discards the prewarms; the cold start succeeds and the breaker re-arms",
  () => {
    let spawnCount = 0;
    let disposeCount = 0;
    const script: FakeAcpScript = { onPrompt: (steps) => steps.emitText("чисто").respondOk() };
    return Effect.gen(function* () {
      // The poisoned transport dies but the CHILD does not exit, so only the
      // pool's warmup ceiling can evict it — tiny here so the test is fast.
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: {
          warmupTimeoutMs: 300,
          eagerOnExpired: PREWARM,
          refillDelayMs: REFILL_DELAY_MS,
        },
      });
      assert.strictEqual(spawnCount, 1, "the eager chain attempted ONE boot process (poisoned)");
      // The warmup chokes on the non-ndjson prelude → the warmup timeout
      // discards the wedged-but-alive slot, counts the breaker, chain stops.
      yield* pollUntil(() => disposeCount >= 1, "the poisoned prewarm was discarded");

      // The user's start: pool empty + the chain stopped ⇒ ONE cold spawn
      // (healthy — the garbage was a boot-window artifact) and the session works.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      // Success re-arms the breaker and the CHAIN refills to target, one at a
      // time: the poisoned prewarm + the cold spawn + PREWARM chained spares.
      yield* pollForSpawns(
        () => spawnCount,
        1 + 1 + PREWARM,
        "breaker re-armed after success — the chain refilled the pool",
      );
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
            onDispose: () => {
              disposeCount += 1;
            },
            // Boot-window stdout pollution on the prewarm only.
            perSpawnScript: (spawnIndex) =>
              spawnIndex <= 1
                ? { preludeStdout: "qwen-cli: deprecation warning\nnot-json{{{\n" }
                : undefined,
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W5 — idle death of a parked spare ────────────────────────────────────────

it.effect(
  "warm failure W5: a parked spare that dies on its own is discarded silently; the next start rides a live spare",
  () => {
    let spawnCount = 0;
    let disposeCount = 0;
    let createSessionCount = 0;
    const spawnControls = new Map<number, FakeAcpTransportControls>();
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("живой").respondOk(),
      onCreateSession: () => {
        createSessionCount += 1;
      },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
      });
      yield* pollForSpawns(() => spawnCount, PREWARM, "boot chain prewarmed the generic target");
      // "Silently": a parked spare has no thread — its death must emit
      // NOTHING on the adapter's event stream.
      const collector = yield* collectAdapterEvents(adapter);

      // Spare #1 dies while PARKED (uncaughtException → exit 1 shape). The
      // pool's idle-watcher discards it; no respawn until the next activity.
      yield* spawnControls.get(1)!.exit(1);
      yield* pollUntil(() => disposeCount >= 1, "dead spare discarded by the idle-watcher");
      assert.strictEqual(
        spawnCount,
        PREWARM,
        "death alone does not respawn (breaker-guarded refill)",
      );
      assert.lengthOf(collector.events, 0, "a parked spare's death emits NO runtime events");

      // The next start pops the LIVE spare (#2) — never the dead one — and
      // the take tops the pool back up.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      assert.strictEqual(createSessionCount, 1, "one session/new on the live spare");
      // The dead spare was already gone, so the take popped the pool empty and
      // the bind's CHAIN refilled it to the FULL target, one process at a time.
      yield* pollForSpawns(
        () => spawnCount,
        PREWARM + PREWARM,
        "the chain refilled the pool back to target",
      );
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
            onDispose: () => {
              disposeCount += 1;
            },
            onSpawnControls: (spawnIndex, controls) => {
              spawnControls.set(spawnIndex, controls);
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W6 — cancel answered with an ERROR: the settled stop stays clean ─────────

it.effect(
  "warm failure W6: a late error answering the cancelled prompt cannot corrupt the settled stop — no failed turn, no error event",
  () => {
    let cancelCount = 0;
    let killCount = 0;
    const script: FakeAcpScript = {
      // The prompt streams then PARKS; session/cancel FAILS it with a JSON-RPC
      // error (qwen's abort-vs-error race) instead of a cancelled stopReason.
      onPrompt: (steps) => steps.emitText("working..."),
      cancelResponse: "error",
      onCancel: () => {
        cancelCount += 1;
      },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
      });
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "работай" }),
      );
      yield* collector.waitForDelta("working");

      // Stop: instant settle; the detached teardown sends session/cancel, and
      // the CLI answers the pending prompt with an ERROR (not "cancelled").
      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(() => cancelCount === 1, "the graceful session/cancel was sent");
      yield* pollUntil(
        () => collector.events.some((event) => event.type === "turn.completed"),
        "the stopped turn settled",
      );

      // Positive completion signal instead of a blind sleep: the detached
      // teardown SIGKILLs after the (tiny) grace — once the kill landed, the
      // late error response has long been delivered and absorbed.
      yield* pollUntil(() => killCount >= 1, "the grace-kill tail completed");
      const completions = collector.events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.lengthOf(completions, 1, "exactly ONE turn completion");
      assert.strictEqual(
        completions[0]!.payload.state,
        "cancelled",
        "the user's stop settles the turn as cancelled — the late error never re-labels it",
      );
      assert.isUndefined(
        collector.events.find(
          (event) => event.type === "session.state.changed" && event.payload.state === "error",
        ),
        "no session error event from the late cancel-error",
      );
      assert.isUndefined(
        collector.events.find(
          (event) =>
            event.type === "turn.completed" &&
            (event.payload.state === "failed" || event.payload.errorMessage !== undefined),
        ),
        "no failed/errored completion from the late cancel-error",
      );
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onKill: () => {
              killCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── W7 — abandoned start: the compensating stopped event survives interrupts ─

it.effect(
  "warm failure W7: an interrupt-abandoned start still ends the projection — starting is followed by stopped",
  () => {
    let createSessionCount = 0;
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.respondOk(),
      // The bind parks forever — the start can only end by interruption.
      startBehavior: "hang",
      onCreateSession: () => {
        createSessionCount += 1;
      },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      const startFiber = yield* Effect.forkChild(
        adapter.startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );
      // The fake received session/new ⇒ the 0ms starting event was already
      // emitted (it precedes the take/bind) and the start is parked in the
      // hanging bind — the exact abandonment window.
      yield* pollUntil(() => createSessionCount === 1, "the start reached the hanging bind");
      yield* Fiber.interrupt(startFiber);

      // The onExit-based compensating event lands even though the fiber was
      // EXTERNALLY interrupted (a cause-tap would have been skipped).
      yield* pollUntil(
        () =>
          collector.events.some(
            (event) => event.type === "session.state.changed" && event.payload.state === "stopped",
          ),
        "the compensating stopped event was emitted",
      );
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

// ── W8 — interrupted stop can never strand the thread ────────────────────────

it.effect(
  "warm failure W8: a stop interrupted MID-TEARDOWN still completes it — the thread restarts normally",
  () => {
    let cancelCount = 0;
    let promptIndex = 0;
    const script: FakeAcpScript = {
      // Only the FIRST prompt parks (the turn the stop cancels); the
      // restart's turn completes normally.
      onPrompt: (steps) => {
        promptIndex += 1;
        if (promptIndex === 1) {
          steps.emitText("working...");
          return;
        }
        steps.emitText("готово").respondOk();
      },
      onCancel: () => {
        cancelCount += 1;
      },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 100 });
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "работай" }),
      );
      yield* collector.waitForDelta("working");

      // The hostile shape: interrupt the stop AFTER it demonstrably began its
      // teardown (the settle's session/cancel reached the child ⇒ the claim
      // was made). The claim-to-completion region is uninterruptible, so the
      // teardown still runs to completion: the latch gets its resolver, the
      // child dies after the (tiny) grace, and the thread stays usable.
      const stopFiber = yield* Effect.forkChild(adapter.interruptTurn(THREAD_ID));
      yield* pollUntil(() => cancelCount >= 1, "the stop began its teardown (cancel sent)");
      yield* Fiber.interrupt(stopFiber);
      yield* Effect.ignore(Fiber.await(turnFiber).pipe(Effect.timeout("5 seconds")));

      // The restart COMPLETES (the latch resolves after the grace kill) and
      // the thread works — never a hang on a stranded teardown.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "снова" })
        .pipe(Effect.timeout("10 seconds"));
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

// ── W9 — interrupted sendTurn fiber: the turn still settles exactly once ─────

it.effect(
  "warm failure W9: an externally interrupted sendTurn still settles the turn once; the follow-up stop completes",
  () => {
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 100 });
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // Directly interrupting the forked fiber IS a genuine external interrupt
      // (the reactor-teardown shape) — parent-tie only matters for parent death.
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "работай" }),
      );
      yield* collector.waitForDelta("working");
      yield* Fiber.interrupt(turnFiber);

      // The onExit safety net settled the turn (catchCause frames are skipped
      // under external interruption) — the barrier is resolved, so the stop
      // completes instead of hanging.
      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("5 seconds"));
      yield* pollUntil(
        () => collector.events.some((event) => event.type === "session.exited"),
        "the stop settled the session",
      );
      const completions = collector.events.filter((event) => event.type === "turn.completed");
      assert.lengthOf(completions, 1, "the interrupted turn settled EXACTLY once");
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

// ── W10 — stopAll interrupted mid-grace: the kill/latch tail still runs ──────

it.effect(
  "warm failure W10: a stopAll RPC interrupted mid-grace still kills the fleet and frees the threads",
  () => {
    let killCount = 0;
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 400 });
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "работай" }),
      );
      yield* collector.waitForDelta("working");

      // Interrupt the stopAll AFTER the settle phase (session.exited observed
      // ⇒ the batch is inside its shared grace). The settle/kill/drain phase
      // is masked and the grace tail rides onExit — EITHER placement of the
      // interrupt still kills every child and resolves every latch.
      const stopAllFiber = yield* Effect.forkChild(adapter.stopAll());
      yield* pollUntil(
        () => collector.events.some((event) => event.type === "session.exited"),
        "stopAll settled the active session (inside the grace)",
      );
      yield* Fiber.interrupt(stopAllFiber);
      yield* Effect.ignore(Fiber.await(turnFiber).pipe(Effect.timeout("5 seconds")));

      yield* pollUntil(() => killCount >= 1, "the grace tail SIGKILLed the child anyway");
      // The thread is fully released: a fresh start completes (no stranded
      // latch) — proving the interrupted batch finished its bookkeeping.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onKill: () => {
              killCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);
