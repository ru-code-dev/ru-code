// ru-code (mid-turn wave, phase 4b — m4/SB4, MUT-9): stickiness AT THE CLIENT
// REDUCER, the copy that governs the LIVE balloon.
//
// Round 2's MUT-9 dropped the `mergeMidTurnDeliveryState` call in
// `threadReducer` and the entire suite stayed green — 19 web composer files, 34
// client-runtime reducer tests, and zero `deliveryState` references anywhere in
// client-runtime's own tests. The rule was pinned (six contracts-level specs)
// and the WIRING was not.
//
// Driven through the real exported reducer via `@t3tools/client-runtime/state/threads`,
// which re-exports it (`threads.ts:737`), so no port file needed a test-only export.
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ThreadId,
  type MidTurnDeliveryState,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

const THREAD_ID = ThreadId.make("sticky-reducer-thread");
const MESSAGE_ID = MessageId.make("sticky-reducer-message");
const NOW = "2026-07-01T00:00:00.000Z";

let sequence = 0;
const messageSent = (deliveryState: MidTurnDeliveryState, text = ""): OrchestrationEvent => {
  sequence += 1;
  const id = `sticky-reducer-${sequence}`;
  return {
    type: "thread.message-sent",
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(id),
    causationEventId: null,
    correlationId: CorrelationId.make(id),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      role: "user",
      text,
      turnId: null,
      streaming: false,
      deliveryState,
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationEvent;
};

const baseThread = {
  id: THREAD_ID,
  messages: [],
  activities: [],
} as unknown as OrchestrationThread;

const fold = (...states: ReadonlyArray<MidTurnDeliveryState>) => {
  let thread = baseThread;
  states.forEach((state, index) => {
    const result = applyThreadDetailEvent(thread, messageSent(state, index === 0 ? "typed" : ""));
    if (result.kind === "updated") thread = result.thread;
  });
  return thread.messages.find((message) => message.id === MESSAGE_ID)?.deliveryState;
};

describe("threadReducer — delivery stickiness (the LIVE balloon)", () => {
  it("pending moves to delivered", () => {
    expect(fold("pending", "delivered")).toBe("delivered");
  });

  it("DELIVERED is sticky — a later not-delivered must not un-deliver it", () => {
    expect(fold("pending", "delivered", "not-delivered")).toBe("delivered");
  });

  it("NOT-DELIVERED is sticky — a stray late delivered must not resurrect it", () => {
    expect(fold("pending", "not-delivered", "delivered")).toBe("not-delivered");
  });
});
