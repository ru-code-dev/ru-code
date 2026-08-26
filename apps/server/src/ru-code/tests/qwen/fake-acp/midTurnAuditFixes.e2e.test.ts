// ru-code (mid-turn wave, phase 4): the adversary's findings, as specs.
//
// One file per audit round, so a reviewer can read the round's evidence in one
// place. Each spec names the finding it pins and was RED before the fix — the
// digests are in WORKFLOW/wave-midturn-phase4-fixes.md.
//
// These are e2e over the REAL QwenAdapter and the real effect-acp wire, the same
// harness R1-R8 use, because every finding here is about behaviour at a seam
// rather than about a pure function.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  QwenSettings,
  ThreadId,
  type ChatAttachment,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
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
import { collectAdapterEvents, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-midturn-p4-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const RUNNING = "TURN_IS_RUNNING";
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

/** A 1×1 PNG — the smallest thing that is genuinely an image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Harness {
  readonly drains: FakeMidTurnDrainObservation[];
  readonly promptTexts: string[];
  readonly script: FakeAcpScript;
}

const makeHarness = (options: {
  readonly drain?: boolean;
  readonly pauseMs?: number;
  readonly failFirstTurn?: boolean;
}): Harness => {
  const drains: FakeMidTurnDrainObservation[] = [];
  const promptTexts: string[] = [];
  let promptIndex = 0;
  const script: FakeAcpScript = {
    onPromptText: (text) => promptTexts.push(text),
    ...(options.drain === false ? {} : { midTurnDrain: { onDrain: (o) => drains.push(o) } }),
    onPrompt: (steps: PromptSteps) => {
      const first = promptIndex === 0;
      promptIndex += 1;
      if (!first) {
        steps.emitText("later-turn-reply").respondOk();
        return;
      }
      const chain = steps.emitText(RUNNING).sleep(options.pauseMs ?? 500);
      if (options.failFirstTurn) {
        // A REJECTED prompt: the turn fails, but the session lives on — the
        // classifier's whole purpose is to keep the thread usable.
        chain.respondError(-32000, "synthetic turn failure");
        return;
      }
      (options.drain === false ? chain : chain.drainMidTurn()).respondOk();
    },
  };
  return { drains, promptTexts, script };
};

const withRunningTurn = (
  harness: Harness,
  threadName: string,
  body: (input: {
    readonly adapter: Adapter;
    readonly threadId: ThreadId;
    readonly events: ReadonlyArray<ProviderRuntimeEvent>;
    readonly attachmentsDir: string;
  }) => Effect.Effect<void, never, Scope.Scope | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(threadName);
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
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
      yield* body({
        adapter,
        threadId,
        events: collector.events,
        attachmentsDir: config.attachmentsDir,
      });
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(harness.script), testServices)),
      TestClock.withLive,
    );
  });

/**
 * Write a real image into the attachments store and return its wire shape.
 * Effect's FileSystem, not node:fs — the repo bans node builtins here.
 */
const writeAttachment = Effect.fn("writeAttachment")(function* (
  attachmentsDir: string,
  id: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(attachmentsDir, { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFile(
    path.join(attachmentsDir, `${id}.png`),
    new Uint8Array(Buffer.from(PNG_BASE64, "base64")),
  );
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 70,
  } satisfies ChatAttachment;
});

const marksOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "message.delivery-state"
      ? [{ messageId: event.payload.messageId, deliveryState: event.payload.deliveryState }]
      : [],
  );

// ── B1 (BLOCKER) — an ATTACHMENT-ONLY mid-turn send must never dispatch ──────

it.effect(
  "midturn A1 (B1): an attachment-only mid-turn send is QUEUED — it never becomes a second session/prompt",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      yield* withRunningTurn(harness, "midturn-a1", ({ adapter, threadId, attachmentsDir }) =>
        Effect.gen(function* () {
          const attachment = yield* writeAttachment(attachmentsDir, "a1attach").pipe(Effect.orDie);
          // NO text at all. Before the fix `tryQueueMidTurnMessage` returned
          // undefined on `!text` and the send fell straight through to an
          // ordinary dispatch — which at qwen aborts the running turn
          // (Session.ts:2285).
          yield* Effect.forkChild(
            adapter.sendTurn({
              threadId,
              attachments: [attachment],
              messageId: MessageId.make("a1-message"),
              runtimeMode: "approval-required",
            }),
          );
          yield* pollUntil(() => harness.drains.length >= 1, "the drain");
        }),
      );

      assert.deepStrictEqual(
        harness.promptTexts,
        ["first"],
        "an attachment-only send must be queued, not dispatched",
      );
    }),
);

// ── M1 — attachments must actually travel, not be silently dropped ───────────

it.effect("midturn A2 (M1): a queued message's IMAGE reaches the model through the drain", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    yield* withRunningTurn(harness, "midturn-a2", ({ adapter, threadId, attachmentsDir }) =>
      Effect.gen(function* () {
        const attachment = yield* writeAttachment(attachmentsDir, "a2attach").pipe(Effect.orDie);
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "what is wrong here?",
            attachments: [attachment],
            messageId: MessageId.make("a2-message"),
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(() => harness.drains.length >= 1, "the drain");
      }),
    );

    const drain = harness.drains[0];
    assert.isDefined(drain);
    if (drain === undefined) return;
    // qwen's own validator accepts image blocks in a drain item
    // (Session.ts:558-584: `image` needs `mimeType` starting "image/" and a
    // `data` string; only `resource_link` is rejected). Dropping them was our
    // choice, not a protocol limit.
    const blocks = drain.deliveredContent.flat();
    assert.isTrue(
      blocks.some((block) => block.type === "text" && block.text.includes("what is wrong here?")),
      "the text must travel",
    );
    assert.isTrue(
      blocks.some((block) => block.type === "image" && block.mimeType === "image/png"),
      "the IMAGE must travel too — silently dropping it while marking delivered is a lie",
    );
  }),
);

// ── M2 — a FAILED turn must not strand the queue ─────────────────────────────

it.effect("midturn A3 (M2): a failed turn leaves NO message stuck pending", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ drain: false, failFirstTurn: true, pauseMs: 800 });
    yield* withRunningTurn(harness, "midturn-a3", ({ adapter, threadId, events }) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "queued behind a doomed turn",
            messageId: MessageId.make("a3-message"),
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(() => marksOf(events).length >= 1, "the pending mark");
        // The turn now fails. Every queued message must reach a TERMINAL mark —
        // the plan allows delivered or not-delivered, but never a clock that
        // stays forever, and never silent injection into a later, unrelated turn.
        yield* pollUntil(
          () => marksOf(events).some((mark) => mark.deliveryState !== "pending"),
          "a terminal mark after the failure",
        );
        const terminal = marksOf(events).filter((mark) => mark.deliveryState !== "pending");
        assert.isNotEmpty(terminal, "a failed turn must terminalise its queue");
        assert.notInclude(
          harness.promptTexts,
          "queued behind a doomed turn",
          "a stranded message must NEVER be injected into a later, unrelated turn",
        );
      }),
    );
  }),
);

// ── M4 — the flush must mark AFTER a successful handoff, never before ────────

it.effect("midturn A4 (M4): a flush whose prompt FAILS must not leave the mark delivered", () =>
  Effect.gen(function* () {
    // Turn 1 succeeds so the flush runs; the SECOND prompt (the flush itself)
    // is rejected by the fake, so the handoff never happened.
    const drains: FakeMidTurnDrainObservation[] = [];
    const promptTexts: string[] = [];
    let promptIndex = 0;
    const script: FakeAcpScript = {
      onPromptText: (text) => promptTexts.push(text),
      onPrompt: (steps: PromptSteps) => {
        const first = promptIndex === 0;
        promptIndex += 1;
        if (!first) {
          steps.respondError(-32001, "flush prompt rejected");
          return;
        }
        steps.emitText(RUNNING).sleep(500).respondOk();
      },
    };
    const harness: Harness = { drains, promptTexts, script };

    yield* withRunningTurn(harness, "midturn-a4", ({ adapter, threadId, events }) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "flush me",
            messageId: MessageId.make("a4-message"),
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(() => marksOf(events).length >= 1, "the pending mark");
        yield* pollUntil(() => promptTexts.length >= 2, "the flush prompt attempt");
        yield* pollUntil(
          () => marksOf(events).some((mark) => mark.deliveryState !== "pending"),
          "a terminal mark after the failed flush",
        );

        const terminal = marksOf(events).filter((mark) => mark.deliveryState !== "pending");
        assert.deepStrictEqual(
          terminal.map((mark) => mark.deliveryState),
          ["not-delivered"],
          "a flush that FAILED must never report delivered — the model never saw it",
        );
      }),
    );
  }),
);

// ── SB6 — the latch, proven POSITIVELY over the real wire ───────────────────
//
// Every matrix spec asserts `timeoutStrikes === 0` and `permanentlyDisabled ===
// false` — exactly the values a fake that had LOST its strike logic would also
// produce, so those rules rested on inspection alone. A6 drives the -32601 arm
// for real; the strike-counting arithmetic is driven positively as a unit in
// `tests/qwen/acp/qwen021MidTurnDrain.test.ts`, because a genuine 2s stall
// cannot be produced through an adapter whose responder is synchronous by
// construction — that impossibility is the design working, not a gap.

it.effect(
  "midturn A6 (SB6): an UNREGISTERED method really does yield -32601 and latch immediately",
  () =>
    Effect.gen(function* () {
      // Drives the fake's permanent-latch path positively, using a method the
      // host does not register. This is the exact classification qwen applies
      // (Session.ts:4775: `errorCode === -32601` ⇒ permanent, one strike) and the
      // reason the drain must be registered by EXACT NAME rather than via the
      // unknown-handler.
      const outcomes: Array<{ readonly kind: string; readonly code: number | undefined }> = [];
      const script: FakeAcpScript = {
        onPrompt: (steps: PromptSteps) => {
          steps
            .emitText(RUNNING)
            .extRequest("craft/thisMethodIsNotRegistered", { sessionId: "x" }, (outcome) => {
              outcomes.push({
                kind: outcome.kind,
                code: outcome.kind === "error" ? outcome.code : undefined,
              });
            })
            .respondOk();
        },
      };

      const threadId = ThreadId.make("midturn-a6");
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* adapter
          .sendTurn({ threadId, input: "probe", runtimeMode: "approval-required" })
          .pipe(Effect.timeout("15 seconds"));
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
        TestClock.withLive,
      );

      assert.deepStrictEqual(outcomes, [{ kind: "error", code: -32601 }]);
    }),
);

// ── SB5 / M5 — hasQueuedPrompt:true and the claim responder ─────────────────

it.effect(
  "midturn A7 (SB5/M5): >10 queued sets hasQueuedPrompt, and the CLAIM method is answered",
  () =>
    Effect.gen(function* () {
      const drains: FakeMidTurnDrainObservation[] = [];
      const claimOutcomes: Array<{ readonly kind: string; readonly result: unknown }> = [];
      const script: FakeAcpScript = {
        midTurnDrain: { onDrain: (o) => drains.push(o) },
        onPrompt: (steps: PromptSteps) => {
          steps
            .emitText(RUNNING)
            .sleep(700)
            // The todoStopGuard variant — the one that carries the watch flag and
            // makes qwen follow up with a claim when we answer hasQueuedPrompt.
            .drainMidTurn("todo-stop-guard-inspection")
            .extRequest(
              "craft/claimTodoStopGuardContinuation",
              { sessionId: "fake-acp-session", promptId: "p1" },
              (outcome) => {
                claimOutcomes.push({
                  kind: outcome.kind,
                  result: outcome.kind === "ok" ? outcome.result : undefined,
                });
              },
            )
            .respondOk();
        },
      };
      const harness: Harness = { drains, promptTexts: [], script };

      yield* withRunningTurn(harness, "midturn-a7", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          for (let index = 0; index < 12; index += 1) {
            yield* Effect.forkChild(
              adapter.sendTurn({
                threadId,
                input: `msg-${index}`,
                messageId: MessageId.make(`a7-message-${index}`),
                runtimeMode: "approval-required",
              }),
            );
          }
          yield* pollUntil(() => claimOutcomes.length >= 1, "the claim answer");
        }),
      );

      const drain = drains[0];
      assert.isDefined(drain);
      if (drain === undefined) return;
      // Twelve queued, ten taken ⇒ two remain ⇒ the flag is TRUE. Nothing in the
      // wave asserted this before: R4 pins only the `false` case.
      assert.isTrue(drain.hasQueuedPrompt, "a remainder must be reported");
      // And the follow-up qwen makes because of that flag must be ANSWERED.
      // Unanswered, it resolves 'unavailable' and hard-suspends qwen's todo
      // auto-continuation for the whole session (Session.ts:1547-1575).
      assert.strictEqual(claimOutcomes[0]?.kind, "ok", "the claim method must not reject");
      assert.deepStrictEqual(claimOutcomes[0]?.result, { claimed: false, hasQueuedPrompt: true });
    }),
);

// ── O1 (MAJOR) — the flush must not race a fresh user send ───────────────────
//
// NOT COVERAGE — read this before trusting A8.
//
// A8 is NOT born-red: it passes before and after the O1 fix, because the flush
// wins the scheduling race consistently and the real window (between `finalize`
// clearing `activeTurnId` and the forked flush setting its own) cannot be forced
// from outside. Round 3 additionally observed it RED once under load and green
// on a clean re-run — a timing-order flake, one observation.
//
// So: a timing-sensitive pin on a timing-sensitive property. Treat it as a weak
// regression guard on the observable invariant and nothing more. The real
// evidence for the dispatch claim's lifecycle is A11 — which reproduces the
// FRESH-A brick under the old release shape and genuinely discriminates — plus
// the construction argument recorded in the phase report.
it.effect(
  "midturn A8 (O1, weak pin — see the note above): a user send during an in-flight FLUSH is queued, never dispatched",
  () =>
    Effect.gen(function* () {
      // The audit's sequence, made deterministic by a SLOW flush prompt:
      //   t0 turn 1 runs, user queues M1 -> pending
      //   t1 turn 1 ends with NO drain; finalize clears activeTurnId; composer unlocks
      //   t2 flushMidTurnQueue is FORKED — sendTurn has already returned
      //   t3 the user, seeing a live composer, sends M2
      //   t4 the flush reaches its prompt and skips the mid-turn guard BY
      //      CONSTRUCTION (`if (flushItems === undefined)`), issuing a second
      //      session/prompt on a session that now has a live turn
      //   t5 Session.ts:2285 `pendingPrompt?.abort()` truncates the user's turn
      //
      // Nothing serialised the two producers: the reactor forks every send
      // (ProviderCommandReactor.ts:1327-1329), the flush is forked onto layerScope
      // and is not in that lane at all, and `sendTurnInternal` is not under
      // `withThreadLock`. This is the wave's central invariant — never a second
      // session/prompt on a live turn — failing from the INSIDE.
      const promptTexts: string[] = [];
      let promptIndex = 0;
      const script: FakeAcpScript = {
        onPromptText: (text) => promptTexts.push(text),
        onPrompt: (steps: PromptSteps) => {
          const index = promptIndex;
          promptIndex += 1;
          if (index === 0) {
            // Turn 1: short, NO drain, so the queue can only leave via the flush.
            steps.emitText(RUNNING).sleep(400).respondOk();
            return;
          }
          if (index === 1) {
            // The FLUSH turn, deliberately slow: this is the window in which the
            // user types, and the window the fix has to cover.
            steps.emitText("FLUSH_IN_FLIGHT").sleep(2_500).respondOk();
            return;
          }
          steps.emitText("third-turn-reply").respondOk();
        },
      };

      const threadId = ThreadId.make("midturn-a8");
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
        // M1 is queued mid-turn and can only leave via the flush.
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "queued M1",
            messageId: MessageId.make("a8-m1"),
            runtimeMode: "approval-required",
          }),
        );
        // t1/t2 — turn 1 COMPLETES. `finalize` has cleared `activeTurnId` and the
        // flush is forked but has NOT yet reached its own `ctx.activeTurnId = turnId`
        // (that sits ~40 lines and several yields into `sendTurnInternal`). This
        // gap is the whole finding: it is the moment the composer unlocks.
        yield* pollUntil(
          () => collector.events.some((event) => event.type === "turn.completed"),
          "turn 1 completed",
        );

        // t3 — the user sends INSIDE that gap.
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "user M2 during flush",
            messageId: MessageId.make("a8-m2"),
            runtimeMode: "approval-required",
          }),
        );
        // Give it far longer than a dispatch needs. If it dispatches, a third
        // prompt lands here and qwen would abort the flush turn.
        yield* Effect.sleep("900 millis");

        assert.deepStrictEqual(
          promptTexts,
          ["first", "queued M1"],
          "a send arriving while the FLUSH turn is live must be queued, not dispatched as a third prompt",
        );
        yield* collector.stop;
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
        TestClock.withLive,
      );
    }),
);

// ── FR1 (MAJOR) — a bad attachment must not escape the mark/finalizer net ────

it.effect(
  "midturn A9 (FR1): a mid-turn send with an INVALID attachment still gets a terminal mark",
  () =>
    Effect.gen(function* () {
      // The M1 fix moved attachment I/O into `tryQueueMidTurnMessage`, which runs
      // in the OUTER gen — before `turnId`, before `finalize`, and outside the
      // `catchCause`/`onExit` net that the file documents as covering "EVERY exit
      // from this turn". `resolveAttachmentBlocks` can fail (invalid id, unreadable
      // file), so before this fix such a send produced: no turn events, an
      // unclassified reactor error, and NO delivery mark at all — the balloon
      // showed nothing, forever.
      //
      // A queued message that cannot even be prepared is simply NOT DELIVERED, and
      // must say so.
      const harness = makeHarness({ drain: false, pauseMs: 1_200 });
      yield* withRunningTurn(harness, "midturn-a9", ({ adapter, threadId, events }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(
            adapter.sendTurn({
              threadId,
              input: "look at this",
              // No such file was ever written — resolution must fail.
              attachments: [
                {
                  type: "image",
                  id: "a9-does-not-exist",
                  name: "missing.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
              messageId: MessageId.make("a9-message"),
              runtimeMode: "approval-required",
            }),
          );
          yield* pollUntil(
            () => marksOf(events).some((mark) => mark.deliveryState === "not-delivered"),
            "the not-delivered mark for an unpreparable message",
          );

          assert.deepStrictEqual(
            marksOf(events).map((mark) => mark.deliveryState),
            ["not-delivered"],
            "an unpreparable mid-turn message must be marked not-delivered, never left unmarked",
          );
          // And it must NOT have become a second prompt on the live turn.
          assert.deepStrictEqual(harness.promptTexts, ["first"]);
        }),
      );
    }),
);

// ── SB6 residual — the fake's own latch, driven at runtime ───────────────────

it.effect("midturn A10 (SB6): a -32601 drain latches the channel OFF for the session", () =>
  Effect.gen(function* () {
    // The gap round 2 left: eight unit specs pin the PREDICATE and A6 drives a
    // real -32601 over the wire, but nothing connected the predicate to the
    // fake's runtime. Deleting the latch block from the executor left the whole
    // matrix green, because every matrix spec asserts the values a DISABLED
    // latch also produces. This drives the latch itself.
    const drains: FakeMidTurnDrainObservation[] = [];
    const script: FakeAcpScript = {
      midTurnDrain: {
        onDrain: (o) => drains.push(o),
        // First drain is answered as method-not-found; the rest would be
        // ordinary — but must never happen.
        forceOutcomes: ["method-not-found"],
      },
      onPrompt: (steps: PromptSteps) => {
        steps
          .emitText(RUNNING)
          .drainMidTurn()
          .sleep(60)
          .drainMidTurn()
          .sleep(60)
          .drainMidTurn()
          .respondOk();
      },
    };

    const threadId = ThreadId.make("midturn-a10");
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter
        .sendTurn({ threadId, input: "probe", runtimeMode: "approval-required" })
        .pipe(Effect.timeout("15 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );

    assert.strictEqual(drains.length, 3, "all three boundaries must be observed");
    // -32601 is a ONE-STRIKE permanent disable (Session.ts:4775).
    assert.strictEqual(drains[0]?.outcome?.kind, "error");
    assert.strictEqual(
      drains[0]?.outcome?.kind === "error" ? drains[0].outcome.code : undefined,
      -32601,
    );
    assert.isTrue(drains[0]?.permanentlyDisabled, "the first -32601 must latch");
    // And every LATER boundary must be SKIPPED without calling the host at all
    // (Session.ts:4697 returns before `extMethod`).
    for (const later of drains.slice(1)) {
      assert.isTrue(later.skipped, "a latched channel must never call the host again");
      assert.isTrue(later.permanentlyDisabled);
      assert.isUndefined(later.outcome);
    }
  }),
);

// ── FRESH-A (BLOCKER) — a leaked dispatch claim must never brick the thread ──

// NOT COVERAGE for the release shape — read this before trusting A11.
//
// A11 was offered in phase 4c as the BLOCKER's born-red evidence. That claim is
// REFUTED (round 4, FRESH-G): on this path NO CLAIM IS EVER TAKEN, because the
// compaction exemption at the claim site skips it — so the round-2 and round-3
// release shapes are both no-ops here and A11 cannot tell them apart. The 11.5s
// timeout that was reported came from an INTERMEDIATE tree, before the exemption
// landed in the same commit, and was never re-verified.
//
// What A11 genuinely pins: the compaction EXEMPTION — a send during a hidden
// compaction does not brick the thread. That is worth having. The release shape
// and the owner check are pinned instead by
// `tests/qwen/midturn/dispatchClaim.test.ts`, where they are reachable.
it.effect(
  "midturn A11 (FRESH-A, pins the compaction exemption — NOT the release shape): a send during a hidden compaction never bricks the thread",
  () =>
    Effect.gen(function* () {
      // The round-3 BLOCKER. The claim was taken early but RELEASED through
      // `activeCtx`, which is assigned ~200 lines later. A send that claimed and
      // then hit the `hiddenCompressActive` fail-fast returned in between, so the
      // release was skipped on a LIVE session: every later send was queued with a
      // pending clock, no turn could start, no turn could end, nothing was ever
      // delivered — until the user stopped the session.
      //
      // The trigger is the wave's own control flow: `sendTurnInternal` forks
      // auto-compaction and the turn-end flush from adjacent lines.
      //
      // This drives the shape directly: hold a compaction open, send into it, then
      // prove the thread still WORKS afterwards.
      const promptTexts: string[] = [];
      let compressPrompts = 0;
      const script: FakeAcpScript = {
        onPromptText: (text) => promptTexts.push(text),
        onPrompt: (steps: PromptSteps) => {
          const isCompress = promptTexts[promptTexts.length - 1]?.trim() === "/compress";
          if (isCompress) {
            compressPrompts += 1;
            // Hold the compaction open long enough to send into it.
            steps.sleep(900).emitText("Context compressed (100 -> 50).").respondOk();
            return;
          }
          steps.emitText("reply").respondOk();
        },
      };

      const threadId = ThreadId.make("midturn-a11");
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const collector = yield* collectAdapterEvents(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        // Hold a hidden compaction open.
        yield* Effect.forkChild(adapter.compactContext!(threadId).pipe(Effect.ignore));
        yield* pollUntil(() => compressPrompts >= 1, "the /compress prompt");

        // Send INTO the compaction. Whether this is queued or refused is not what
        // is under test — what matters is that it must not leak the dispatch slot.
        yield* Effect.exit(
          adapter
            .sendTurn({ threadId, input: "during compaction", runtimeMode: "approval-required" })
            .pipe(Effect.timeout("10 seconds")),
        );

        // Let the compaction finish and release everything it holds.
        yield* pollUntil(
          () => collector.events.some((event) => event.type === "session.exited") || true,
          "settle",
        );
        yield* Effect.sleep("1500 millis");

        // THE ASSERTION: the thread still works. A leaked claim makes every later
        // send queue forever, so this prompt would never reach the agent.
        const before = promptTexts.length;
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "after compaction",
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(
          () => promptTexts.length > before,
          "a turn must still be able to start after a send during compaction",
        );
        yield* collector.stop;
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
        TestClock.withLive,
      );
    }),
);

// ── Round-4 closing specs: pin the dispatch-claim fixes themselves ───────────
//
// Round 4 proved every fix in phase 4c is spec-unpinned: reverting the BLOCKER's
// release shape, deleting FRESH-C's loser return, and reverting FRESH-B wholesale
// each reddened NOTHING. A11 was offered as the BLOCKER's evidence and is
// refuted — on its path no claim is ever taken (compaction's exemption at the
// claim site skips it), so both release shapes are no-ops there. A11 pins the
// compaction EXEMPTION, not the release SHAPE, and its narrative is corrected in
// the phase report.
//
// These three drive the state machine directly, no race required.

it.effect("midturn A12 (FRESH-B): compaction is REFUSED while a dispatch claim is held", () =>
  Effect.gen(function* () {
    // Mutual exclusion between compaction and the claim. A compaction in flight
    // holds the claim itself, so this is the one state where the claim is held
    // and `activeTurnId` is undefined — exactly the combination the old
    // `activeTurnId`-alone guard could not see, and the reason FRESH-B was
    // filed. Reverting that guard makes the second call take the silent
    // `hiddenCompressActive` early-return instead of refusing.
    let compressPrompts = 0;
    const promptTexts: string[] = [];
    const script: FakeAcpScript = {
      onPromptText: (text) => promptTexts.push(text),
      onPrompt: (steps: PromptSteps) => {
        if (promptTexts[promptTexts.length - 1]?.trim() === "/compress") {
          compressPrompts += 1;
          steps.sleep(2_500).emitText("Context compressed (100 -> 50).").respondOk();
          return;
        }
        steps.emitText("reply").respondOk();
      },
    };

    const threadId = ThreadId.make("midturn-a12");
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(adapter.compactContext!(threadId).pipe(Effect.ignore));
      yield* pollUntil(() => compressPrompts >= 1, "the /compress prompt");

      // The claim is held by the in-flight compaction, activeTurnId is undefined.
      const second = yield* Effect.exit(adapter.compactContext!(threadId));
      assert.isTrue(
        Exit.isFailure(second),
        "a second compaction must be REFUSED while the dispatch slot is held, not silently ignored",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  }),
);

// PARTIAL COVERAGE — A13 does NOT discriminate its revert.
//
// Deleting FRESH-C's loser `return` leaves this green: under the fall-through
// the empty send overwrites the claim with its own token and then releases it on
// its own finalize, while `activeTurnId` still gates every subsequent send — so
// nothing is observable from outside. What A13 does pin, and it is real: an
// empty send while a turn runs never dispatches a second prompt.
// The owner check itself is pinned in `tests/qwen/midturn/dispatchClaim.test.ts`.
it.effect(
  "midturn A13 (FRESH-C, does not discriminate its revert — see above): an EMPTY send must not disturb a held claim",
  () =>
    Effect.gen(function* () {
      // FRESH-C's fall-through: an unqueueable (empty) send reaching the loser
      // branch used to fall through, OVERWRITE the claimant's token with its own,
      // and then release on its own finalize — a turn releasing a claim it never
      // took. The loser branch now always returns.
      const harness = makeHarness({ drain: false, pauseMs: 2_500 });
      yield* withRunningTurn(harness, "midturn-a13", ({ adapter, threadId }) =>
        Effect.gen(function* () {
          // Empty input and no attachments: `tryQueueMidTurnMessage` cannot queue
          // it, so it lands in exactly the branch that used to fall through.
          yield* Effect.exit(
            adapter
              .sendTurn({ threadId, input: "   ", runtimeMode: "approval-required" })
              .pipe(Effect.timeout("8 seconds")),
          );
          // It must NOT have become a turn of its own on the live session.
          assert.deepStrictEqual(
            harness.promptTexts,
            ["first"],
            "an empty send while a turn runs must not dispatch a second prompt",
          );
        }),
      );
    }),
);

// PARTIAL COVERAGE — A14 does NOT discriminate its revert.
//
// Reverting to the round-2 `activeCtx` release leaves this green: the rejected
// prompt fails AFTER `activeCtx` is assigned, so the old shape releases
// correctly there too. What A14 does pin, and it is real: a failed turn leaves
// the slot claimable, so a thread is never bricked by an ordinary failure.
it.effect(
  "midturn A14 (FRESH-A, does not discriminate its revert — see above): a turn that claims then FAILS still releases the slot",
  () =>
    Effect.gen(function* () {
      // The release-on-every-exit half. A turn claims, dispatches, and its prompt
      // is rejected; the session survives (the classifier exists to keep the
      // thread usable). The slot must be free afterwards or the thread is bricked
      // — which is the damage FRESH-A described.
      const promptTexts: string[] = [];
      let promptIndex = 0;
      const script: FakeAcpScript = {
        onPromptText: (text) => promptTexts.push(text),
        onPrompt: (steps: PromptSteps) => {
          const index = promptIndex;
          promptIndex += 1;
          if (index === 0) {
            steps.emitText(RUNNING).sleep(200).respondError(-32000, "rejected turn");
            return;
          }
          steps.emitText("later reply").respondOk();
        },
      };

      const threadId = ThreadId.make("midturn-a14");
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* Effect.exit(
          adapter
            .sendTurn({ threadId, input: "doomed", runtimeMode: "approval-required" })
            .pipe(Effect.timeout("15 seconds")),
        );

        // The slot must be free: a fresh turn has to be able to start.
        const before = promptTexts.length;
        yield* Effect.forkChild(
          adapter.sendTurn({ threadId, input: "after failure", runtimeMode: "approval-required" }),
        );
        yield* pollUntil(
          () => promptTexts.length > before,
          "a turn must still start after a failed turn released the slot",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
        TestClock.withLive,
      );
    }),
);
