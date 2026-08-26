// ru-code (mid-turn wave, phase 3): the per-session mid-turn message queue.
//
// THE ONE DESIGN RULE, and the reason this file is plain synchronous TypeScript
// with no Effect in sight:
//
//   The drain responder MUST NOT be able to await anything.
//
// qwen calls `craft/drainMidTurnQueue` on us and races the answer against a 2s
// timeout (Session.ts:516, raced at :4713-4722); three consecutive misses kill
// the channel for the session (:531, :4774-4783). Worse, our transport
// dispatches inbound ext requests INLINE on the stdin pump
// (effect-acp protocol.ts:458-462 — unlike core client requests, which are
// queued to a forked fiber at :342), so a responder that blocks does not merely
// risk the deadline: it stalls every inbound frame while it waits, and
// deadlocks outright if what it awaits depends on another frame arriving.
//
// A comment saying "don't await here" is not a guarantee. `takeForDrain` below
// returns a plain value — not a Promise, not an Effect — so the SPLICE cannot
// await, and `Effect.sync` around it rejects a thunk that returns a Promise.
//
// Stated precisely, because an earlier draft of this comment overclaimed
// (phase-4 finding m6): what the type system guarantees is that the splice is
// synchronous. It does NOT stop a future edit from yielding some other effect
// in the responder body, which is an `Effect.gen` and already yields the mark
// emission. The 2s-budget safety therefore rests on TWO things — this
// structural half, and the fact that the only effect the body yields publishes
// to an UNBOUNDED PubSub, which never blocks. If that ever changes, the budget
// argument has to be re-made.
//
// Persistence is therefore strictly OFF this path. The in-memory queue is
// authoritative and knows nothing about storage at all: every call site in
// `QwenAdapter` pairs its queue operation with an `emitDeliveryMarks(...)` call,
// and THAT is what eventually persists a mark. An earlier draft of this file
// described an observer channel (`MidTurnQueueListener`) that was never wired;
// it has been removed rather than left as documentation of an architecture that
// does not exist (phase-4 finding m5).

import type { ProviderSendTurnInput } from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/schema";

import { QWEN_MAX_MID_TURN_DRAIN_ITEMS } from "./midTurnDrainContract.ts";

type AcpContentBlock = AcpSchema.ContentBlock;

/** A message the user typed while a turn was running, waiting for delivery. */
export interface MidTurnQueueItem {
  /** Stable id so the UI can flip exactly this message's delivery mark. */
  readonly id: string;
  /** The raw text the user typed. May be empty for an attachment-only send. */
  readonly text: string;
  /**
   * ru-code (phase 4, M1): the FULL ACP content this message carries — the text
   * block plus any image blocks — resolved at ENQUEUE time.
   *
   * Resolved here rather than at drain because reading attachments is real file
   * I/O and the drain responder must stay a synchronous splice. Carrying blocks
   * rather than a bare string is what stops an attachment being silently
   * dropped while its balloon reports delivered.
   */
  readonly content: ReadonlyArray<AcpContentBlock>;
  /**
   * ru-code (phase 4, m8): the turn-shaping options this send carried.
   *
   * A mid-turn send can also switch model or toggle plan mode. Keeping only the
   * text meant those were accepted, marked pending, and then delivered without
   * either — a silent drop of the same class as the attachments one. Applied by
   * the turn-end flush, which is the point at which a queued message becomes a
   * real turn and the only point at which they CAN apply.
   */
  readonly turnOptions?: {
    readonly modelSelection?: ProviderSendTurnInput["modelSelection"];
    readonly interactionMode?: ProviderSendTurnInput["interactionMode"];
    readonly runtimeMode?: ProviderSendTurnInput["runtimeMode"];
  };
  /**
   * ru-code (P3c): the ORCHESTRATION message id this text came from, threaded
   * down via `ProviderSendTurnInput.messageId`. It is what makes a mark
   * ADDRESSABLE — without it the adapter holds text with no row to flip.
   * Optional because a caller that does not supply one still gets queueing;
   * it simply gets no visible mark.
   */
  readonly messageId?: string;
}

export interface MidTurnQueue {
  /** Append a message. Returns the item as stored. */
  readonly enqueue: (threadId: string, item: MidTurnQueueItem) => MidTurnQueueItem;
  /**
   * THE DRAIN PATH. Synchronous by construction — see the file header.
   *
   * Removes and returns AT MOST `QWEN_MAX_MID_TURN_DRAIN_ITEMS` items, oldest
   * first. The remainder STAYS QUEUED for the next drain: qwen's
   * `capMidTurnDrainItems` (Session.ts:662-669) does `items.slice(0, 10)` and
   * DISCARDS the surplus, so answering with eleven items would destroy the
   * eleventh in both places at once — we would have removed it from our queue
   * and qwen would never have read it. Capping here is what makes that
   * unreachable.
   */
  readonly takeForDrain: (threadId: string) => ReadonlyArray<MidTurnQueueItem>;
  /**
   * Remove and return EVERY queued item for the turn-end flush, which carries
   * them as one next `session/prompt` and is not subject to qwen's per-drain
   * cap.
   */
  readonly takeAllForFlush: (threadId: string) => ReadonlyArray<MidTurnQueueItem>;
  /**
   * Stop / crash / teardown: drop everything still queued. The items are
   * reported to the listener as `reset` so their balloons can flip to
   * NOT-DELIVERED. Nothing auto-fires afterwards.
   */
  readonly reset: (threadId: string) => ReadonlyArray<MidTurnQueueItem>;
  /**
   * ru-code (phase 4b, O1): put items BACK at the head, preserving their order.
   *
   * Used when a turn-end flush loses the dispatch race to a fresh user turn: the
   * messages were spliced out but never handed to a model, so they must return
   * to the front of the queue and ride the winning turn's own flush. Prepending
   * (not appending) keeps them ahead of anything queued during that turn, which
   * is the order the user typed them in.
   */
  readonly requeueFront: (threadId: string, items: ReadonlyArray<MidTurnQueueItem>) => void;
  /** How many messages are waiting. Used to answer `hasQueuedPrompt`. */
  readonly size: (threadId: string) => number;
}

export const makeMidTurnQueue = (): MidTurnQueue => {
  const queues = new Map<string, MidTurnQueueItem[]>();

  const removeFrom = (threadId: string, count: number): ReadonlyArray<MidTurnQueueItem> => {
    const queue = queues.get(threadId);
    if (queue === undefined || queue.length === 0) return [];
    const taken = queue.splice(0, count);
    if (queue.length === 0) queues.delete(threadId);
    return taken;
  };

  return {
    enqueue: (threadId, item) => {
      const queue = queues.get(threadId);
      if (queue === undefined) queues.set(threadId, [item]);
      else queue.push(item);
      return item;
    },
    takeForDrain: (threadId) => {
      const taken = removeFrom(threadId, QWEN_MAX_MID_TURN_DRAIN_ITEMS);
      return taken;
    },
    takeAllForFlush: (threadId) => {
      const taken = removeFrom(threadId, Number.POSITIVE_INFINITY);
      return taken;
    },
    reset: (threadId) => {
      const taken = removeFrom(threadId, Number.POSITIVE_INFINITY);
      return taken;
    },
    requeueFront: (threadId, items) => {
      if (items.length === 0) return;
      const queue = queues.get(threadId);
      if (queue === undefined) queues.set(threadId, [...items]);
      else queue.unshift(...items);
    },
    size: (threadId) => queues.get(threadId)?.length ?? 0,
  };
};
