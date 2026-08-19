// ru-code: per-error surface proof. Drives the REAL QwenAdapter over the
// in-memory fake ACP agent (fakeAcpSpawner/fakeAcpCore) and asserts, for every
// wire-inducible id in the qwen error truth table, the EXACT native runtime
// event surface set the adapter emits — present ✓ AND absent ✗ — AND the exact
// classified TEXT the UI will show:
//
//   surface set                       | content.delta | task.completed{failed} | turn.completed{showNotification}
//   ----------------------------------|---------------|------------------------|----------------------------------
//   [Bubble]      A1,A2,A3,A7         |      ✓        |           ✗            |               ✗
//   [Timeline]    A4,A6,D1,D2,E       |      ✗        |           ✓            |               ✗ (false)
//   [T,N]         A5,B1,B3,C1,C4,Z,…  |      ✗        |           ✓            |               ✓ (true)
//
// Determinism comes from the in-memory transport (no real process/pipe/clock):
// the emitted event set is a pure function of the script. Each failed row also
// proves the race fix — a failed turn RESOLVES sendTurn (recovered to success)
// and emits EXACTLY ONE turn.completed (the single finalizer).
//
// TEXT PROOF per class:
//   - RPC-REPLY errors (A1-A7, Z, unrecognized): the agent answers session/prompt
//     with a JSON-RPC error, so `callRpc` (`fromProtocolError`) preserves the
//     code / errorMessage / data.details as an `AcpRequestError`. The classifier
//     sees the exact error ⇒ we assert the EXACT per-id text.
//   - PROCESS-EXIT with a readable code (B1.<code>): effect-acp's `callRpc` wraps
//     the in-flight-request termination as an `AcpTransportError` (the underlying
//     `AcpProcessExitedError` is buried in `.cause`), so `classify()` first lands
//     on C4 — BUT the adapter's B1 exit-code recovery (`readChildExit`) re-reads
//     the child's real exit status and re-classifies to `B1.<code>` with the
//     exit-code-specific text. The fake's `exit(code)` succeeds the child's
//     exitCode with that code, so the bounded read resolves immediately and we
//     assert the EXACT exit-code text (auth / bad-input / sandbox / config /
//     turn-limit / tool / interrupted / generic "code N").
//   - ADAPTER-SIDE errors (D1 validation, D2 session-not-found, E defect): raised
//     by the adapter itself (no wire needed) — driven with an empty input (D1),
//     an unstarted thread (D2), or the RU_CODE_FAULT_INJECT="defect" seam (E).
//     Exact text asserted.
//   - SPAWN failure (B3): the spawner fails before any wire exists, so the error
//     surfaces at startSession (pre-turn) — NOT through the turn-scoped finalizer.
//     Proven in its own test below: drive the REAL adapter's startSession over the
//     failing spawner and assert the produced error classifies to B3 (T+N) with
//     the exact text. (The T+N runtime surface for a start failure is realized by
//     the dispatch/reactor layer, covered in ../errors/dispatch.test.ts.)
//
// LEFT SURFACE-ONLY (documented, not forced):
//   - C1 (malformed frame): effect-acp erases the parse tag at the RPC boundary
//     (the AcpProtocolParseError is buried in `.cause`), so over the wire C1's
//     distinct "bad JSON" text collapses to C4's transport text — fixing it needs
//     an effect-acp change we're avoiding. We assert only C1's [Timeline,
//     Notification] SURFACE here; its distinct text is pinned by the pure
//     classify() test at ../errors/recognizers.test.ts. (Unlike B1, a malformed
//     frame does NOT exit the child, so readChildExit reports "not exited" and the
//     C4 classification is correctly kept.)
//
// NOT INDUCIBLE over this fake (covered by the pure classify() test):
//   - B2 (process exit with NO readable code): externally indistinguishable from a
//     transport break (unreadable exit status ⇒ C4), so not wire-recoverable.
//   - D3 (other Provider* error): unreachable in the current adapter (defensive
//     fallback).
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
import { CLI_DISPLAY_NAME } from "@ru-code/branding";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { classify } from "../../../qwen/errors/recognizers.ts";
import { ProviderAdapterRequestError } from "../../../../provider/Errors.ts";
import { Surface } from "@ru-code/qwen/errors/types";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { failingAcpSpawnerLayer, fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-error-surface-thread");
// A thread that is never started — sending a turn to it drives the D2
// session-not-found path while a real session exists on THREAD_ID (so the event
// subscription is reliably attached via startSession's latency).
const UNSTARTED_THREAD_ID = ThreadId.make("qwen-error-surface-unstarted-thread");

// The fault-injection env seam read by the adapter's E (defect) path.
const FAULT_INJECT_ENV = "RU_CODE_FAULT_INJECT";

// A trivial happy-prompt script for adapter-side rows (D1/D2/E) whose failure
// occurs before/at requireSession — onPrompt is never reached.
const NOOP_SCRIPT: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };

interface SurfaceExpectation {
  /** Bubble: a `content.delta` carries the classified text; turn completes clean. */
  readonly bubble: boolean;
  /** Timeline: a `task.completed{status:"failed"}` work-log row carries the text. */
  readonly timeline: boolean;
  /** Notification: `turn.completed{showNotification:true}` drives the red banner. */
  readonly notification: boolean;
}

interface SurfaceRow {
  readonly id: string;
  readonly script: FakeAcpScript;
  /**
   * A stable fragment of the recognizer's classified Russian text for this id.
   * Present for every id whose exact text is provable over the wire (all rows
   * below except C1). OMITTED for C1, whose distinct text collapses to the C4
   * transport classification at the RPC boundary — only its SURFACE is asserted
   * here (see the file header); its text is pinned by recognizers.test.ts.
   */
  readonly textIncludes?: string;
  readonly expect: SurfaceExpectation;
  /** sendTurn input; defaults to "hello". Empty string drives the D1 path. */
  readonly input?: string;
  /**
   * Thread the turn is sent to; defaults to THREAD_ID (the started session).
   * UNSTARTED_THREAD_ID drives the D2 session-not-found path.
   */
  readonly sendThreadId?: ThreadId;
  /** Wrap sendTurn in RU_CODE_FAULT_INJECT="defect" (drives the E defect path). */
  readonly faultInject?: boolean;
}

const ROWS: ReadonlyArray<SurfaceRow> = [
  // ── [Bubble]: friendly content.delta, turn COMPLETES, no row, no banner ──
  {
    id: "A1",
    script: {
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", {
          details: "Model stream ended with empty response text",
        }),
    },
    textIncludes: "empty response",
    expect: { bubble: true, timeline: false, notification: false },
  },
  {
    id: "A2",
    script: { onPrompt: (steps) => steps.respondError(429, "rate limit") },
    textIncludes: "Too many requests",
    expect: { bubble: true, timeline: false, notification: false },
  },
  {
    id: "A3",
    script: {
      onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }),
    },
    textIncludes: "Model unloaded",
    expect: { bubble: true, timeline: false, notification: false },
  },
  {
    id: "A7",
    script: {
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
    },
    textIncludes: "The command could not be run",
    expect: { bubble: true, timeline: false, notification: false },
  },
  // ── [Timeline]: failed work-log row, NO banner, NO error bubble ──
  {
    id: "A4",
    script: { onPrompt: (steps) => steps.respondError(-32601, "method not found") },
    textIncludes: `${CLI_DISPLAY_NAME} protocol`,
    expect: { bubble: false, timeline: true, notification: false },
  },
  {
    id: "A6",
    script: { onPrompt: (steps) => steps.respondError(-32002, "resource not found") },
    textIncludes: `${CLI_DISPLAY_NAME} resource not found`,
    expect: { bubble: false, timeline: true, notification: false },
  },
  // ── [Timeline, Notification]: failed row AND banner, NO error bubble ──
  {
    id: "A5",
    script: { onPrompt: (steps) => steps.respondError(-32000, "auth required") },
    textIncludes: `${CLI_DISPLAY_NAME} authorization`,
    expect: { bubble: false, timeline: true, notification: true },
  },
  // B1 exit-code recovery: `emitText(...).exit(code)` — the child exits with a
  // readable code, so the finalizer's readChildExit re-classifies C4 → B1.<code>
  // and we assert the EXACT exit-code text. All B1 are [Timeline, Notification].
  {
    id: "B1.41",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(41) },
    textIncludes: "authorization required",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "B1.42",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(42) },
    textIncludes: "invalid input",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "B1.44",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(44) },
    textIncludes: "sandbox error",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "B1.52",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(52) },
    textIncludes: "configuration error",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "B1.53",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(53) },
    textIncludes: "turn limit reached",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "B1.54",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(54) },
    textIncludes: "tool error",
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    // 130 (SIGINT) has bespoke "interrupted … continue" advice, not the generic
    // "ended … restart" line — asserted here.
    id: "B1.130",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(130) },
    textIncludes: `The ${CLI_DISPLAY_NAME} session was interrupted`,
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    // Any non-table code falls through to the generic "code N" variant.
    id: "B1.7",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(7) },
    textIncludes: "code 7",
    expect: { bubble: false, timeline: true, notification: true },
  },
  // C1 (malformed frame): SURFACE-ONLY — its distinct "bad JSON" text collapses
  // to C4 over the wire (parse tag erased at the RPC boundary; the child does not
  // exit, so readChildExit keeps the C4 classification). textIncludes omitted.
  {
    id: "C1",
    script: { onPrompt: (steps) => steps.emitText("hi").writeRaw("}{ not json\n") },
    expect: { bubble: false, timeline: true, notification: true },
  },
  {
    id: "C4",
    script: { onPrompt: (steps) => steps.emitText("partial").closeTransport() },
    textIncludes: `Connection to ${CLI_DISPLAY_NAME}`,
    expect: { bubble: false, timeline: true, notification: true },
  },
  // Z — a clean RPC-reply error with a plain detail that matches no specific
  // recognizer falls through to the Z_CLEAN_REQUEST_ERROR catch-all, which
  // surfaces the detail verbatim (T+N). Code -32099 dodges every A-bucket code
  // and carries no data.details, so A1/A2/A3/A7 (need -32603 + markers), A4
  // (-3260{0,1,2}), A5 (-32000), A6 (-32002) all miss.
  {
    id: "Z",
    script: {
      onPrompt: (steps) => steps.respondError(-32099, "Понятная ошибка провайдера для Z"),
    },
    textIncludes: "Понятная ошибка провайдера для Z",
    expect: { bubble: false, timeline: true, notification: true },
  },
  // unrecognized — a clean RPC-reply error whose detail is EMPTY (so Z's
  // non-empty-detail guard skips it) and whose code matches no recognizer ⇒
  // classify() returns null ⇒ the adapter falls back to UNRECOGNIZED_DECISION
  // (T+N, generic English text).
  {
    id: "unrecognized",
    script: { onPrompt: (steps) => steps.respondError(-32099, "") },
    textIncludes: "An unexpected error occurred. See the server log for details.",
    expect: { bubble: false, timeline: true, notification: true },
  },
  // D1 — adapter input validation: an empty input yields zero prompt parts ⇒
  // ProviderAdapterValidationError ⇒ D1 (Timeline only, no banner, no bubble).
  {
    id: "D1",
    script: NOOP_SCRIPT,
    input: "",
    textIncludes: "Internal request-validation error",
    expect: { bubble: false, timeline: true, notification: false },
  },
  // D2 — session not found: sendTurn on a thread with NO started session ⇒
  // requireSession fails ⇒ D2 (Timeline only). A real session on THREAD_ID keeps
  // the event subscription reliably attached; the turn goes to UNSTARTED_THREAD_ID.
  {
    id: "D2",
    script: NOOP_SCRIPT,
    sendThreadId: UNSTARTED_THREAD_ID,
    textIncludes: `${CLI_DISPLAY_NAME} session not found`,
    expect: { bubble: false, timeline: true, notification: false },
  },
  // E — synchronous mid-turn defect via the RU_CODE_FAULT_INJECT seam ⇒ Cause.die
  // ⇒ E (Timeline only). The turn still finalizes (sendTurn recovers to success,
  // exactly one turn.completed) — no hang. killAcp:true is a dispatch-layer
  // concern (not observable in this direct-adapter e2e); pinned by the pure
  // classify() test.
  {
    id: "E",
    script: NOOP_SCRIPT,
    faultInject: true,
    textIncludes: "An unexpected server error occurred",
    expect: { bubble: false, timeline: true, notification: false },
  },
];

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-error-surface-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const isContentDelta = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
  event.type === "content.delta";

const isFailedTask = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
  event.type === "task.completed" && event.payload.status === "failed";

const isTurnCompleted = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
  event.type === "turn.completed";

const runRow = (row: SurfaceRow) =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));

    const events: ProviderRuntimeEvent[] = [];
    const turnCompleted = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "turn.completed"
            ? Deferred.succeed(turnCompleted, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });

    // E path: set the fault-injection env for the duration of the scope
    // (restored by the acquireRelease finalizer BEFORE the adapter tears down).
    if (row.faultInject) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env[FAULT_INJECT_ENV];
          process.env[FAULT_INJECT_ENV] = "defect";
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[FAULT_INJECT_ENV];
            else process.env[FAULT_INJECT_ENV] = previous;
          }),
      );
    }

    const sendExit = yield* Effect.exit(
      adapter.sendTurn({ threadId: row.sendThreadId ?? THREAD_ID, input: row.input ?? "hello" }),
    );

    // The finalizer offers turn.completed before sendTurn resolves; wait until the
    // collector has observed it (guarded so a genuine wedge fails fast, not hangs).
    yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    const contentDeltas = events.filter(isContentDelta);
    const failedTasks = events.filter(isFailedTask);
    const turnCompletions = events.filter(isTurnCompleted);
    const completion = turnCompletions[0];

    // ── invariants shared by every wire-inducible id ──
    assert.strictEqual(Exit.isSuccess(sendExit), true); // race fix: sendTurn resolved
    assert.lengthOf(turnCompletions, 1); // single finalizer: exactly one turn.completed
    assert.isDefined(completion);
    if (completion === undefined) return;

    if (row.expect.bubble) {
      // ── [Bubble]: friendly content.delta, turn COMPLETES, no row, no banner ──
      assert.isDefined(row.textIncludes);
      const errorBubble = contentDeltas.find((event) =>
        event.payload.delta.includes(row.textIncludes ?? " "),
      );
      assert.isDefined(errorBubble); // classified text landed in the bubble
      assert.strictEqual(completion.payload.state, "completed"); // clean completion
      assert.lengthOf(failedTasks, 0); // ✗ no timeline row
      assert.strictEqual(Boolean(completion.payload.showNotification), false); // ✗ no banner
      return;
    }

    // ── failed ids ([Timeline] and/or [Timeline, Notification]) ──
    assert.strictEqual(completion.payload.state, "failed");
    // The finalizer carries the classified text on turn.completed.errorMessage.
    const classifiedText = completion.payload.errorMessage ?? "";
    assert.isAbove(classifiedText.length, 0);
    // Exact-text proof for every failed id except C1 (surface-only, see header).
    if (row.textIncludes !== undefined) {
      assert.include(classifiedText, row.textIncludes);
    }

    // ✗ NO error bubble: the classified error text never appears in a content.delta
    // (any legit streamed text — e.g. B1's "partial" — is not the error text).
    assert.isUndefined(contentDeltas.find((event) => event.payload.delta.includes(classifiedText)));

    // ── Timeline ✓/✗ ──
    if (row.expect.timeline) {
      // task.completed{failed} work-log row whose summary IS the classified text.
      assert.isDefined(failedTasks.find((event) => event.payload.summary === classifiedText));
    } else {
      assert.lengthOf(failedTasks, 0);
    }

    // ── Notification ✓/✗ (banner gate) ──
    assert.strictEqual(Boolean(completion.payload.showNotification), row.expect.notification);
  }).pipe(
    Effect.scoped,
    // Single merged provide: the fake spawner's ChildProcessSpawner overrides
    // NodeServices' real one (in testServices) so the adapter talks to the fake.
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(row.script), testServices)),
    // Live clock: the in-memory fibers and the wedge-guard timeout run on wall time.
    TestClock.withLive,
  );

it.effect.each(ROWS)("qwen error surface: $id", (row) => runRow(row));

// B3 — spawn failure. The spawner fails before any wire exists, so the error
// surfaces at startSession (pre-turn), NOT through the turn-scoped finalizer.
// Because B3 flows through the reactor's GENERIC start-failure path (where
// `formatFailureDetail` would otherwise `Cause.pretty`-dump anything that is not a
// `ProviderAdapterRequestError`), the adapter PRE-CLASSIFIES the spawn failure: it
// remaps it to a `ProviderAdapterRequestError` whose `.detail` is the classified B3
// text, preserving the original `ProviderAdapterProcessError` (which still wraps the
// genuine `AcpSpawnError`) as `.cause`. This proves: (1) startSession fails with the
// classified B3 text as its request detail, and (2) the original cause still
// classifies to B3 (the AcpSpawnError survives the remap). The full-pipeline banner +
// timeline-summary proof for B3 lives in
// integration/qwenErrorPipeline.integration.test.ts.
it.effect("qwen error surface: B3 (spawn failure at startSession)", () =>
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
    assert.isDefined(failure);
    const error = failure?.error;

    // (1) The adapter pre-classified the spawn failure into a request error whose
    // detail is the exact B3 text — this is what the reactor shows as the banner.
    const isRequestError = Schema.is(ProviderAdapterRequestError);
    assert.isTrue(isRequestError(error), "startSession fails with a request error");
    if (!isRequestError(error)) return;
    assert.include(error.detail, `Could not start the ${CLI_DISPLAY_NAME} process`);

    // (2) The original cause survives as `.cause` and STILL classifies to B3 (T+N),
    // proving the genuine AcpSpawnError was preserved through the remap.
    const decision = classify(error.cause, Cause.fail(error.cause));
    assert.isNotNull(decision);
    assert.strictEqual(decision?.id, "B3");
    assert.deepStrictEqual(decision?.surface, [Surface.Timeline, Surface.Notification]);
    assert.include(decision?.text ?? "", `Could not start the ${CLI_DISPLAY_NAME} process`);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(failingAcpSpawnerLayer(), testServices)),
    TestClock.withLive,
  ),
);
