import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

/**
 * Map a UI-level approval decision to its ACP-protocol permission `kind`.
 *
 * This is a stable, protocol-level mapping (every ACP agent uses the same
 * `kind` vocabulary). The follow-up — turning the `kind` into an actual
 * `optionId` to send back — is per-request and lives at the call site,
 * because `optionId` is opaque and only the agent's `params.options[]`
 * knows the right value. Use {@link findPermissionOptionIdByKind}.
 *
 * `"cancel"` returns `null`: the caller should short-circuit to a
 * `cancelled` outcome rather than picking an option.
 */
export function decisionToPermissionKind(
  decision: ProviderApprovalDecision,
): EffectAcpSchema.PermissionOption["kind"] | null {
  switch (decision) {
    case "acceptForSession":
      return "allow_always";
    case "accept":
      return "allow_once";
    case "decline":
      return "reject_once";
    case "cancel":
    default:
      return null;
  }
}

/**
 * Look up the agent-supplied `optionId` for a given permission `kind`.
 *
 * ACP `optionId`s are opaque strings the agent picks per request (e.g.
 * Cli 0.15.5 uses `"proceed_once"`, but other agents/versions may use
 * anything). Always echo back what the agent sent — never fabricate.
 *
 * Returns `null` when no option of that kind is available; the caller
 * should treat that as a protocol gap and cancel rather than guess.
 */
export function findPermissionOptionIdByKind(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
  kind: EffectAcpSchema.PermissionOption["kind"],
): string | null {
  const matched = options.find((option) => option.kind === kind);
  const optionId = matched?.optionId?.trim();
  return optionId !== undefined && optionId.length > 0 ? optionId : null;
}
