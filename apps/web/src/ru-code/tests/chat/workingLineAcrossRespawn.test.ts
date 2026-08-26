// ru-code (agentic-flow wave, ap-final T3): THE WORKING LINE MUST SURVIVE THE RESPAWN.
//
// The owner's report, twice over: after a Stop, the next send either shows no
// working line at all, or shows «Работаю…» with no seconds counting. The
// live-issues round pinned both to ONE root cause and this file guards it.
//
// The chain, all pinned:
//   1. `isWorking = (phase === "running" || isSendBusy || isConnecting ||
//      isRevertingCheckpoint) && !hasPendingPlanApproval` (ChatView.tsx:2429-2433).
//   2. `isConnecting` IS DEAD — `const [isConnecting, _setIsConnecting] =
//      useState(false)` (ChatView.tsx:1405) and the setter is never called, so
//      the CONNECTING phase cannot hold the row up. In practice
//      `isWorking ≡ phase === "running" || isSendBusy`.
//   3. A Stop tears the session down, so the next send must re-create it:
//      `session.exited → starting → ready → running`. Throughout `starting`,
//      `phase` is "connecting" — not "running" — so only `isSendBusy` can keep
//      the row alive.
//   4. `isSendBusy = activeLocalDispatch !== null` and `activeLocalDispatch =
//      serverAcknowledgedLocalDispatch ? null : localDispatch`
//      (ChatView.tsx:619, :641). So `hasServerAcknowledgedLocalDispatch`
//      returning true is what unmounts the row.
//   5. It returned true on ANY bare `session.status`/`updatedAt` change — and
//      `stopped → starting` is such a change, arriving long before the user's
//      turn exists.
//
// The SECOND symptom rides the same flag: `localDispatchStartedAt =
// activeLocalDispatch?.startedAt` (ChatView.tsx:639) is the `sendStartedAt`
// fallback of `deriveActiveWorkStartedAt` (session-logic.ts:380-395), so the
// same early acknowledgement also nulls the timer's start — and
// `MessagesTimeline.tsx:1303-1310` renders the static «Работаю…» (no timer)
// exactly when that start is null. One predicate, both symptoms; the second
// describe block below asserts that half directly.
//
// Against the fake the gap is ~100-650 ms (a blink). Against a real qwen the
// respawn is a process spawn — seconds — which is the owner's "it never
// appears".
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../../../components/ChatView.logic";
import { deriveActiveWorkStartedAt } from "../../../session-logic";
import type { Thread } from "../../../types";

type LatestTurn = NonNullable<Thread["latestTurn"]>;
type Session = NonNullable<Thread["session"]>;

const SEND_AT = "2026-08-28T00:00:10.000Z";

/** The turn that was running when the user pressed Stop, now settled. */
const stoppedTurn: LatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "interrupted",
  requestedAt: "2026-08-28T00:00:00.000Z",
  startedAt: "2026-08-28T00:00:01.000Z",
  completedAt: "2026-08-28T00:00:05.000Z",
  assistantMessageId: null,
};

/** The session as the Stop left it, and as the send's snapshot recorded it. */
const stoppedSession: Session = {
  threadId: ThreadId.make("thread-1"),
  status: "stopped",
  providerName: "qwen",
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-08-28T00:00:05.000Z",
};

/** What `createLocalDispatchSnapshot` banks at the moment of the send. */
const snapshotAtSend: LocalDispatchSnapshot = {
  startedAt: SEND_AT,
  preparingWorktree: false,
  latestUserMessageId: MessageId.make("message-1"),
  latestTurnTurnId: stoppedTurn.turnId,
  latestTurnRequestedAt: stoppedTurn.requestedAt,
  latestTurnStartedAt: stoppedTurn.startedAt,
  latestTurnCompletedAt: stoppedTurn.completedAt,
  sessionStatus: stoppedSession.status,
  sessionUpdatedAt: stoppedSession.updatedAt,
};

const ack = (input: {
  phase: "connecting" | "ready" | "running";
  latestTurn: LatestTurn | null;
  session: Session;
  latestUserMessageId?: MessageId;
}) =>
  hasServerAcknowledgedLocalDispatch({
    localDispatch: snapshotAtSend,
    phase: input.phase,
    latestTurn: input.latestTurn,
    latestUserMessageId: input.latestUserMessageId ?? snapshotAtSend.latestUserMessageId,
    session: input.session,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    threadError: null,
  });

describe("hasServerAcknowledgedLocalDispatch — the post-stop respawn window", () => {
  it("does not acknowledge the dispatch while the session is merely STARTING", () => {
    // The respawn's first observable step. The user's message has no turn yet:
    // `latestTurn` is still the cancelled one the snapshot recorded.
    expect(
      ack({
        phase: "connecting",
        latestTurn: stoppedTurn,
        session: { ...stoppedSession, status: "starting", updatedAt: SEND_AT },
      }),
    ).toBe(false);
  });

  it("does not acknowledge on a bare updatedAt touch with the same status", () => {
    // The other half of the old predicate: any projection write at all released
    // the dispatch, even one that says nothing about the user's turn.
    expect(
      ack({
        phase: "connecting",
        latestTurn: stoppedTurn,
        session: { ...stoppedSession, updatedAt: "2026-08-28T00:00:11.000Z" },
      }),
    ).toBe(false);
  });

  it("does not acknowledge once the session is READY but the turn still has not started", () => {
    // `starting → ready` is the second status change of the respawn, and it is
    // still not the user's turn — the prompt has not been dispatched to the CLI.
    expect(
      ack({
        phase: "ready",
        latestTurn: stoppedTurn,
        session: { ...stoppedSession, status: "ready", updatedAt: "2026-08-28T00:00:12.000Z" },
      }),
    ).toBe(false);
  });

  it("does not acknowledge a turn that is REQUESTED but not yet started", () => {
    // A turn row exists, so the old predicate's `latestTurnChanged` fires — but
    // `turn.started` has not been observed, which is precisely the running
    // branch's own bar (`latestTurn?.startedAt === null` ⇒ false, :575-577).
    expect(
      ack({
        phase: "connecting",
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-08-28T00:00:12.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...stoppedSession, status: "ready", updatedAt: "2026-08-28T00:00:12.000Z" },
      }),
    ).toBe(false);
  });

  it("DOES acknowledge the moment the user's turn actually starts", () => {
    // The release condition, and the only one: the dispatch is answered when the
    // turn it asked for exists and has started.
    expect(
      ack({
        phase: "connecting",
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-08-28T00:00:12.000Z",
          startedAt: "2026-08-28T00:00:13.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...stoppedSession, status: "ready", updatedAt: "2026-08-28T00:00:13.000Z" },
      }),
    ).toBe(true);
  });

  it("still acknowledges a turn that started AND settled inside the gap", () => {
    // The fast-answer case must not strand the composer in "Sending": a turn
    // that started is acknowledged whether or not it has already finished.
    expect(
      ack({
        phase: "ready",
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: "2026-08-28T00:00:12.000Z",
          startedAt: "2026-08-28T00:00:13.000Z",
          completedAt: "2026-08-28T00:00:14.000Z",
          assistantMessageId: null,
        },
        session: { ...stoppedSession, status: "ready", updatedAt: "2026-08-28T00:00:14.000Z" },
      }),
    ).toBe(true);
  });
});

describe("the timer start survives the same window", () => {
  // `isSendBusy` keeping the ROW up is only half the fix. The row renders the
  // static «Работаю…» with no seconds whenever `activeTurnStartedAt` is null
  // (MessagesTimeline.tsx:1303-1310) — the owner's second reported symptom — and
  // that value is `deriveActiveWorkStartedAt(latestTurn, session, sendStartedAt)`.
  const settledTurn = {
    turnId: stoppedTurn.turnId,
    startedAt: stoppedTurn.startedAt,
    completedAt: stoppedTurn.completedAt,
  };

  it("counts from the SEND instant while the session is respawning", () => {
    // Unacknowledged dispatch ⇒ `localDispatchStartedAt` is still the send
    // instant (ChatView.tsx:639), and the derive falls back to it because the
    // previous turn is settled and the session is not running.
    expect(
      deriveActiveWorkStartedAt(settledTurn, { status: "starting", activeTurnId: null }, SEND_AT),
    ).toBe(SEND_AT);
  });

  it("renders the TIMERLESS variant if the dispatch was released early", () => {
    // The regression this file exists to prevent, stated as a fact rather than
    // an argument: release the dispatch during the respawn and the start goes
    // null, which is exactly «Работаю…» with nothing ticking.
    expect(
      deriveActiveWorkStartedAt(settledTurn, { status: "starting", activeTurnId: null }, null),
    ).toBeNull();
  });
});
