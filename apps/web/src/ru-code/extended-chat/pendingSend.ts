// ru-code: draft-first send for the extended view. The default timeline renders
// a sent message instantly from `optimisticUserMessages`; the extended view is
// transcript-derived, so it gets the SAME payload through this selector and
// synthesizes a user bubble until the CLI writes the real record.
import type { OptimisticSend } from "@smart-tools/qwen-cli-extended-chat/web";

/** The minimal shape this selector needs from ChatView's `ChatMessage`. */
export interface OptimisticMessageLike {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * The optimistic entry for the ACTIVE send (`anchorId` = the send's MessageId —
 * the same identity the send anchor uses, so bubble and anchor always agree).
 * Null when there is no active send or its entry was already reconciled.
 */
export function selectPendingSendFor(
  optimisticMessages: ReadonlyArray<OptimisticMessageLike>,
  anchorId: string | null,
): OptimisticSend | null {
  if (anchorId === null) return null;
  const entry = optimisticMessages.find((message) => message.id === anchorId);
  if (entry === undefined) return null;
  return { id: entry.id, text: entry.text, createdAt: entry.createdAt };
}
