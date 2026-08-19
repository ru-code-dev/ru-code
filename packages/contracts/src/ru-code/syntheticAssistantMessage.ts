/**
 * ru-code: the synthetic assistant-message id minted when a checkpoint is
 * recorded before the turn's assistant message is projected. Two upstream
 * sites mint this shape (`CheckpointReactor` capture fallback from the turnId,
 * and `ProviderRuntimeIngestion`'s placeholder path from
 * `itemId ?? turnId ?? eventId`); the chat UI attaches the diff chip / revert
 * control by `checkpoints[].assistantMessageId ∈ rendered messages`, so a
 * synthetic id means "attachment unresolved" — it must never be treated as
 * real information (in particular it must never overwrite an already-resolved
 * real id).
 *
 * Classification is by EXACT shape, not prefix: real assistant message ids are
 * `assistant:${providerItemId}` too, and a provider item id can itself start
 * with `assistant:` (qwen: `assistant:<sessionId>:r<nonce>:segment:N`, giving
 * message ids like `assistant:assistant:…:segment:0`). A prefix test classified
 * those REAL ids as synthetic — which is exactly how the diff chip detached.
 * The turnId / eventId fallback sources are always UUIDs, so a synthetic id is
 * precisely `assistant:<uuid>` and nothing else. (A placeholder minted from a
 * PRESENT provider itemId intentionally equals the real message id the
 * completion will use — that one SHOULD classify as real.)
 *
 * @module contracts/ru-code/syntheticAssistantMessage
 */
import { MessageId } from "../baseSchemas.ts";

const SYNTHETIC_ASSISTANT_MESSAGE_PREFIX = "assistant:";

const SYNTHETIC_ASSISTANT_MESSAGE_SHAPE =
  /^assistant:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mint the placeholder id for a checkpoint whose message is not known yet. */
export function syntheticAssistantMessageId(sourceId: string): MessageId {
  return MessageId.make(`${SYNTHETIC_ASSISTANT_MESSAGE_PREFIX}${sourceId}`);
}

/** True for placeholder ids minted from a turnId/eventId UUID — see module doc. */
export function isSyntheticAssistantMessageId(
  messageId: MessageId | string | null | undefined,
): boolean {
  return messageId != null && SYNTHETIC_ASSISTANT_MESSAGE_SHAPE.test(messageId);
}
