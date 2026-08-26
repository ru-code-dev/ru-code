import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  MessageId, // ru-code (mid-turn wave, P3c)
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
  // ru-code: generic — overlay this settings file onto the spawned CLI's own
  // config at highest precedence (delivered as CLI_ENV.SYSTEM_SETTINGS_PATH, branding
  // cliEnv.ts).
  // Any feature that needs to inject CLI settings can reuse this; the producer
  // owns the file's meaning. Independent of `allowedMcpServers`.
  settingsOverlayPath: Schema.optional(TrimmedNonEmptyString),
  // ru-code: MCP server allowlist forwarded to the CLI (delivered as
  // CLI_ARGS.ALLOWED_MCP_SERVERS, branding cliEnv.ts). Named for what it is rather than
  // masked under a generic key. Independent of `settingsOverlayPath`. Plain strings —
  // these are opaque server names the producer owns, not validated identifiers here.
  allowedMcpServers: Schema.optional(Schema.Array(Schema.String)),
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  // ru-code: the thread's live runtime mode for this turn. Lets a capable adapter
  // (qwen advertises supportsInSessionRuntimeMode) apply a mode change via per-turn
  // setMode instead of a session respawn. Populated by the reactor for every provider;
  // adapters that respawn on mode change simply ignore it. Optional ⇒ additive, no
  // existing caller/adapter breaks.
  runtimeMode: Schema.optional(RuntimeMode),
  // ru-code (mid-turn wave, P3c): the orchestration message id this turn's text
  // came from. Needed ONLY by the mid-turn queue: when a send arrives while a
  // turn is running it is queued rather than dispatched, and the adapter must
  // later be able to say WHICH message row was delivered (or reset). Without
  // this the adapter holds text with no addressable identity and no mark can
  // ever be attached.
  //
  // Optional ⇒ additive, no existing caller/adapter breaks — same contract as
  // `runtimeMode` directly above, added for the same reason.
  messageId: Schema.optional(MessageId),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

// ru-code: hidden context compaction on the thread's live session.
export const ProviderCompactContextInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderCompactContextInput = typeof ProviderCompactContextInput.Type;

// ru-code (agentic-flow wave): stop ONE background agent task on a thread's
// live provider session. `taskId` is the provider's own task id — for qwen the
// immutable `<subagentType>-<callId>` string its registry, poll snapshot and
// cancel ext-method all share.
export const ProviderStopBackgroundTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type ProviderStopBackgroundTaskInput = typeof ProviderStopBackgroundTaskInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
