// ru-code: session-lifecycle coverage over the REAL QwenAdapter + in-memory fake ACP
// agent. Fills the tracked gaps (qwen-acp-features.md §1c/1d/1g):
//   S1 startSession — handshake ok registers a session; a wedged ("hang") boot trips
//      the bounded start timeout into a TYPED error (no hang); a failing ("error")
//      boot surfaces cleanly (a fail reason, not a defect).
//   S2 stop / teardown — stopSession goes through the end-force SIGKILL path (the fake
//      handle's kill() fires), the session ends, session.exited is emitted, no hang.
//   S3 interrupt — a mid-turn interrupt labels the turn `cancelled` (not failed), tears
//      the session down, and sends the graceful session/cancel before the background
//      SIGKILL (ru-code warm engine: instant-settle cancel-then-kill stop).
//   S4 resume — a valid resume cursor reconnects via session/load; an invalid/absent
//      cursor falls back to a fresh session/new (no crash).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-lifecycle-thread");

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-lifecycle-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const NOOP_SCRIPT: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };

// ── S1 — startSession handshake ──────────────────────────────────────────────

it.effect("qwen S1 startSession: a healthy handshake registers a live session", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
    const sessions = yield* adapter.listSessions();
    assert.strictEqual(
      sessions.some((s) => s.threadId === THREAD_ID),
      true,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(NOOP_SCRIPT), testServices)),
    TestClock.withLive,
  ),
);

it.effect(
  "qwen S1 startSession: a wedged (hang) boot trips the start timeout into a typed error",
  () =>
    Effect.gen(function* () {
      // Tiny start timeout so the scripted `session/new` hang converts to a typed
      // failure without a real-time wait (live clock, ~150ms).
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        sessionStartTimeoutMs: 150,
      });
      const startExit = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );
      assert.strictEqual(Exit.isFailure(startExit), true);
      if (!Exit.isFailure(startExit)) return;
      // A settled, TYPED failure (a fail reason) — not a hang, not a defect.
      const failure = startExit.cause.reasons.find(Cause.isFailReason);
      assert.isDefined(failure, "start times out into a typed error, not a defect/hang");
      // Session was not registered.
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer({ ...NOOP_SCRIPT, startBehavior: "hang" }),
          testServices,
        ),
      ),
      TestClock.withLive,
    ),
);

it.effect("qwen S1 startSession: a failing (error) boot surfaces cleanly (no defect)", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const startExit = yield* Effect.exit(
      adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      }),
    );
    assert.strictEqual(Exit.isFailure(startExit), true);
    if (!Exit.isFailure(startExit)) return;
    const failure = startExit.cause.reasons.find(Cause.isFailReason);
    assert.isDefined(failure, "start handshake error is a surfaced fail reason");
    // No defect leaked through.
    assert.isUndefined(startExit.cause.reasons.find(Cause.isDieReason));
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer({ ...NOOP_SCRIPT, startBehavior: "error" }),
        testServices,
      ),
    ),
    TestClock.withLive,
  ),
);

// ── S2 — stop / teardown (end-force SIGKILL) ─────────────────────────────────

it.effect("qwen S2 stopSession: tears the session down via the end-force SIGKILL path", () => {
  let killCount = 0;
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);

    yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
    yield* Deferred.await(exited).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // The end-force teardown SIGKILLed the child (fake handle kill() fired) and the
    // session is gone; session.exited surfaced.
    assert.isAtLeast(killCount, 1, "forceKill invoked the child's kill()");
    assert.isDefined(events.find((e) => e.type === "session.exited"));
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(NOOP_SCRIPT, {
          onKill: () => {
            killCount += 1;
          },
        }),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── S3 — interrupt (Stop) labels the turn cancelled ──────────────────────────

it.effect(
  // ru-code (warm engine): title updated — Stop is now instant-settle cancel-then-kill.
  "qwen S3 interrupt: mid-turn Stop labels the turn cancelled (instant settle, cancel then kill)",
  () => {
    let cancelCount = 0;
    // A turn that streams a chunk then parks (no terminal response) — an in-flight
    // prompt for interruptTurn to cancel.
    const script: FakeAcpScript = {
      onCancel: () => {
        cancelCount += 1;
      },
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const events: ProviderRuntimeEvent[] = [];
      const streaming = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "content.delta" && event.payload.delta.includes("working")
              ? Deferred.succeed(streaming, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "do work" }),
      );
      // Wait until the prompt is in flight (the chunk streamed), then interrupt.
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));
      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));

      // sendTurn recovers to success (a cancel is not a failure), so join returns.
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      // ru-code (warm engine, acp-process-pool): the instant-settle Stop
      // publishes turn.completed/session.exited and returns with almost no
      // yields afterwards, and the fake agent processes the (now expected)
      // graceful `session/cancel` asynchronously — await the delivered state
      // instead of assuming the old teardown's scheduling slack.
      const stopSettled = () =>
        cancelCount === 1 &&
        events.some((e) => e.type === "turn.completed") &&
        events.some((e) => e.type === "session.exited");
      yield* Effect.gen(function* () {
        while (!stopSettled()) {
          yield* Effect.sleep("10 millis");
        }
      }).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      const completions = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed",
      );
      assert.lengthOf(completions, 1);
      assert.strictEqual(completions[0]!.payload.state, "cancelled");
      // ru-code (warm engine): Stop now sends the graceful session/cancel
      // BEFORE the background SIGKILL — that is what lets qwen reap detached
      // shell process-groups (was: cancelCount === 0 under bare force-kill).
      assert.strictEqual(cancelCount, 1, "Stop sends exactly one session/cancel");
      // The session was torn down.
      assert.isDefined(events.find((e) => e.type === "session.exited"));
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

// ── S4 — resume (session/load reconnect vs fresh fallback) ───────────────────

it.effect("qwen S4 resume: a valid cursor reconnects via session/load", () => {
  const loadSessionIds: string[] = [];
  let createSessionCount = 0;
  const script: FakeAcpScript = {
    onLoadSession: (sessionId) => {
      loadSessionIds.push(sessionId);
    },
    onCreateSession: () => {
      createSessionCount += 1;
    },
    onPrompt: (steps) => steps.respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const session = yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
    });
    // Reconnect path: session/load ran with the cursor's sessionId; fresh new was NOT.
    assert.deepStrictEqual(loadSessionIds, [FAKE_SESSION_ID]);
    assert.strictEqual(createSessionCount, 0);
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
    // The resumed session round-trips the same cursor.
    assert.deepStrictEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: FAKE_SESSION_ID,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});

it.effect("qwen S4 resume: an invalid cursor falls back to a fresh session/new (no crash)", () => {
  const loadSessionIds: string[] = [];
  let createSessionCount = 0;
  const script: FakeAcpScript = {
    onLoadSession: (sessionId) => {
      loadSessionIds.push(sessionId);
    },
    onCreateSession: () => {
      createSessionCount += 1;
    },
    onPrompt: (steps) => steps.respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    // schemaVersion mismatch ⇒ parseQwenResume rejects it ⇒ fresh start.
    const session = yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: { schemaVersion: 99, sessionId: "stale-session" },
    });
    assert.strictEqual(createSessionCount, 1, "fresh session/new ran");
    assert.lengthOf(loadSessionIds, 0, "session/load was NOT attempted for an invalid cursor");
    assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
    assert.deepStrictEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: FAKE_SESSION_ID,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});
