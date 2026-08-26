// ru-code (mid-turn wave, phase 1 — BASELINE LOCK): the two server-side facts
// this wave changes, pinned as they are TODAY, over the REAL QwenAdapter and the
// REAL effect-acp wire. Every assertion here is expected to be INVERTED by a
// later phase; that is the point — a phase-3 diff that does not flip these is a
// phase-3 that did not land.
//
//   B1 — the drain responder does not exist. qwen 0.21.1 calls the HOST back
//        mid-turn with `craft/drainMidTurnQueue`
//        (Session.ts:4707 `this.client.extMethod(MID_TURN_QUEUE_DRAIN_METHOD,
//        {sessionId})`, constant at acp-bridge/src/bridgeTypes.ts:578). Our host
//        registers no handler for it, so effect-acp answers `-32601`
//        (client.ts:397 `Effect.fail(AcpError.AcpRequestError.methodNotFound(method))`
//        → errors.ts:303-305 `code: -32601`). qwen classifies exactly that code
//        as a PERMANENT, one-strike, per-session disable (Session.ts:4776-4783,
//        `errorCode === -32601` → `this.midTurnDrainUnavailable = true`), so the
//        channel is dead for the session's whole lifetime today.
//
//   B2 — the todoStopGuard variant of the same call is rejected identically. The
//        agent adds `todoStopGuardWatchQueuedPrompt: true` to the params on the
//        guard path (Session.ts:4708-4711); the method name is unchanged, so the
//        method-not-found rejection is the same. Pinned so a phase-3 responder
//        that matches on params instead of the method name fails here.
//
//   B3 — NOTHING SERVER-SIDE stops a second prompt from landing mid-turn. The
//        "a mid-turn send never reaches a second session/prompt" guarantee this
//        wave inherits is enforced ONLY in the browser
//        (apps/web/src/ru-code/composer/sendGate.ts:34 + :69-77, `isQwenRunningTurn`).
//        `QwenAdapter.sendTurn` has no concurrency guard — it overwrites
//        `ctx.activeTurnId` (QwenAdapter.ts:3135) and dispatches. This spec makes
//        that CLIENT-ONLY-ness a fact on the record, because the wave's own
//        invariant ("NEVER a second session/prompt mid-turn") is the thing that
//        must hold once the composer stops blocking.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript, type FakeExtRequestOutcome } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

/**
 * qwen 0.21.1's constant, transcribed 1:1 —
 * `packages/acp-bridge/src/bridgeTypes.ts:578`:
 *   `export const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';`
 * Duplicated here on purpose: phase 3 must import ITS copy from a ru-code zone
 * module, and this literal stays the independent witness that the two agree.
 */
const MID_TURN_QUEUE_DRAIN_METHOD = "craft/drainMidTurnQueue";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-midturn-p1-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// ── B1 / B2 — the drain responder answers (WAS: did not exist) ───────────────

const drainProbeScript = (
  params: Record<string, unknown>,
  record: (outcome: FakeExtRequestOutcome) => void,
): FakeAcpScript => ({
  // The probe runs BETWEEN two assistant chunks, i.e. exactly where qwen puts
  // it: strictly between model rounds of a still-running turn, never mid-stream
  // (Session.ts:4555 `#buildNextMessageAfterToolRun`).
  onPrompt: (steps) =>
    steps
      .emitText("before-drain")
      .extRequest(MID_TURN_QUEUE_DRAIN_METHOD, params, record)
      .emitText("after-drain")
      .respondOk(),
});

const runDrainProbe = (params: Record<string, unknown>, threadName: string) =>
  Effect.gen(function* () {
    const outcomes: FakeExtRequestOutcome[] = [];
    const threadId = ThreadId.make(threadName);
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter
        .sendTurn({ threadId, input: "probe the drain", runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(
            drainProbeScript(params, (outcome) => {
              outcomes.push(outcome);
            }),
          ),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
    return outcomes;
  });

it.effect(
  "midturn B1: the host ANSWERS craft/drainMidTurnQueue (responder registered by exact method name)",
  () =>
    Effect.gen(function* () {
      const outcomes = yield* runDrainProbe(
        { sessionId: FAKE_SESSION_ID },
        "midturn-b1-drain-probe",
      );

      assert.strictEqual(
        outcomes.length,
        1,
        "the agent's drain call must be answered exactly once",
      );
      const outcome = outcomes[0]!;
      // WAS (phase 1): kind "error", code -32601, message naming the method.
      // The responder is now registered by EXACT METHOD NAME, so the call is
      // ANSWERED and qwen's permanent-disable latch (Session.ts:4774-4783)
      // never trips.
      assert.strictEqual(
        outcome.kind,
        "ok",
        `the drain responder must answer — got kind "${outcome.kind}"`,
      );
      if (outcome.kind !== "ok") return;
      // Nothing was queued, so this is the canonical EMPTY answer. `items`
      // present-and-empty is what makes it VALID (Session.ts:769-796); `{}`
      // would parse but flip `reliable` and block qwen's todoStopGuard.
      assert.deepStrictEqual(outcome.result, { items: [], hasQueuedPrompt: false });
    }),
);

it.effect("midturn B2: the todoStopGuard variant of the drain params is answered identically", () =>
  Effect.gen(function* () {
    // Session.ts:4708-4711 — same method, one extra param on the guard path.
    const outcomes = yield* runDrainProbe(
      { sessionId: FAKE_SESSION_ID, todoStopGuardWatchQueuedPrompt: true },
      "midturn-b2-drain-probe-guard",
    );

    assert.strictEqual(outcomes.length, 1);
    const outcome = outcomes[0]!;
    // WAS (phase 1): rejected with -32601, exactly as B1 was.
    // Dispatch is by METHOD NAME, so the extra param changes nothing — which
    // is what this spec exists to keep true. `handleExtRequest` schema-decodes
    // the params first and `todoStopGuardWatchQueuedPrompt` is declared
    // optional in `MidTurnDrainRequest`, so it decodes instead of erroring.
    assert.strictEqual(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepStrictEqual(outcome.result, { items: [], hasQueuedPrompt: false });
  }),
);

// ── B3 — the "no second prompt mid-turn" guarantee is SERVER-SIDE now ────────

it.effect(
  "midturn B3: a sendTurn during a running turn is QUEUED — it never becomes a second session/prompt",
  () =>
    Effect.gen(function* () {
      const promptTexts: string[] = [];
      const threadId = ThreadId.make("midturn-b3-second-prompt");
      // Neither prompt is ever answered: with no terminal step the fake parks
      // the prompt (fakeAcpCore `Deferred.await(cancelled)`), which holds turn 1
      // open for real while turn 2 is dispatched. Both forked turn fibers are
      // interrupted at scope close.
      const parkingScript: FakeAcpScript = {
        onPromptText: (text) => promptTexts.push(text),
        onPrompt: (steps) => steps.emitText("streaming…"),
      };

      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        yield* Effect.forkChild(
          adapter.sendTurn({ threadId, input: "first", runtimeMode: "approval-required" }),
        );
        yield* pollUntil(() => promptTexts.length === 1, "first session/prompt");

        // The turn is genuinely still running here — the agent has not answered
        // prompt #1. Phase 1 proved a second `sendTurn` here reached the agent
        // as a second `session/prompt`; the composer was the only thing stopping
        // it, and phase 3 relaxed the composer.
        yield* Effect.forkChild(
          adapter.sendTurn({ threadId, input: "second", runtimeMode: "approval-required" }),
        );

        // WAS (phase 1): pollUntil(promptTexts.length === 2) succeeded, and the
        // assertion below expected ["first", "second"].
        //
        // A negative needs a real window, not an instant read: give the second
        // send far longer than a dispatch would need, then prove it still never
        // reached the wire. 600ms against a dispatch path that took ~0ms to
        // land in phase 1.
        yield* Effect.sleep("600 millis");

        // THE INVARIANT, now enforced SERVER-SIDE: a mid-turn send is queued for
        // the drain / turn-end flush and never becomes a second prompt. Against
        // a real qwen a second prompt aborts turn #1
        // (Session.ts:2285 `this.pendingPrompt?.abort()`) — that is the damage
        // this guard makes unreachable, independently of any browser.
        assert.deepStrictEqual(
          promptTexts,
          ["first"],
          "a mid-turn send must be QUEUED, never dispatched as a second session/prompt",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(parkingScript), testServices)),
        TestClock.withLive,
      );
    }),
);
