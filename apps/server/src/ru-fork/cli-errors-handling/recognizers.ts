// ru-fork: classifier for cli-side and ru-fork-side error
// failures. One named export per row in the routing table at
// `ru-fork-instrumental/changes/server-errors-handaling.md`.
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
import { CLI_NAME } from "@ru-fork/branding";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterValidationError,
  ProviderAdapterSessionNotFoundError,
} from "../../provider/Errors.ts";

export type CliErrorSurface = "B" | "T" | "T+N";

interface CliErrorDecisionBase {
  readonly id: string;
  readonly killAcp?: boolean;
  readonly endTurn?: boolean;
}

export type CliErrorDecision =
  | (CliErrorDecisionBase & {
      readonly surface?: undefined;
      readonly text?: undefined;
    })
  | (CliErrorDecisionBase & {
      readonly surface: CliErrorSurface;
      readonly text: string;
    });

export interface CliErrorRecognizer {
  readonly id: string;
  readonly match: (error: unknown, cause: Cause.Cause<unknown>) => boolean;
  readonly decide: (error: unknown, cause: Cause.Cause<unknown>) => CliErrorDecision;
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

/** Read `data.details` from an AcpRequestError (if it's a string). */
const readAcpDetails = (error: unknown): string | undefined => {
  if (!isAcpRequestError(error)) return undefined;
  if (!isRecord(error.data)) return undefined;
  const details = error.data["details"];
  return typeof details === "string" ? details : undefined;
};

/**
 * Walk one level of `.cause` on a wrapped tagged error to extract the
 * original AcpError. Used at sites #2-#4 where the original tag has
 * been wrapped by `mapAcpToAdapterError`.
 */
const innerCause = (error: unknown): unknown => {
  if (!isRecord(error)) return undefined;
  return error["cause"];
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
    if (!isAcpRequestError(error)) return false;
    if (error.code !== -32603) return false;
    const details = readAcpDetails(error);
    if (details === undefined) return false;
    return EMPTY_STREAM_DETAIL_MARKERS.some((marker) => details.includes(marker));
  },
  decide: () => ({
    id: "A1",
    surface: "B",
    text: "⚠️ Модель вернула пустой ответ. Попробуйте отправить «продолжить» — иногда это срабатывает.",
  }),
};

/** A2 — CLI `RequestError(429)` rate limit. */
export const A2_RATE_LIMIT: CliErrorRecognizer = {
  id: "A2",
  match: (error) => {
    if (!isAcpRequestError(error)) return false;
    if (error.code === 429) return true;
    if (error.code === -32603) {
      const details = readAcpDetails(error);
      if (details !== undefined && details.includes("Rate limit exceeded")) return true;
    }
    return false;
  },
  decide: () => ({
    id: "A2",
    surface: "B",
    text: "⚠️ Слишком много запросов. Подождите минуту и отправьте сообщение снова.",
  }),
};

const MAX_DETAILS_PREVIEW = 200;

const truncateDetails = (details: string): string =>
  details.length <= MAX_DETAILS_PREVIEW ? details : `${details.slice(0, MAX_DETAILS_PREVIEW - 1)}…`;

// ru-fork: qwen rejects slash commands that need interactive confirmation
// (e.g. /init when QWEN.md already exists → confirm_action, which the ACP
// integration can't display). qwen reports this as a generic -32603 whose
// ONLY discriminator is this prose prefix in `data.details` — the code is
// shared by unrelated failures and qwen drops the structured `originalType` —
// so we match the marker substring. Surfaced as B (qwen stays alive, the user
// just retries). Kept as a markdown bullet list so more causes/solutions can
// be appended without touching the matcher.
const SLASH_UNSUPPORTED_MARKER = "Slash command not supported in ACP";

const CONTEXT_FILE_NAME = `${CLI_NAME.toUpperCase()}.md`;

const SLASH_UNSUPPORTED_TEXT = [
  "⚠️ Не удалось выполнить команду.",
  "",
  "Возможные причины и решения:",
  `- Файл \`${CONTEXT_FILE_NAME}\` уже существует — удалите его и повторите.`,
].join("\n");

/** A7 — slash command rejected by the CLI's ACP integration. Narrower than A3. */
export const A7_SLASH_UNSUPPORTED: CliErrorRecognizer = {
  id: "A7",
  match: (error) => {
    const details = readAcpDetails(error);
    return details !== undefined && details.includes(SLASH_UNSUPPORTED_MARKER);
  },
  decide: () => ({
    id: "A7",
    surface: "B",
    text: SLASH_UNSUPPORTED_TEXT,
  }),
};

/**
 * A3 — any other CLI `-32603` with a usable `data.details` string.
 * Must come AFTER A1 and A2 so their narrower matchers win.
 */
export const A3_GENERIC_RPC_DETAIL: CliErrorRecognizer = {
  id: "A3",
  match: (error) => {
    if (!isAcpRequestError(error)) return false;
    if (error.code !== -32603) return false;
    const details = readAcpDetails(error);
    return details !== undefined && details.trim().length > 0;
  },
  decide: (error) => ({
    id: "A3",
    surface: "B",
    text: `⚠️ Cli вернул ошибку: ${truncateDetails(readAcpDetails(error)!)}. Попробуйте отправить сообщение снова.`,
  }),
};

/** A4 — protocol-level errors (invalidParams / methodNotFound). */
export const A4_PROTOCOL: CliErrorRecognizer = {
  id: "A4",
  match: (error) => {
    if (!isAcpRequestError(error)) return false;
    return error.code === -32600 || error.code === -32601 || error.code === -32602;
  },
  decide: () => ({
    id: "A4",
    surface: "T",
    text: "Внутренняя ошибка протокола Cli. Подробности в журнале сервера.",
    killAcp: false,
    endTurn: true,
  }),
};

/** A5 — auth required. */
export const A5_AUTH_REQUIRED: CliErrorRecognizer = {
  id: "A5",
  match: (error) => isAcpRequestError(error) && error.code === -32000,
  decide: () => ({
    id: "A5",
    surface: "T+N",
    text: "Требуется авторизация Cli. Перезапустите приложение.",
    killAcp: false,
  }),
};

/** A6 — resource not found. */
export const A6_RESOURCE_NOT_FOUND: CliErrorRecognizer = {
  id: "A6",
  match: (error) => isAcpRequestError(error) && error.code === -32002,
  decide: () => ({
    id: "A6",
    surface: "T",
    text: "Ресурс Cli не найден. Отправьте сообщение, чтобы продолжить.",
    killAcp: false,
    endTurn: true,
  }),
};

// -----------------------------------------------------------------
// recognizers — B bucket (CLI process exits — sites #1/#2)
// -----------------------------------------------------------------

const FATAL_REASON_BY_EXIT_CODE: Record<number, string> = {
  41: "требуется авторизация",
  42: "неверные входные данные",
  44: "ошибка sandbox",
  52: "ошибка конфигурации",
  53: "достигнут лимит ходов",
  54: "ошибка инструмента",
};

const fatalText = (exitCode: number | undefined): string => {
  if (exitCode === 130) {
    return "Сессия Cli прервана. Отправьте сообщение, чтобы продолжить.";
  }
  const reason = exitCode !== undefined ? FATAL_REASON_BY_EXIT_CODE[exitCode] : undefined;
  if (reason !== undefined) {
    return `Сессия Cli завершилась: ${reason}. Отправьте сообщение, чтобы перезапустить сессию.`;
  }
  if (exitCode !== undefined) {
    return `Сессия Cli завершилась (код ${exitCode}). Отправьте сообщение, чтобы перезапустить сессию.`;
  }
  return "Процесс Cli завершился неожиданно. Отправьте сообщение, чтобы перезапустить сессию.";
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
      surface: "T+N",
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
    surface: "T+N",
    text: "Не удалось запустить процесс Cli. Проверьте установку (запустите `ru-fork` заново).",
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
    surface: "T+N",
    text: "Сбой протокола Cli: некорректный JSON. Отправьте сообщение, чтобы переподключиться.",
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
    surface: "T+N",
    text: "Соединение с Cli потеряно. Отправьте сообщение, чтобы переподключиться.",
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
// recognizers — D bucket (ru-fork-side validation / lookup)
// -----------------------------------------------------------------

/** D2 — adapter session not found. Specific text. Must come BEFORE D1/D3. */
export const D2_SESSION_NOT_FOUND: CliErrorRecognizer = {
  id: "D2",
  match: (error) => isProviderAdapterSessionNotFoundError(error),
  decide: () => ({
    id: "D2",
    surface: "T",
    text: "Сессия Cli не найдена. Отправьте сообщение, чтобы переподключиться.",
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
    surface: "T",
    text: "Внутренняя ошибка валидации запроса. Подробности в журнале сервера.",
    killAcp: true,
    endTurn: true,
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
    surface: "T",
    text: "Внутренняя ошибка провайдера. Подробности в журнале сервера.",
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
    surface: "T",
    text: "Произошла непредвиденная ошибка сервера. Подробности в журнале.",
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
    surface: "T+N",
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
export const classify = (error: unknown, cause: Cause.Cause<unknown>): CliErrorDecision | null => {
  for (const recognizer of RECOGNIZERS) {
    if (recognizer.match(error, cause)) {
      return recognizer.decide(error, cause);
    }
  }
  return null;
};

/**
 * Decision returned when no recognizer matched. Surfaces as T+N with
 * a generic Russian fallback; the dispatcher logs the failure's
 * message/details to the server console so it isn't lost. Promoting an
 * unrecognized failure to a named recognizer is then a code edit
 * driven by the `[cli-error.unrecognized]` log line.
 */
export const UNRECOGNIZED_DECISION: CliErrorDecision = {
  id: "unrecognized",
  surface: "T+N",
  text: "Произошла непредвиденная ошибка. Подробности в журнале сервера.",
  killAcp: false,
};
