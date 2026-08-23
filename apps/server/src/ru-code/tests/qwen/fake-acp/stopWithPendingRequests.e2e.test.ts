// ru-code: cancel-all-pending-on-stop — the fix's verification suite
// (t3-sync-aug-19 caps/verdict-and-fix-plan.md §Verification plan). Drives the REAL
// QwenAdapter over the in-memory fake ACP agent through the Stop-button path
// (`adapter.stopSession` → `abortSession(ctx, MAINTENANCE_METHOD /* "end-force" */)`),
// warm engine (this harness's default — RU_CODE_WARM_ENGINE is unset), with a
// request parked at the moment of stop.
//
// Four cases — the plan's already-executed probes 1-4, now pinned as an e2e suite:
//   1. PIN     — warm + parked approval at stop: exactly one open/resolved pair,
//                resolved strictly before session.exited. Guards against the plan's
//                dropped Fix 2 (a duplicate `request.resolved` emitted from the
//                settle helper) reappearing.
//   2. PIN     — warm + parked ask_user_question at stop: same pairing on the
//                user-input channel. Guards against the dropped Fix 3.
//   3. THE FIX — warm + a second approval issued by the agent right after the first
//                settles (the tail lands inside the detached teardown grace): it
//                must NOT open after session.exited — Fix 1's atomic ctx.stopped
//                guard (QwenAdapter.ts ingress + the 3 `.set(...)` sites) refuses it
//                before any side effect. RED on the pre-fix tree (probe 1:
//                request.opened(B) landed at index 10, strictly after session.exited
//                at index 9).
//   4. THE FIX — same on the user-input channel (ask_user_question). RED pre-fix
//                (probe 3: user-input.requested(Q2) after session.exited).
//
// Observation window, not a round-trip wait (matches the plan's own probe
// methodology, §0: "observes the adapter's runtime-event stream for 600 ms past
// session.exited"): cases 3/4 sleep past session.exited on the live clock and then
// assert absence, rather than blocking on the tail request's own wire response.
// That response is NOT observable through this in-memory harness for a request
// chained onto the SAME session/prompt call that stopSession's teardown interrupts
// (`ctx.activePromptFiber`) — interrupting the client's wait on that call cascades
// an RPC-level interrupt to the fake agent's handler fiber for it (confirmed via
// `Effect.onExit` tracing: the fake agent's OWN `agent.client.requestPermission(B)`
// exits `Interrupt`, fiber-external, same millisecond as it starts, before the
// client's guard even runs) which kills the agent's nested wait on the SECOND
// request's answer before any response can reach it — independent of whether the
// client refuses (this fix) or silently parks it (the pre-fix bug). The judge's own
// probe 1 data shows the identical ceiling: `"outcomes":["cancelled"]` has length 1,
// not 2, even though 2 requests were opened. A real qwen subprocess does not share
// process-internal fiber interruption with the adapter, so this ceiling is a
// same-process fake-harness artifact, not a production behavior — the client-side
// event stream (asserted below) is what both this suite and the plan's fix actually
// promise.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/schema";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { collectAdapterEvents, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-stop-with-pending-requests-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-stop-with-pending-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type WireOutcome = AcpSchema.RequestPermissionResponse["outcome"];

// A generic (unclassified-kind) approval — same shape as genericApproval.e2e.test.ts.
const approvalPermission = (toolCallId: string): AcpSchema.RequestPermissionRequest => ({
  sessionId: FAKE_SESSION_ID,
  toolCall: {
    toolCallId,
    kind: "fetch",
    rawInput: { url: `https://example.com/${toolCallId}` },
  },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

// ask_user_question — same shape as askUserQuestion.e2e.test.ts.
const askQuestionPermission = (toolCallId: string): AcpSchema.RequestPermissionRequest => ({
  sessionId: FAKE_SESSION_ID,
  toolCall: {
    toolCallId,
    _meta: { toolName: "ask_user_question" },
    rawInput: {
      questions: [
        {
          header: "Flavor",
          question: "Which flavor do you prefer?",
          options: [
            { label: "Fruity", description: "Bright and sweet" },
            { label: "Earthy", description: "Deep and rich" },
          ],
        },
      ],
    },
  },
  options: [{ optionId: "submit", name: "Submit", kind: "allow_once" }],
});

it.effect(
  "qwen stop+pending (1, PIN): warm + parked approval at stop ⇒ one open/resolved pair, resolved before session.exited",
  () => {
    const outcomes: WireOutcome[] = [];
    const script: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      onPrompt: (steps) => steps.requestPermission(approvalPermission("a")).respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
      const collector = yield* collectAdapterEvents(adapter);
      const events = collector.events;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(adapter.sendTurn({ threadId: THREAD_ID, input: "fetch" }));

      yield* pollUntil(() => events.some((e) => e.type === "request.opened"), "request A opened");
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(
        () => events.some((e) => e.type === "session.exited"),
        "session.exited delivered",
      );
      // Bounded settle-wait for the resolve round trip (not a sleep-guess).
      yield* pollUntil(() => outcomes.length === 1, "A's outcome delivered to the fake agent");
      yield* collector.stop;

      const opened = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
          e.type === "request.opened",
      );
      const resolved = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          e.type === "request.resolved",
      );
      assert.lengthOf(opened, 1, "exactly one request.opened");
      assert.lengthOf(resolved, 1, "exactly one request.resolved");
      assert.strictEqual(String(resolved[0]!.requestId), String(opened[0]!.requestId));
      assert.isBelow(
        events.findIndex((e) => e.type === "request.resolved"),
        events.findIndex((e) => e.type === "session.exited"),
        "request.resolved strictly before session.exited",
      );
      assert.deepStrictEqual(outcomes, [{ outcome: "cancelled" }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop+pending (2, PIN): warm + parked ask_user_question at stop ⇒ one requested/resolved pair, resolved before session.exited",
  () => {
    const outcomes: WireOutcome[] = [];
    const script: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      onPrompt: (steps) => steps.requestPermission(askQuestionPermission("q")).respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
      const collector = yield* collectAdapterEvents(adapter);
      const events = collector.events;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(adapter.sendTurn({ threadId: THREAD_ID, input: "ask" }));

      yield* pollUntil(
        () => events.some((e) => e.type === "user-input.requested"),
        "user-input Q requested",
      );
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(
        () => events.some((e) => e.type === "session.exited"),
        "session.exited delivered",
      );
      yield* pollUntil(() => outcomes.length === 1, "Q's outcome delivered to the fake agent");
      yield* collector.stop;

      const requested = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
          e.type === "user-input.requested",
      );
      const resolved = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }> =>
          e.type === "user-input.resolved",
      );
      assert.lengthOf(requested, 1, "exactly one user-input.requested");
      assert.lengthOf(resolved, 1, "exactly one user-input.resolved");
      assert.strictEqual(String(resolved[0]!.requestId), String(requested[0]!.requestId));
      assert.isBelow(
        events.findIndex((e) => e.type === "user-input.resolved"),
        events.findIndex((e) => e.type === "session.exited"),
        "user-input.resolved strictly before session.exited",
      );
      assert.deepStrictEqual(outcomes, [{ outcome: "cancelled" }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop+pending (3, FIX): warm + a second approval issued during the grace ⇒ no tail request.opened after session.exited",
  () => {
    const outcomes: WireOutcome[] = [];
    const script: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      onPrompt: (steps) =>
        steps
          .requestPermission(approvalPermission("a"))
          .requestPermission(approvalPermission("b"))
          .respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
      const collector = yield* collectAdapterEvents(adapter);
      const events = collector.events;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(adapter.sendTurn({ threadId: THREAD_ID, input: "fetch" }));

      yield* pollUntil(() => events.some((e) => e.type === "request.opened"), "request A opened");
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(
        () => events.some((e) => e.type === "session.exited"),
        "session.exited delivered",
      );
      // Bounded OBSERVATION window past session.exited (matches the plan's own
      // probe methodology, §0: 600ms). B's agent-side wire response is not
      // observable through this harness (see the file header) — the fix's
      // actual promise is the client-side event stream, checked below.
      yield* Effect.sleep("600 millis");
      yield* collector.stop;

      const exitedIdx = events.findIndex((e) => e.type === "session.exited");
      assert.isAtLeast(exitedIdx, 0, "session.exited observed");
      const openedAfterExit = events.filter((e, i) => e.type === "request.opened" && i > exitedIdx);
      assert.lengthOf(openedAfterExit, 0, "no request.opened after session.exited (the fix)");
      assert.lengthOf(
        events.filter((e) => e.type === "request.opened"),
        1,
        "only A ever opened — B's ingress was refused before any event",
      );
      // A settled cancelled via the Stop-triggered settle (unchanged pin behavior).
      assert.deepStrictEqual(outcomes, [{ outcome: "cancelled" }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop+pending (4, FIX): warm + a second ask_user_question issued during the grace ⇒ no tail user-input.requested after session.exited",
  () => {
    const outcomes: WireOutcome[] = [];
    const script: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      onPrompt: (steps) =>
        steps
          .requestPermission(askQuestionPermission("q1"))
          .requestPermission(askQuestionPermission("q2"))
          .respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
      const collector = yield* collectAdapterEvents(adapter);
      const events = collector.events;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(adapter.sendTurn({ threadId: THREAD_ID, input: "ask" }));

      yield* pollUntil(() => events.some((e) => e.type === "user-input.requested"), "Q1 requested");
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(
        () => events.some((e) => e.type === "session.exited"),
        "session.exited delivered",
      );
      yield* Effect.sleep("600 millis");
      yield* collector.stop;

      const exitedIdx = events.findIndex((e) => e.type === "session.exited");
      assert.isAtLeast(exitedIdx, 0, "session.exited observed");
      const requestedAfterExit = events.filter(
        (e, i) => e.type === "user-input.requested" && i > exitedIdx,
      );
      assert.lengthOf(
        requestedAfterExit,
        0,
        "no user-input.requested after session.exited (the fix)",
      );
      assert.lengthOf(
        events.filter((e) => e.type === "user-input.requested"),
        1,
        "only Q1 ever requested — Q2's ingress was refused before any event",
      );
      assert.deepStrictEqual(outcomes, [{ outcome: "cancelled" }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);
