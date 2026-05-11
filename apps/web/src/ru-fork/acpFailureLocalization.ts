/**
 * Russian-localized work-log copy for ACP failure activities. Mirrors
 * the English detail strings emitted by `ProviderCommandReactor`
 * (`stalePendingRequestDetail` and friends) and the no-session branch
 * messages. Returns `null` for unknown shapes so the caller can fall
 * back to the original `activity.summary` / `activity.payload.detail`.
 *
 * Kept in `ru-fork/` so the upstream-tracked `session-logic.ts`
 * touchpoint stays a single-line import, easing future T3 syncs.
 */

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

const STALE_USER_INPUT_PATTERN = /^Stale pending user-input request:/i;
const STALE_APPROVAL_PATTERN = /^Stale pending (?:approval|permission) request:/i;
const NO_SESSION_PATTERN = /^No active provider session/i;

export function localizeAcpFailureDetail(activity: OrchestrationThreadActivity): string | null {
  if (
    activity.kind !== "provider.user-input.respond.failed" &&
    activity.kind !== "provider.approval.respond.failed"
  ) {
    return null;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const detail = typeof payload?.detail === "string" ? payload.detail : "";

  if (STALE_USER_INPUT_PATTERN.test(detail)) {
    return "Сессия истекла — повторите запрос";
  }
  if (STALE_APPROVAL_PATTERN.test(detail)) {
    return "Сессия истекла — повторите запрос";
  }
  if (NO_SESSION_PATTERN.test(detail)) {
    return "Сессия Cli не активна — повторите запрос";
  }
  // Unknown failure detail: surface the raw text so we don't hide
  // diagnostic information from the user.
  return null;
}
