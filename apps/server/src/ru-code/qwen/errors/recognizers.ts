// ru-code: classifier for cli-side and ru-code-side error
// failures. One named export per row in the routing table.
//
// Recognizers are checked in array order (first match wins). The
// `classify` walker returns either a `CliErrorDecision` or `null`
// (caller uses the unrecognized fallback).
//
// Type model
// ----------
// `CliErrorDecision` is a discriminated union so that `text` is
// required iff `surface` is set; recognizer authors cannot ship a
// "surface but no text" decision (compile error). Silent decisions
// omit both `surface` and `text` and just carry an id + the
// independent flags (`killAcp`, `endTurn`).
//
// Routing surfaces (B / T / T+N) and the implicit-behaviour rules
// (endTurn ignored on B, implicit true on T+N) are documented in the
// plan doc and enforced by the dispatcher in `dispatch.ts`.

import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import {
  APP_HOME_SLUG,
  CLI_DISPLAY_NAME,
  CLI_PROFILES,
  DEFAULT_CLI_PROFILE_ID,
} from "@ru-code/branding";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterValidationError,
  ProviderAdapterSessionNotFoundError,
} from "../../../provider/Errors.ts";
// ru-code: the decision TYPE MODEL now lives in @ru-code/qwen (shared with the
// dispatcher); this table stays in the app because it binds to the core
// ProviderAdapter* error classes above.
import { Surface, type CliErrorDecision } from "@ru-code/qwen/errors/types";

/**
 * ru-code: per-instance context threaded into `decide()`. Carries the active
 * profile's `artifact` id so the CONTEXT-file hint (`${artifact}.md`) matches the
 * instance's brand (stock qwen → `QWEN.md`, a fork → its own).
 */
export interface ClassifyContext {
  readonly artifact: string;
}

export interface CliErrorRecognizer {
  readonly id: string;
  readonly match: (error: unknown, cause: Cause.Cause<unknown>) => boolean;
  readonly decide: (
    error: unknown,
    cause: Cause.Cause<unknown>,
    ctx: ClassifyContext,
  ) => CliErrorDecision;
}

// -----------------------------------------------------------------
// shape helpers
// -----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpProtocolParseError = Schema.is(EffectAcpErrors.AcpProtocolParseError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const isAcpSpawnError = Schema.is(EffectAcpErrors.AcpSpawnError);

const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

/**
 * Walk one level of `.cause` on a wrapped tagged error to extract the
 * original AcpError. Used at sites #2-#4 where the original tag has
 * been wrapped by `mapAcpToAdapterError`.
 */
const innerCause = (error: unknown): unknown => {
  if (!isRecord(error)) return undefined;
  return error["cause"];
};

/**
 * ru-code: resolve the underlying `AcpRequestError` from either the bare error
 * (site #1, before mapping) OR a `mapAcpToAdapterError`-wrapped tag whose
 * `.cause` is the original (the finalizer / reactor sites, which classify the
 * MAPPED error). Without this, the A-bucket code matchers (A4/A5/A6 — surfaced
 * only after the turn fails into the finalizer) never matched the wrapped error
 * and fell through to the generic Z fallback, losing their T-vs-T+N surface and
 * Russian text. (A1/A2/A3/A7 are B-surface and matched at site #1 on the bare
 * error, so they worked already; this keeps them working and adds the wrapped
 * path harmlessly.)
 */
const asAcpRequestError = (error: unknown): EffectAcpErrors.AcpRequestError | undefined => {
  if (isAcpRequestError(error)) return error;
  const inner = innerCause(error);
  return isAcpRequestError(inner) ? inner : undefined;
};

/**
 * Read `data.details` from an AcpRequestError (bare or wrapped, if a string).
 * Exported for the model-discovery channel B hook (QwenAdapter), which mines
 * the same details text the recognizers match on — one reader, no drift.
 */
export const readAcpDetails = (error: unknown): string | undefined => {
  const request = asAcpRequestError(error);
  if (request === undefined) return undefined;
  if (!isRecord(request.data)) return undefined;
  const details = request.data["details"];
  return typeof details === "string" ? details : undefined;
};

const readExitCode = (error: unknown): number | undefined => {
  const inner = innerCause(error);
  if (isAcpProcessExitedError(inner)) return inner.code;
  // Also handle the un-wrapped case (some catch sites may not go through
  // mapAcpToAdapterError before classify runs).
  if (isAcpProcessExitedError(error)) return error.code;
  return undefined;
};

const isDefect = (cause: Cause.Cause<unknown>): boolean => {
  // Any Die reason in the cause chain means the failure escaped the
  // error channel — synchronous throw inside an Effect.gen body.
  return cause.reasons.some(Cause.isDieReason);
};

// -----------------------------------------------------------------
// recognizers — A bucket (CLI RPC failures, site #1)
// -----------------------------------------------------------------

const EMPTY_STREAM_DETAIL_MARKERS = [
  "Model stream ended with empty response text",
  "Model stream ended without a finish reason",
] as const;

/** A1 — CLI `InvalidStreamError` (NO_RESPONSE_TEXT / NO_FINISH_REASON). */
export const A1_EMPTY_STREAM: CliErrorRecognizer = {
  id: "A1",
  match: (error) => {
    const request = asAcpRequestError(error);
    if (request === undefined) return false;
    if (request.code !== -32603) return false;
    const details = readAcpDetails(error);
    if (details === undefined) return false;
    return EMPTY_STREAM_DETAIL_MARKERS.some((marker) => details.includes(marker));
  },
  decide: () => ({
    id: "A1",
    surface: [Surface.Bubble],
    text: '⚠️ The model returned an empty response. Try sending "continue" — that sometimes works.',
  }),
};

/** A2 — CLI `RequestError(429)` rate limit. */
export const A2_RATE_LIMIT: CliErrorRecognizer = {
  id: "A2",
  match: (error) => {
    const request = asAcpRequestError(error);
    if (request === undefined) return false;
    if (request.code === 429) return true;
    if (request.code === -32603) {
      const details = readAcpDetails(error);
      if (details !== undefined && details.includes("Rate limit exceeded")) return true;
    }
    return false;
  },
  decide: () => ({
    id: "A2",
    surface: [Surface.Bubble],
    text: "⚠️ Too many requests. Wait a minute and send the message again.",
  }),
};

const MAX_DETAILS_PREVIEW = 200;

const truncateDetails = (details: string): string =>
  details.length <= MAX_DETAILS_PREVIEW ? details : `${details.slice(0, MAX_DETAILS_PREVIEW - 1)}…`;

// ru-code: qwen rejects slash commands that need interactive confirmation
// (e.g. /init when QWEN.md already exists → confirm_action, which the ACP
// integration can't display). qwen reports this as a generic -32603 whose
// ONLY discriminator is this prose prefix in `data.details` — the code is
// shared by unrelated failures and qwen drops the structured `originalType` —
// so we match the marker substring. Surfaced as B (qwen stays alive, the user
// just retries). Kept as a markdown bullet list so more causes/solutions can
// be appended without touching the matcher.
const SLASH_UNSUPPORTED_MARKER = "Slash command not supported in ACP";

// ru-code: the CONTEXT file base is per-profile (artifact id), threaded via ClassifyContext.
const slashUnsupportedText = (artifact: string): string =>
  [
    "⚠️ The command could not be run.",
    "",
    "Possible causes and fixes:",
    `- The file \`${artifact}.md\` already exists — delete it and retry.`,
  ].join("\n");

/** A7 — slash command rejected by the CLI's ACP integration. Narrower than A3. */
export const A7_SLASH_UNSUPPORTED: CliErrorRecognizer = {
  id: "A7",
  match: (error) => {
    const details = readAcpDetails(error);
    return details !== undefined && details.includes(SLASH_UNSUPPORTED_MARKER);
  },
  decide: (_error, _cause, ctx) => ({
    id: "A7",
    surface: [Surface.Bubble],
    text: slashUnsupportedText(ctx.artifact),
  }),
};

/**
 * A3 — any other CLI `-32603` with a usable `data.details` string.
 * Must come AFTER A1 and A2 so their narrower matchers win.
 */
export const A3_GENERIC_RPC_DETAIL: CliErrorRecognizer = {
  id: "A3",
  match: (error) => {
    const request = asAcpRequestError(error);
    if (request === undefined) return false;
    if (request.code !== -32603) return false;
    const details = readAcpDetails(error);
    return details !== undefined && details.trim().length > 0;
  },
  decide: (error) => ({
    id: "A3",
    surface: [Surface.Bubble],
    text: `⚠️ ${CLI_DISPLAY_NAME} returned an error: ${truncateDetails(readAcpDetails(error)!)}. Try sending the message again.`,
  }),
};

/** A4 — protocol-level errors (invalidParams / methodNotFound). */
export const A4_PROTOCOL: CliErrorRecognizer = {
  id: "A4",
  match: (error) => {
    const request = asAcpRequestError(error);
    if (request === undefined) return false;
    return request.code === -32600 || request.code === -32601 || request.code === -32602;
  },
  decide: () => ({
    id: "A4",
    surface: [Surface.Timeline],
    text: `Internal ${CLI_DISPLAY_NAME} protocol error. See the server log for details.`,
    killAcp: false,
    endTurn: true,
  }),
};

/** A5 — auth required. */
export const A5_AUTH_REQUIRED: CliErrorRecognizer = {
  id: "A5",
  match: (error) => asAcpRequestError(error)?.code === -32000,
  decide: () => ({
    id: "A5",
    surface: [Surface.Timeline, Surface.Notification],
    text: `${CLI_DISPLAY_NAME} authorization required. Restart the app.`,
    killAcp: false,
  }),
};

/** A6 — resource not found. */
export const A6_RESOURCE_NOT_FOUND: CliErrorRecognizer = {
  id: "A6",
  match: (error) => asAcpRequestError(error)?.code === -32002,
  decide: () => ({
    id: "A6",
    surface: [Surface.Timeline],
    text: `${CLI_DISPLAY_NAME} resource not found. Send a message to continue.`,
    killAcp: false,
    endTurn: true,
  }),
};

// -----------------------------------------------------------------
// recognizers — B bucket (CLI process exits — sites #1/#2)
// -----------------------------------------------------------------

const FATAL_REASON_BY_EXIT_CODE: Record<number, string> = {
  41: "authorization required",
  42: "invalid input",
  44: "sandbox error",
  52: "configuration error",
  53: "turn limit reached",
  54: "tool error",
};

const fatalText = (exitCode: number | undefined): string => {
  if (exitCode === 130) {
    return `The ${CLI_DISPLAY_NAME} session was interrupted. Send a message to continue.`;
  }
  const reason = exitCode !== undefined ? FATAL_REASON_BY_EXIT_CODE[exitCode] : undefined;
  if (reason !== undefined) {
    return `The ${CLI_DISPLAY_NAME} session ended: ${reason}. Send a message to restart the session.`;
  }
  if (exitCode !== undefined) {
    return `The ${CLI_DISPLAY_NAME} session ended (code ${exitCode}). Send a message to restart the session.`;
  }
  return `The ${CLI_DISPLAY_NAME} process exited unexpectedly. Send a message to restart the session.`;
};

/**
 * B1 / B2 — CLI process exit. Matches both the wrapped
 * `ProviderAdapterSessionClosedError` (post-mapAcpToAdapterError) and
 * the bare `AcpProcessExitedError` (if classify runs before mapping).
 * Exit code drives the text variant; missing code → B2 generic.
 */
export const PROCESS_EXITED: CliErrorRecognizer = {
  id: "B1",
  match: (error) =>
    isProviderAdapterSessionClosedError(error) ||
    isAcpProcessExitedError(error) ||
    isAcpProcessExitedError(innerCause(error)),
  decide: (error) => {
    const exitCode = readExitCode(error);
    return {
      id: exitCode !== undefined ? `B1.${exitCode}` : "B2",
      surface: [Surface.Timeline, Surface.Notification],
      text: fatalText(exitCode),
      killAcp: false,
    };
  },
};

/** B3 — spawn failure (`AcpSpawnError`). Process is already gone. */
export const SPAWN_FAILURE: CliErrorRecognizer = {
  id: "B3",
  match: (error) => isAcpSpawnError(error) || isAcpSpawnError(innerCause(error)),
  decide: () => ({
    id: "B3",
    surface: [Surface.Timeline, Surface.Notification],
    text: `Could not start the ${CLI_DISPLAY_NAME} process. Check the installation (run \`${APP_HOME_SLUG}\` again).`,
    killAcp: false,
  }),
};

// -----------------------------------------------------------------
// recognizers — C bucket (ACP event-stream failures)
// -----------------------------------------------------------------

/** C1 — malformed protocol JSON. */
export const C1_PROTOCOL_PARSE: CliErrorRecognizer = {
  id: "C1",
  match: (error) => isAcpProtocolParseError(error) || isAcpProtocolParseError(innerCause(error)),
  decide: () => ({
    id: "C1",
    surface: [Surface.Timeline, Surface.Notification],
    text: `${CLI_DISPLAY_NAME} protocol failure: malformed JSON. Send a message to reconnect.`,
    killAcp: true,
  }),
};

/**
 * C4 — broken pipe / EOF / generic transport failure.
 * `AcpTransportError` from `effect-acp/src/protocol.ts:415,426` — both
 * throw sites mean the transport is dead. Catches the wrapped
 * `ProviderAdapterProcessError` too (which carries the original as
 * its `.cause`).
 */
export const C4_TRANSPORT: CliErrorRecognizer = {
  id: "C4",
  match: (error) =>
    isAcpTransportError(error) ||
    isAcpTransportError(innerCause(error)) ||
    isProviderAdapterProcessError(error),
  decide: () => ({
    id: "C4",
    surface: [Surface.Timeline, Surface.Notification],
    text: `Connection to ${CLI_DISPLAY_NAME} lost. Send a message to reconnect.`,
    killAcp: true,
  }),
};

// (C2, C3 share the C4 wire shape — schema/stall failures also produce
// AcpProtocolParseError or AcpTransportError depending on the site.
// Splitting into separate recognizers gains no signal today; the C4
// recognizer's text is also accurate for stall and schema breakage
// at the level of fidelity the UI shows. Revisit if telemetry shows
// a real need to discriminate.)

// -----------------------------------------------------------------
// recognizers — D bucket (ru-code-side validation / lookup)
// -----------------------------------------------------------------

/** D2 — adapter session not found. Specific text. Must come BEFORE D1/D3. */
export const D2_SESSION_NOT_FOUND: CliErrorRecognizer = {
  id: "D2",
  match: (error) => isProviderAdapterSessionNotFoundError(error),
  decide: () => ({
    id: "D2",
    surface: [Surface.Timeline],
    text: `${CLI_DISPLAY_NAME} session not found. Send a message to reconnect.`,
    killAcp: false,
    endTurn: true,
  }),
};

/** D1 — adapter input validation error. Plan: SIGKILL CLI, our state is suspect. */
export const D1_VALIDATION: CliErrorRecognizer = {
  id: "D1",
  match: (error) => isProviderAdapterValidationError(error),
  decide: () => ({
    id: "D1",
    surface: [Surface.Timeline],
    text: "Internal request-validation error. See the server log for details.",
    killAcp: true,
    endTurn: true,
  }),
};

/**
 * ru-code: exact detail of the sendTurn fail-fast guard while a hidden
 * `/compress` runs. One source: the adapter raises it, the recognizer below
 * pins it, tests assert it.
 */
export const COMPRESS_IN_PROGRESS_DETAIL =
  "Context compaction is in progress; wait for it to finish.";

/**
 * B5 — send attempted while a hidden context compaction is running on the
 * thread's serial ACP session. Fail-fast by design (compression can take
 * minutes; queueing the send would look like a hang, cancelling the
 * compression would waste it). The session is HEALTHY: no kill, the user
 * simply retries after the row/banner clears.
 */
export const B5_COMPRESS_IN_PROGRESS: CliErrorRecognizer = {
  id: "B5",
  match: (error) =>
    isProviderAdapterRequestError(error) && error.detail === COMPRESS_IN_PROGRESS_DETAIL,
  decide: () => ({
    id: "B5",
    surface: [Surface.Timeline, Surface.Notification],
    text: COMPRESS_IN_PROGRESS_DETAIL,
    killAcp: false,
  }),
};

/**
 * D3 — other ProviderService / ProviderRegistry errors. Catch-all by
 * tag-name shape: any tagged error whose `_tag` starts with "Provider"
 * and isn't already handled above. We use a structural check so we
 * don't have to import every concrete class.
 */
const PROVIDER_TAG_PREFIX = "Provider";

const hasTag = (value: unknown): value is { readonly _tag: string } =>
  isRecord(value) && typeof value["_tag"] === "string";

export const D3_OTHER_PROVIDER_ERROR: CliErrorRecognizer = {
  id: "D3",
  match: (error) => {
    if (!hasTag(error)) return false;
    if (!error._tag.startsWith(PROVIDER_TAG_PREFIX)) return false;
    // Already handled by more specific recognizers — let those win.
    if (isProviderAdapterRequestError(error)) return false;
    if (isProviderAdapterSessionClosedError(error)) return false;
    if (isProviderAdapterProcessError(error)) return false;
    if (isProviderAdapterValidationError(error)) return false;
    if (isProviderAdapterSessionNotFoundError(error)) return false;
    return true;
  },
  decide: () => ({
    id: "D3",
    surface: [Surface.Timeline],
    text: "Internal provider error. See the server log for details.",
    killAcp: true,
    endTurn: true,
  }),
};

// -----------------------------------------------------------------
// recognizers — E bucket (defects)
// -----------------------------------------------------------------

/**
 * E — defects (`Cause.die`). Synchronous JS exceptions inside Effect.gen
 * that escape the error channel. Our state is suspect — SIGKILL CLI
 * to avoid orphan event streams.
 */
export const E_DEFECT: CliErrorRecognizer = {
  id: "E",
  match: (_error, cause) => isDefect(cause),
  decide: () => ({
    id: "E",
    surface: [Surface.Timeline],
    text: "An unexpected server error occurred. See the log for details.",
    killAcp: true,
    endTurn: true,
  }),
};

// -----------------------------------------------------------------
// recognizers — clean-detail fallback (preserves today's A4-A6 behaviour)
// -----------------------------------------------------------------

/**
 * `Z_CLEAN_REQUEST_ERROR` — runs LAST. If the failure is a
 * `ProviderAdapterRequestError` with a non-empty `.detail` that none of
 * the more specific recognizers caught, surface it as T+N using its
 * detail verbatim. Preserves byte-identical UI for everything that
 * worked before this module existed (the old `formatFailureDetail`
 * fast path).
 */
export const Z_CLEAN_REQUEST_ERROR: CliErrorRecognizer = {
  id: "request-error",
  match: (error) => isProviderAdapterRequestError(error) && error.detail.trim().length > 0,
  decide: (error) => ({
    id: "request-error",
    surface: [Surface.Timeline, Surface.Notification],
    // Schema.is narrowed `error` above, so this cast is safe.
    text: (error as ProviderAdapterRequestError).detail,
    killAcp: false,
  }),
};

// -----------------------------------------------------------------
// registry + walker
// -----------------------------------------------------------------

/**
 * Order matters: first match wins. More specific recognizers come
 * before more general ones. The `Z_CLEAN_REQUEST_ERROR` catch-all
 * runs last so any unrecognized clean-detail RequestError still
 * surfaces with its native text (no regression vs. pre-classifier
 * code).
 */
export const RECOGNIZERS: ReadonlyArray<CliErrorRecognizer> = [
  A1_EMPTY_STREAM,
  A2_RATE_LIMIT,
  A4_PROTOCOL,
  A5_AUTH_REQUIRED,
  A6_RESOURCE_NOT_FOUND,
  A7_SLASH_UNSUPPORTED,
  A3_GENERIC_RPC_DETAIL,
  PROCESS_EXITED,
  SPAWN_FAILURE,
  B5_COMPRESS_IN_PROGRESS,
  C1_PROTOCOL_PARSE,
  C4_TRANSPORT,
  D2_SESSION_NOT_FOUND,
  D1_VALIDATION,
  D3_OTHER_PROVIDER_ERROR,
  E_DEFECT,
  Z_CLEAN_REQUEST_ERROR,
];

/**
 * Walk the registry in order; return the first matching decision.
 * Callers handle `null` (no recognizer matched) with the generic
 * unrecognized fallback documented in the dispatcher.
 */
export const classify = (
  error: unknown,
  cause: Cause.Cause<unknown>,
  // ru-code: profile artifact for the CONTEXT-file hint; defaults to the boot profile.
  artifact: string = CLI_PROFILES[DEFAULT_CLI_PROFILE_ID].artifact,
): CliErrorDecision | null => {
  const ctx: ClassifyContext = { artifact };
  for (const recognizer of RECOGNIZERS) {
    if (recognizer.match(error, cause)) {
      return recognizer.decide(error, cause, ctx);
    }
  }
  return null;
};

/**
 * Decision returned when no recognizer matched. Surfaces as T+N with
 * a generic Russian fallback; the dispatcher logs the failure's
 * message/details to the server console so it isn't lost. Promoting an
 * unrecognized failure to a named recognizer is then a code edit
 * driven by the `[runtime]` breadcrumb (code: "unrecognized").
 */
export const UNRECOGNIZED_DECISION: CliErrorDecision = {
  id: "unrecognized",
  surface: [Surface.Timeline, Surface.Notification],
  text: "An unexpected error occurred. See the server log for details.",
  killAcp: false,
};
