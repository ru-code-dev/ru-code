// ru-code (mid-turn wave, phase 2): THE RED DRAIN MATRIX — born-red by design.
//
// Every spec below asserts the mid-turn contract our server does NOT yet honour.
// They are expected to FAIL now and to go green in phase 3. The `.broken.test.ts`
// suffix is this repo's existing marker for a spec pinning a known gap rather
// than a regression (precedent: answersWire.broken.test.ts, subAgentV2Matrix.broken.test.ts).
//
// The whole file runs with the fake's `midTurnDrain` knob ON — the 1:1
// transcription of qwen 0.21.1's drain CALLER in qwen021MidTurnDrain.ts. Every
// rule the fake enforces (2s deadline, consecutive-timeout strikes, the
// -32601 permanent latch, the ten-item cap, the per-message prefix) traces to a
// qwen src line there, so a spec here cannot pass by satisfying our own guesses.
// Mapping table: WORKFLOW/wave-midturn-mapping-table.md.
//
// The suites next door run with the knob OFF and MUST stay green — they are this
// wave's regression anchor, and "off" is also a real engine (qwen 0.13.1 never
// polls; see R7, the turn-end flush that covers it).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { type ProviderAdapterError } from "../../../../provider/Errors.ts";
import { type ProviderAdapterShape } from "../../../../provider/Services/ProviderAdapter.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import {
  type FakeAcpScript,
  type FakeMidTurnDrainObservation,
  type PromptSteps,
} from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { QWEN_MAX_MID_TURN_DRAIN_ITEMS, qwenPrefixMidTurnText } from "./qwen021MidTurnDrain.ts";
import { collectAdapterEvents, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-midturn-p2-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Marker the test waits for to know turn 1 is genuinely streaming. */
const RUNNING = "TURN_IS_RUNNING";

/**
 * The adapter surface under test. Taken from the port's own shape rather than
 * inferred, so a signature change shows up here as a type error rather than as
 * a silently-`never` helper.
 */
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

/**
 * THE ENTRY POINT UNDER CONTRACT — the single place this file expresses "the
 * user sent a message while a turn was running".
 *
 * Today `sendTurn` is the only way a user message reaches the server, and it
 * dispatches a `session/prompt` unconditionally (QwenAdapter.ts:3135 overwrites
 * `ctx.activeTurnId`), which is exactly the damage these specs forbid. Phase 3
 * may keep this signature and route internally, or introduce a dedicated queue
 * API. If it introduces one, **change this helper and nothing else** — every
 * spec below is written against the observable wire and the drain, never against
 * which method was called.
 */
const userSendsMidTurn = (adapter: Adapter, threadId: ThreadId, input: string) =>
  Effect.forkChild(adapter.sendTurn({ threadId, input, runtimeMode: "approval-required" }));

/**
 * One inbound `session/prompt`, plus the ONLY fact that distinguishes "queued
 * and flushed after the turn" from "dispatched straight through the middle of
 * it": how many turns had already COMPLETED when it arrived. Without this a
 * flush spec passes on today's broken behaviour, since both produce the same
 * two prompt texts in the same order.
 */
interface ObservedPrompt {
  readonly text: string;
  readonly completedTurnsOnArrival: number;
}

interface DrainHarness {
  readonly drains: FakeMidTurnDrainObservation[];
  readonly prompts: ObservedPrompt[];
  readonly promptTexts: string[];
  readonly script: FakeAcpScript;
  /** Wired by `withRunningTurn` so `onPromptText` can read live turn state. */
  countCompletedTurns: () => number;
}

/**
 * A turn that streams a marker, pauses long enough for the test to send its
 * mid-turn message(s), then drains at the canonical tool-round boundary and
 * finishes. `drainCount` models several successive boundaries in one turn —
 * qwen polls at EVERY completed tool run, not once.
 */
const makeDrainHarness = (options: {
  readonly drainCount?: number;
  readonly timeoutMs?: number;
  readonly pauseMs?: number;
  readonly enableDrain?: boolean;
}): DrainHarness => {
  const drains: FakeMidTurnDrainObservation[] = [];
  const prompts: ObservedPrompt[] = [];
  const promptTexts: string[] = [];
  const drainCount = options.drainCount ?? 1;
  const pauseMs = options.pauseMs ?? 400;
  let promptIndex = 0;

  const harness: DrainHarness = {
    drains,
    prompts,
    promptTexts,
    countCompletedTurns: () => 0,
    script: undefined as unknown as FakeAcpScript,
  };

  const script: FakeAcpScript = {
    onPromptText: (text) => {
      promptTexts.push(text);
      prompts.push({ text, completedTurnsOnArrival: harness.countCompletedTurns() });
    },
    ...(options.enableDrain === false
      ? {}
      : {
          midTurnDrain: {
            onDrain: (observation) => drains.push(observation),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          },
        }),
    onPrompt: (steps: PromptSteps) => {
      const isFirstPrompt = promptIndex === 0;
      promptIndex += 1;
      if (!isFirstPrompt) {
        // Any LATER prompt is either the turn-end flush (R7) or the forbidden
        // second prompt (R1) — either way it must settle immediately so the
        // test never hangs waiting on it.
        steps.emitText("second-turn-reply").respondOk();
        return;
      }
      let chain = steps.emitText(RUNNING).sleep(pauseMs);
      for (let index = 0; index < drainCount; index += 1) {
        chain = chain.drainMidTurn();
        if (index < drainCount - 1) chain = chain.sleep(50);
      }
      chain.respondOk();
    },
  };
  return Object.assign(harness, { script });
};

/** Boilerplate: start a session, run turn 1, hand the body the live adapter. */
const withRunningTurn = (
  harness: DrainHarness,
  threadName: string,
  body: (input: {
    readonly adapter: Adapter;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(threadName);
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);
      harness.countCompletedTurns = () =>
        collector.events.filter((event) => event.type === "turn.completed").length;
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(
        adapter.sendTurn({ threadId, input: "first", runtimeMode: "approval-required" }),
      );
      // Turn 1 is genuinely streaming from here on.
      yield* collector.waitForDelta(RUNNING);
      yield* body({ adapter, threadId });
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(harness.script), testServices)),
      TestClock.withLive,
    );
  });

// ── R1 — the core exchange: queued, not prompted; delivered by the drain ─────

it.effect(
  "midturn R1 (RED): a mid-turn send is delivered by the drain and NEVER as a second session/prompt",
  () =>
    Effect.gen(function* () {
      const harness = makeDrainHarness({});
      yield* withRunningTurn(harness, "midturn-r1", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          yield* userSendsMidTurn(adapter, threadId, "steer me");
          yield* pollUntil(() => harness.drains.length >= 1, "first drain");
        }),
      );

      const drain = harness.drains[0];
      assert.isDefined(drain, "the agent must have drained once");
      if (drain === undefined) return;

      // (a) the message reached the RUNNING turn, prefixed exactly as qwen does
      //     (utils/midTurnUserMessage.ts:10-11).
      assert.deepStrictEqual(drain.deliveredTexts, [qwenPrefixMidTurnText("steer me")]);
      // (b) the host answered — no rejection, so the channel survives.
      assert.strictEqual(drain.outcome?.kind, "ok");
      assert.isFalse(drain.permanentlyDisabled, "answering must not disable the channel");
      // (c) THE INVARIANT: exactly one session/prompt for the whole exchange.
      assert.deepStrictEqual(
        harness.promptTexts,
        ["first"],
        "a mid-turn send must NEVER become a second session/prompt (it aborts the turn at qwen: Session.ts:2285)",
      );
    }),
);

// ── R2 — message boundaries survive ──────────────────────────────────────────

it.effect(
  "midturn R2 (RED): two mid-turn sends arrive as two separately-prefixed messages, in order",
  () =>
    Effect.gen(function* () {
      const harness = makeDrainHarness({});
      yield* withRunningTurn(harness, "midturn-r2", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          yield* userSendsMidTurn(adapter, threadId, "first thought");
          yield* userSendsMidTurn(adapter, threadId, "second thought");
          yield* pollUntil(() => harness.drains.length >= 1, "first drain");
        }),
      );

      const drain = harness.drains[0];
      assert.isDefined(drain);
      if (drain === undefined) return;
      // Per-message prefixing is qwen's own loop (Session.ts:4900 inside the
      // :4866 `for`), so two messages can never arrive as one blob.
      assert.deepStrictEqual(drain.deliveredTexts, [
        qwenPrefixMidTurnText("first thought"),
        qwenPrefixMidTurnText("second thought"),
      ]);
      assert.deepStrictEqual(harness.promptTexts, ["first"]);
    }),
);

// ── R3 — the ten-item cap must be OURS, not qwen's ───────────────────────────

it.effect(
  "midturn R3 (RED): more than ten queued messages spill to the NEXT drain instead of being destroyed",
  () =>
    Effect.gen(function* () {
      const total = QWEN_MAX_MID_TURN_DRAIN_ITEMS + 2;
      const harness = makeDrainHarness({ drainCount: 2 });
      yield* withRunningTurn(harness, "midturn-r3", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          for (let index = 0; index < total; index += 1) {
            yield* userSendsMidTurn(adapter, threadId, `msg-${index}`);
          }
          yield* pollUntil(() => harness.drains.length >= 2, "two drains");
        }),
      );

      const [first, second] = harness.drains;
      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;

      // qwen's `capMidTurnDrainItems` (Session.ts:662-669) SLICES — items 11+ of
      // a single answer are destroyed, and since answering means splicing our
      // own queue, they would be lost from both sides at once. The cap must
      // therefore be applied by US, with the surplus kept queued.
      assert.strictEqual(
        first.deliveredTexts.length,
        QWEN_MAX_MID_TURN_DRAIN_ITEMS,
        "the first answer must carry at most ten items",
      );
      assert.deepStrictEqual(
        [...first.deliveredTexts, ...second.deliveredTexts],
        Array.from({ length: total }, (_, index) => qwenPrefixMidTurnText(`msg-${index}`)),
        "every queued message must survive across the two drains, in order",
      );
    }),
);

// ── R4 / R5 — the empty answer, and never losing the channel ─────────────────

it.effect(
  "midturn R4 (RED): with nothing queued the host answers {items: [], hasQueuedPrompt: false}, not -32601",
  () =>
    Effect.gen(function* () {
      const harness = makeDrainHarness({});
      yield* withRunningTurn(harness, "midturn-r4", () =>
        pollUntil(() => harness.drains.length >= 1, "first drain"),
      );

      const drain = harness.drains[0];
      assert.isDefined(drain);
      if (drain === undefined) return;
      assert.strictEqual(drain.outcome?.kind, "ok", "an empty queue is still an ANSWER");
      assert.deepStrictEqual(drain.deliveredTexts, []);
      // `items` present-and-empty is what makes this VALID (Session.ts:769-796);
      // `{}` would parse but flip `reliable` false and block the todoStopGuard.
      assert.isTrue(drain.reliable, "the empty answer must include `items` so it validates");
      assert.isFalse(drain.hasQueuedPrompt);
      assert.isFalse(drain.permanentlyDisabled);
    }),
);

it.effect(
  "midturn R5 (RED): repeated empty drains never latch the channel off for the session",
  () =>
    Effect.gen(function* () {
      // Four boundaries — one more than MAX_TIMEOUT_STRIKES, so a responder that
      // silently stalls instead of answering would latch off here.
      const harness = makeDrainHarness({ drainCount: 4 });
      yield* withRunningTurn(harness, "midturn-r5", () =>
        pollUntil(() => harness.drains.length >= 4, "four drains"),
      );

      assert.strictEqual(harness.drains.length, 4);
      for (const [index, drain] of harness.drains.entries()) {
        assert.isFalse(drain.skipped, `drain ${index} must not be skipped`);
        assert.strictEqual(drain.outcome?.kind, "ok", `drain ${index} must be answered`);
        assert.strictEqual(drain.timeoutStrikes, 0, `drain ${index} must not accrue a strike`);
        assert.isFalse(drain.permanentlyDisabled, `drain ${index} must keep the channel alive`);
      }
    }),
);

// ── R6 — the answer must not wait on persistence (P0 scream #1) ──────────────

it.effect(
  "midturn R6 (RED): the drain is answered from an in-memory splice, far inside a tight deadline",
  () =>
    Effect.gen(function* () {
      // 250ms — an eighth of qwen's real 2s budget. This is deliberately far
      // tighter than production: inbound ext requests are dispatched INLINE on
      // effect-acp's stdin pump (protocol.ts:458-462, vs the queued core path at
      // :342), so a responder that awaits I/O does not merely risk the deadline,
      // it stalls every inbound frame while it waits. Persistence must be
      // write-through, off the drain path.
      const harness = makeDrainHarness({ timeoutMs: 250 });
      yield* withRunningTurn(harness, "midturn-r6", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          yield* userSendsMidTurn(adapter, threadId, "fast please");
          yield* pollUntil(() => harness.drains.length >= 1, "first drain");
        }),
      );

      const drain = harness.drains[0];
      assert.isDefined(drain);
      if (drain === undefined) return;
      assert.strictEqual(drain.outcome?.kind, "ok", "the answer must arrive inside 250ms");
      assert.strictEqual(drain.timeoutStrikes, 0, "no timeout strike may be accrued");
      assert.deepStrictEqual(drain.deliveredTexts, [qwenPrefixMidTurnText("fast please")]);
    }),
);

// ── R7 — the no-polling engine: turn-end auto-flush ──────────────────────────

it.effect(
  "midturn R7 (RED): against an engine that never polls, the queue flushes as the NEXT session/prompt",
  () =>
    Effect.gen(function* () {
      // Knob OFF = qwen 0.13.1 (`QWEN_V1_POLLS_MID_TURN === false`): no drain
      // exists, so the ONLY way a mid-turn message can ever be delivered is our
      // own turn-end flush. Short pause: nothing waits on a drain here.
      const harness = makeDrainHarness({ enableDrain: false, pauseMs: 250 });
      yield* withRunningTurn(harness, "midturn-r7", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          yield* userSendsMidTurn(adapter, threadId, "flush me");
          // Turn 1 finishes on its own; the flush must follow it, not race it.
          yield* pollUntil(() => harness.promptTexts.length >= 2, "the flush prompt");
        }),
      );

      assert.strictEqual(harness.drains.length, 0, "a v1 engine must never be drained");
      assert.deepStrictEqual(harness.promptTexts, ["first", "flush me"]);

      // THE part that separates a flush from today's straight-through dispatch:
      // the flush prompt must arrive only once turn 1 has COMPLETED. Comparing
      // prompt texts alone cannot see the difference — both orders are identical.
      const flush = harness.prompts.find((prompt) => prompt.text === "flush me");
      assert.isDefined(flush);
      if (flush === undefined) return;
      assert.isAtLeast(
        flush.completedTurnsOnArrival,
        1,
        "the flush must follow turn 1's completion; arriving at 0 completed turns means it was dispatched MID-TURN (and would abort the turn at qwen, Session.ts:2285)",
      );
    }),
);

// ── R8 — stop resets the queue; nothing auto-fires afterwards ────────────────

it.effect(
  "midturn R8 (RED): a stop resets the queue — the pending message is never delivered or flushed",
  () =>
    Effect.gen(function* () {
      const harness = makeDrainHarness({ enableDrain: false, pauseMs: 3_000 });
      const threadId = ThreadId.make("midturn-r8");
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const collector = yield* collectAdapterEvents(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* Effect.forkChild(
          adapter.sendTurn({ threadId, input: "first", runtimeMode: "approval-required" }),
        );
        yield* collector.waitForDelta(RUNNING);
        yield* userSendsMidTurn(adapter, threadId, "never send this");

        // A REAL grace period before the stop, deliberately. Without it this
        // spec passes by winning a race — the forked send simply loses to the
        // force-kill and never dispatches, which proves nothing about a queue.
        // 400ms is far more than today's straight-through dispatch needs, so a
        // pass here means the message was genuinely withheld, not merely late.
        yield* Effect.sleep("400 millis");

        // The user hits Stop while the message is still pending.
        yield* adapter.stopSession(threadId).pipe(Effect.timeout("10 seconds"));
        // And nothing may fire afterwards either.
        yield* Effect.sleep("400 millis");
        yield* collector.stop;
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(harness.script), testServices)),
        TestClock.withLive,
      );

      // qwen's own stop path does NOT drain either (Session.ts:4516-4522 skips
      // the drain when the signal is aborted), so both halves agree: after a
      // stop, nothing queued may ever reach the model.
      assert.notInclude(
        harness.promptTexts,
        "never send this",
        "a stopped queue must be RESET — nothing auto-fires after a stop",
      );
      assert.deepStrictEqual(harness.promptTexts, ["first"]);
    }),
);
