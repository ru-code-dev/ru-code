import { stripUnknownLeadingSlashCommand } from "./stripUnknownLeadingSlashCommand";

/**
 * Composer-side wrapper around stripUnknownLeadingSlashCommand. Owns the
 * promptRef mutation; the caller supplies `onClear` (additional UI cleanup for
 * the bare-unknown-slash case — e.g. clearing the draft store + composer
 * cursor state).
 *
 * Returns `false` when the prompt was only an unknown slash command — caller
 * must abort the submit. Returns `true` otherwise (prompt may have been
 * rewritten in place); caller proceeds with the normal send flow.
 */
export const applyUnknownSlashCommandStripToComposer = (ctx: {
  promptRef: { current: string };
  onClear: () => void;
}): boolean => {
  const result = stripUnknownLeadingSlashCommand(ctx.promptRef.current);
  if (result === null) {
    ctx.promptRef.current = "";
    ctx.onClear();
    return false;
  }
  ctx.promptRef.current = result;
  return true;
};
