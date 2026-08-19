/**
 * ru-code: attachment of turn diff summaries (git checkpoints) to chat rows —
 * extracted verbatim from ChatView's inline memos so the composite the user
 * sees (diff chip under the assistant message + revert count on the user
 * message) is testable. `turnDiffAttachment.test.ts` pins the contract.
 *
 * @module ru-code/chat/turnDiffAttachment
 */
import type { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import type { TurnDiffSummary } from "../../types";

/**
 * Index the thread's checkpoints by the assistant message the chip renders
 * under. A summary without an assistantMessageId is skipped.
 *
 * When a summary's id matches NO rendered message (the server-side capture
 * raced the message and persisted a synthetic `assistant:<turnId>` id — old
 * threads carry these forever), fall back to the summary's turn: attach to
 * that turn's LAST rendered assistant message. Without this the diff shows in
 * the Diff panel but never in chat, and the revert control disappears.
 */
export function deriveTurnDiffSummaryByAssistantMessageId(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  timelineEntries: ReadonlyArray<TimelineEntry>,
): Map<MessageId, TurnDiffSummary> {
  const renderedMessageIds = new Set<MessageId>();
  const lastAssistantMessageIdByTurnId = new Map<TurnId, MessageId>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "message") continue;
    renderedMessageIds.add(entry.message.id);
    if (entry.message.role === "assistant" && entry.message.turnId) {
      lastAssistantMessageIdByTurnId.set(entry.message.turnId, entry.message.id);
    }
  }

  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of turnDiffSummaries) {
    if (!summary.assistantMessageId) continue;
    const attachedMessageId = renderedMessageIds.has(summary.assistantMessageId)
      ? summary.assistantMessageId
      : lastAssistantMessageIdByTurnId.get(summary.turnId);
    if (!attachedMessageId) {
      continue;
    }
    byMessageId.set(attachedMessageId, summary);
  }
  return byMessageId;
}

/**
 * Per user message: the checkpoint turn-count to revert TO (the state before
 * that message's turn) — derived from the first following assistant message
 * that carries a diff summary.
 */
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  readonly inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
}): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();
  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const entry = input.timelineEntries[index];
    if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < input.timelineEntries.length; nextIndex += 1) {
      const nextEntry = input.timelineEntries[nextIndex];
      if (!nextEntry || nextEntry.kind !== "message") {
        continue;
      }
      if (nextEntry.message.role === "user") {
        break;
      }
      const summary = input.turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
      if (!summary) {
        continue;
      }
      const turnCount =
        summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof turnCount !== "number") {
        break;
      }
      byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
      break;
    }
  }

  return byUserMessageId;
}
