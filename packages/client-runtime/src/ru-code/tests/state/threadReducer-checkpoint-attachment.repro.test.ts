// ru-code: sometimes-no-diff-in-chat, client half. The live client applies
// events through this reducer. When the server's checkpoint capture raced the
// message projection, the `thread.turn-diff-completed` event payload carries a
// SYNTHETIC `assistant:<turnId>` id; and the qwen runtime's trailing segment
// close produced a SECOND `thread.message-sent` for the same assistant message
// with `turnId: null` (live log 2026-07-12 12:52). Pinned here:
//   - the synthetic-id orderings (heal + no-detach);
//   - the full live 12:52 sequence: the turn-less second completion must not
//     erase the message's turn binding, must not drop ANY message (the user
//     message vanished live), and the checkpoint must attach to the real
//     message id.
// All ids use the REAL wire shapes: turn ids are UUIDs (the synthetic
// classifier matches `assistant:<uuid>` exactly), real qwen message ids are
// `assistant:assistant:<sessionId>:r<nonce>:segment:N`.
import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "../../../state/threadReducer.ts";

const THREAD = ThreadId.make("thread-1");
const TURN = TurnId.make("8e10f236-d7a8-4076-9782-6dcb33be3a00");
const ASSISTANT_MESSAGE = MessageId.make(
  "assistant:assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:0",
);
const USER_MESSAGE = MessageId.make("user-message-1");

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  aggregateKind: "thread",
  aggregateId: THREAD,
} as const;

const baseThread: OrchestrationThread = {
  id: THREAD,
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  // ru-code: fixture rot (A15) — OrchestrationThread grew these two fields on
  // this base; neutral values, unrelated to what this fixture exercises.
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const userMessageSent = (sequence: number) =>
  ({
    ...baseEventFields,
    sequence,
    occurredAt: "2026-04-01T00:00:01.000Z",
    type: "thread.message-sent",
    payload: {
      threadId: THREAD,
      messageId: USER_MESSAGE,
      role: "user",
      text: "сделай файл",
      attachments: [],
      turnId: TURN,
      streaming: false,
      createdAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:01.000Z",
    },
  }) as never;

const assistantMessageSent = (sequence: number) =>
  ({
    ...baseEventFields,
    sequence,
    occurredAt: "2026-04-01T00:00:05.000Z",
    type: "thread.message-sent",
    payload: {
      threadId: THREAD,
      messageId: ASSISTANT_MESSAGE,
      role: "assistant",
      text: "Готово: файл создан.",
      attachments: [],
      turnId: TURN,
      streaming: false,
      createdAt: "2026-04-01T00:00:05.000Z",
      updatedAt: "2026-04-01T00:00:05.000Z",
    },
  }) as never;

// The trailing completion from the live log: SAME assistant message id,
// turnId null, no new text.
const assistantMessageTrailingTurnless = (sequence: number) =>
  ({
    ...baseEventFields,
    sequence,
    occurredAt: "2026-04-01T00:00:05.100Z",
    type: "thread.message-sent",
    payload: {
      threadId: THREAD,
      messageId: ASSISTANT_MESSAGE,
      role: "assistant",
      text: "",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T00:00:05.000Z",
      updatedAt: "2026-04-01T00:00:05.100Z",
    },
  }) as never;

const turnDiffCompleted = (sequence: number, assistantMessageId: MessageId) =>
  ({
    ...baseEventFields,
    sequence,
    occurredAt: "2026-04-01T00:00:06.000Z",
    type: "thread.turn-diff-completed",
    payload: {
      threadId: THREAD,
      turnId: TURN,
      completedAt: "2026-04-01T00:00:06.000Z",
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-1/1"),
      status: "ready",
      files: [{ path: "hello-123.md", kind: "modified", additions: 1, deletions: 0 }],
      assistantMessageId,
      checkpointTurnCount: 1,
    },
  }) as never;

const apply = (thread: OrchestrationThread, event: never): OrchestrationThread => {
  const result = applyThreadDetailEvent(thread, event);
  if (result.kind !== "updated") {
    throw new Error(`expected an updated thread, got ${result.kind}`);
  }
  return result.thread;
};

describe("live checkpoint ↔ assistant message attachment (reducer)", () => {
  it("control: checkpoint first (synthetic id), message after — the rebind heals it", () => {
    let thread = apply(baseThread, turnDiffCompleted(1, MessageId.make(`assistant:${TURN}`)));
    thread = apply(thread, assistantMessageSent(2));
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(ASSISTANT_MESSAGE);
  });

  it("INTENDED: message first, late checkpoint with a synthetic id must not detach the chip", () => {
    let thread = apply(baseThread, assistantMessageSent(1));
    thread = apply(thread, turnDiffCompleted(2, MessageId.make(`assistant:${TURN}`)));
    // The chat chip/revert lookup is `checkpoint.assistantMessageId ∈ rendered
    // messages` — after this ordering the checkpoint points at a message id
    // that never renders, so the diff shows in the Diff panel but not in
    // chat, and revert disappears.
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(ASSISTANT_MESSAGE);
  });

  it("a REAL qwen-shaped checkpoint id is used verbatim (never mistaken for synthetic)", () => {
    let thread = apply(baseThread, assistantMessageSent(1));
    thread = apply(thread, turnDiffCompleted(2, ASSISTANT_MESSAGE));
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(ASSISTANT_MESSAGE);
  });

  it("live 12:52 sequence: turn-less trailing completion — no message lost, turn binding kept, chip attached", () => {
    // user message → assistant completed with turn → SAME id completed again
    // with turnId null → checkpoint lands with a synthetic id.
    let thread = apply(baseThread, userMessageSent(1));
    thread = apply(thread, assistantMessageSent(2));
    thread = apply(thread, assistantMessageTrailingTurnless(3));
    thread = apply(thread, turnDiffCompleted(4, MessageId.make(`assistant:${TURN}`)));

    // The user message vanished live — no event in this sequence may drop it.
    expect(thread.messages.map((message) => message.id)).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE]);
    // The trailing completion carried no turn — that is no information, the
    // binding stays (live it became null and every turnId join went blind).
    const assistantMessage = thread.messages.find((message) => message.id === ASSISTANT_MESSAGE);
    expect(assistantMessage?.turnId).toBe(TURN);
    // And the text set by the real completion survives the empty trailing one.
    expect(assistantMessage?.text).toBe("Готово: файл создан.");
    // With the binding intact the synthetic checkpoint id resolves to the real
    // message — chip + revert render without a reload.
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(ASSISTANT_MESSAGE);
  });
});
