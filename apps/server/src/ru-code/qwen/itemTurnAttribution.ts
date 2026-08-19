/**
 * ru-code: turn attribution for ACP assistant items — the WHOLE decision, so
 * the wiring bug it exists to kill stays testable as a composite.
 *
 * The disease: the ACP runtime enqueues the trailing `AssistantItemCompleted`
 * AFTER `session/prompt` resolves (QwenAcpSessionRuntime closes the active
 * segment in the prompt's `Effect.tap`), and the adapter's notification fiber
 * may consume it after sendTurn's finalizer already cleared `activeTurnId`.
 * Stamping that completion from `activeTurnId` wiped the message's turnId in
 * every projection — diff chip, revert, healing and the chat fold all join on
 * it. qwen itself offers no identity on the wire (agent_message_chunk carries
 * no item/turn ids and chunk emission is un-awaited — qwen-code
 * Session.ts:308 — so a chunk can even trail the prompt response); the turn an
 * item belongs to is fixed the moment the item STARTS, and only we know it.
 *
 * @module ru-code/qwen/itemTurnAttribution
 */
import type { TurnId } from "@t3tools/contracts";

export interface ItemTurnAttributionState {
  /** The turn the adapter is currently running (cleared by the finalizer). */
  readonly activeTurnId: TurnId | undefined;
  /**
   * The most recent turn dispatched on this session — survives the finalizer.
   * Fallback for an item that STARTS after its turn settled (late chunk
   * trailing the prompt response): it belongs to the turn that just ended.
   */
  readonly lastTurnId: TurnId | undefined;
  /**
   * A hidden /compress prompt runs with no user turn; its output must not be
   * attributed to the previous turn.
   */
  readonly hiddenCompressActive: boolean;
}

/** Pin an item to its turn the moment it starts. Mutates `itemTurnIds`. */
export function attributeItemStarted(
  itemTurnIds: Map<string, TurnId>,
  state: ItemTurnAttributionState,
  itemId: string,
): TurnId | undefined {
  const turnId = state.activeTurnId ?? (state.hiddenCompressActive ? undefined : state.lastTurnId);
  if (turnId !== undefined) {
    itemTurnIds.set(itemId, turnId);
  }
  return turnId;
}

/**
 * Resolve the turn for an item completion (and release the pin). The pin
 * recorded at start wins — `activeTurnId` may already be cleared, or may
 * already belong to the NEXT turn when the completion is consumed late.
 */
export function attributeItemCompleted(
  itemTurnIds: Map<string, TurnId>,
  state: ItemTurnAttributionState,
  itemId: string,
): TurnId | undefined {
  const turnId =
    itemTurnIds.get(itemId) ??
    state.activeTurnId ??
    (state.hiddenCompressActive ? undefined : state.lastTurnId);
  itemTurnIds.delete(itemId);
  return turnId;
}

/** Resolve the turn for a content delta belonging to `itemId` (no release). */
export function attributeItemDelta(
  itemTurnIds: Map<string, TurnId>,
  state: ItemTurnAttributionState,
  itemId: string | undefined,
): TurnId | undefined {
  return (itemId !== undefined ? itemTurnIds.get(itemId) : undefined) ?? state.activeTurnId;
}
