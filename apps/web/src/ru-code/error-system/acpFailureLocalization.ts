// ru-code: Russian-localized copy for ACP failure work-log activities. The server
// emits `provider.user-input.respond.failed` / `provider.approval.respond.failed`
// with an English `payload.detail` (ProviderCommandReactor's stalePendingRequestDetail
// / no-session messages). Returns a RU string for the known shapes, or null so the
// caller falls back to the raw detail / summary. The no-session string uses the
// neutral CLI_DISPLAY_NAME instead of a hardcoded brand.
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { CLI_DISPLAY_NAME } from "@ru-code/branding";

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
    return "The session expired — retry the request";
  }
  if (STALE_APPROVAL_PATTERN.test(detail)) {
    return "The session expired — retry the request";
  }
  if (NO_SESSION_PATTERN.test(detail)) {
    return `The ${CLI_DISPLAY_NAME} session isn't active — retry the request`;
  }
  // Unknown failure detail: surface the raw text so we don't hide information.
  return null;
}
