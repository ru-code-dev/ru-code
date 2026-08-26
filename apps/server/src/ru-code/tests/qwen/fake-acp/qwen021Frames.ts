// @effect-diagnostics globalDate:off
/* oxlint-disable unicorn/no-useless-fallback-in-spread -- ru-code: `...(x ?? {})`
   is how qwen's own builders are written (transcript-replay.ts:183, :239, :267,
   :292, :316). This file is a 1:1 transcription whose value is that a reviewer
   can diff it against upstream line by line; "simplifying" the spread would be
   a divergence with no behavioural gain. */
// ru-code (agents wave, phase 2): a 1:1 TRANSCRIPTION of qwen 0.21.1's ACP
// emitters. Every builder below corresponds to exactly ONE qwen emit site and
// carries that site's `file:line` at tag v0.21.1 (commit 41b4ee8373). Nothing
// here is designed — where qwen spreads conditionally, we spread conditionally;
// where qwen assigns a key unconditionally (even to `undefined`), so do we;
// where qwen drops a field, we drop it. A behavioural difference between this
// file and qwen's own output is a BUG in this file, not a design choice.
//
// Why transcribe rather than hand-write fixtures: our v1 fixtures were written
// against qwen 0.13.1 by reading the wire, so they encode what we BELIEVED the
// shapes were. The 0.21.1 contract moved (subagent-tagged text/thought chunks,
// signal frames, a provenance stamp, renamed usage keys), and a hand-written
// fixture would encode the new belief just as silently. Transcribing the
// emitters makes every field traceable to a line a human can diff against
// upstream on the next bump.
//
// Companion mapping table (fixture field → builder line → contract § → qwen
// src line): WORKFLOW/wave-agents-mapping-table.md.
//
// qwen source root for every pin below:
//   /mnt/mac/Users/user/WORKSPACE/Projects/experements/qwen-code @ v0.21.1
import type * as AcpSchema from "effect-acp/schema";

/** qwen's `SubagentMeta` — session/types.ts:81-86. BOTH fields optional there. */
export interface QwenSubagentMeta {
  readonly parentToolCallId?: string;
  readonly subagentType?: string;
}

/** qwen's `UpdateMetaOptions` — acp-bridge/src/transcript-replay.ts:87-92. */
interface QwenUpdateMetaOptions {
  readonly timestamp?: string | number;
  readonly sourceRecordIds?: ReadonlyArray<string>;
  readonly planToolCallId?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * transcript-replay.ts:1327-1329. Empty strings filtered, order-preserving
 * dedupe, always a fresh array.
 */
const dedupeStrings = (values: ReadonlyArray<string>): string[] => [
  ...new Set(values.filter((value) => value.length > 0)),
];

/**
 * transcript-replay.ts:160-169. A non-finite/garbage timestamp becomes
 * `undefined` (`new Date("garbage").getTime()` is NaN), NOT 0.
 */
export const toTranscriptEpochMs = (timestamp?: string | number): number | undefined => {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof timestamp !== "string") return undefined;
  const epochMs = new Date(timestamp).getTime();
  return Number.isFinite(epochMs) ? epochMs : undefined;
};

/** transcript-replay.ts:1189-1196. All three conditions, in qwen's own order. */
const isTruncatedSessionDiffDisplay = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)["truncatedForSession"] === true &&
  "fileName" in (value as Record<string, unknown>) &&
  "newContent" in (value as Record<string, unknown>);

/** transcript-replay.ts:1315-1319. Numeric STRINGS are rejected, by design. */
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * transcript-replay.ts:171-188 — THE `_meta` assembler, and the single most
 * load-bearing fact in this file.
 *
 * `extra` is spread FLAT at the `_meta` root. There is no `_meta.extra` key,
 * ever: `_meta.usage`, `_meta.parentToolCallId`, `_meta.toolName` are all top
 * level. (`qwen-acp-contract-021.md` §1.6 claims `_meta.extra.usage` — that is
 * wrong; see the phase-2 report's corrections section.)
 *
 * Merge order, lowest → highest: `extra`, then `timestamp` (only when it
 * converts to a finite number), then `qwenTranscript` (only when non-empty).
 * Keys the function COMPUTES are dropped when absent; values inside `extra` are
 * kept verbatim INCLUDING an explicit `undefined` — `{...{a: undefined}}` makes
 * an own key `a`, and it counts toward the emptiness test below. That is why a
 * `subagentMeta` of `{parentToolCallId: undefined}` still produces a `_meta`.
 */
const buildUpdateMeta = (options: QwenUpdateMetaOptions): Record<string, unknown> | undefined => {
  const timestamp = toTranscriptEpochMs(options.timestamp);
  const sourceRecordIds = dedupeStrings(options.sourceRecordIds ?? []);
  const qwenTranscript = {
    ...(sourceRecordIds.length > 0 ? { sourceRecordIds } : {}),
    // Truthiness, not `!== undefined` — an empty string is dropped too
    // (transcript-replay.ts:178).
    ...(options.planToolCallId ? { planToolCallId: options.planToolCallId } : {}),
  };
  const meta: Record<string, unknown> = {
    ...(options.extra ?? {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(Object.keys(qwenTranscript).length > 0 ? { qwenTranscript } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
};

/**
 * tool-call-emitter.ts:264-283. `subagentMeta` present wins outright — note it
 * is an `!== undefined` check on the OBJECT, so an EMPTY `{}` still yields
 * `'subagent'`. A malformed `mcp__` name falls through to `'builtin'` rather
 * than stamping a garbage serverId.
 */
export const resolveToolProvenance = (
  toolName: string,
  subagentMeta?: QwenSubagentMeta,
): { provenance: "builtin" | "mcp" | "subagent"; serverId?: string } => {
  if (subagentMeta !== undefined) {
    return { provenance: "subagent" };
  }
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3 && parts[1] && parts[1].length > 0) {
      return { provenance: "mcp", serverId: parts[1] };
    }
  }
  return { provenance: "builtin" };
};

// ─── transcript-replay builders (the shared live/replay shape factory) ───────

/**
 * transcript-replay.ts:190-204. The role/thought pair selects the variant, so
 * ONE builder covers all three chunk kinds. `_meta` is CONDITIONAL here — an
 * untagged parent chunk carries no `_meta` key at all.
 */
export const createTranscriptMessageUpdate = (
  options: {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly thought?: boolean;
  } & QwenUpdateMetaOptions,
): AcpSchema.SessionUpdate => {
  const meta = buildUpdateMeta(options);
  return {
    sessionUpdate:
      options.role === "user"
        ? "user_message_chunk"
        : options.thought
          ? "agent_thought_chunk"
          : "agent_message_chunk",
    content: { type: "text", text: options.text },
    ...(meta ? { _meta: meta } : {}),
  } as AcpSchema.SessionUpdate;
};

/**
 * transcript-replay.ts:220-246. Note the KEY RENAMES from the genai metadata
 * (`promptTokenCount`→`inputTokens`, `candidatesTokenCount`→`outputTokens`,
 * `totalTokenCount`→`totalTokens`, `thoughtsTokenCount`→`thoughtTokens`,
 * `cachedContentTokenCount`→`cachedReadTokens`) — `cachedReadTokens`, NOT
 * `cachedTokens`; the `cachedTokens` spelling belongs to a DIFFERENT structure
 * (the Agent tool's `rawOutput.executionSummary`), so the two must not be
 * conflated. The first three keys are always present (`?? 0`); the last two are
 * conditional on finiteness. `_meta` is assigned UNCONDITIONALLY here (:244),
 * unlike the message builder.
 */
export const createTranscriptUsageUpdate = (
  usageMetadata: {
    readonly promptTokenCount?: unknown;
    readonly candidatesTokenCount?: unknown;
    readonly totalTokenCount?: unknown;
    readonly thoughtsTokenCount?: unknown;
    readonly cachedContentTokenCount?: unknown;
  },
  options: { readonly text?: string } & QwenUpdateMetaOptions = {},
): AcpSchema.SessionUpdate => {
  const usage = {
    inputTokens: finiteNumber(usageMetadata.promptTokenCount) ?? 0,
    outputTokens: finiteNumber(usageMetadata.candidatesTokenCount) ?? 0,
    totalTokens: finiteNumber(usageMetadata.totalTokenCount) ?? 0,
    ...(finiteNumber(usageMetadata.thoughtsTokenCount) !== undefined
      ? { thoughtTokens: finiteNumber(usageMetadata.thoughtsTokenCount) }
      : {}),
    ...(finiteNumber(usageMetadata.cachedContentTokenCount) !== undefined
      ? { cachedReadTokens: finiteNumber(usageMetadata.cachedContentTokenCount) }
      : {}),
  };
  // `usage` FIRST, so a caller's own `extra.usage` overrides it (:239).
  const meta = buildUpdateMeta({ ...options, extra: { usage, ...(options.extra ?? {}) } });
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: options.text ?? "" },
    _meta: meta,
  } as AcpSchema.SessionUpdate;
};

/**
 * transcript-replay.ts:248-271. Every top-level field is unconditional:
 * `content` is always the literal `[]`, `locations` is always a fresh copy,
 * `rawInput` falls back to `{}`. `asUpdate` flips the variant to
 * `tool_call_update` — a real branch, used when a `phase:"preparing"` frame is
 * being upgraded to a real call (tool-call-emitter.ts:100-102).
 *
 * The caller's `extra` is spread LAST (:267), so a caller-supplied
 * `provenance` OVERRIDES this builder's own `resolveToolProvenance(toolName)`
 * — which is exactly what tool-call-emitter does, and the only reason a
 * subagent frame reads `provenance:"subagent"` rather than `"builtin"`.
 */
export const createTranscriptToolCallStartUpdate = (
  options: {
    readonly toolName: string;
    readonly callId: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
    readonly args?: Record<string, unknown>;
    readonly metadata: {
      readonly title: string;
      readonly locations: ReadonlyArray<{ readonly path: string; readonly line: number | null }>;
      readonly kind: AcpSchema.ToolKind;
    };
    readonly asUpdate?: boolean;
  } & QwenUpdateMetaOptions,
): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(options.toolName);
  return {
    sessionUpdate: options.asUpdate ? "tool_call_update" : "tool_call",
    toolCallId: options.callId,
    status: options.status ?? "pending",
    title: options.metadata.title,
    content: [],
    locations: [...options.metadata.locations],
    kind: options.metadata.kind,
    rawInput: options.args ?? {},
    _meta: buildUpdateMeta({
      ...options,
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        ...(options.extra ?? {}),
      },
    }),
  } as AcpSchema.SessionUpdate;
};

/**
 * transcript-replay.ts:273-303. `rawOutput` is added by MUTATION (:300), not a
 * spread, so it is the LAST key in insertion order — after `_meta`. It is
 * present whenever `resultDisplay !== undefined` (note `null` passes) and the
 * display is not a truncated session diff. This is the frame the Agent tool's
 * own completion rides, carrying `AgentResultDisplay` as `rawOutput`.
 */
export const createTranscriptToolCallResultUpdate = (
  options: {
    readonly toolName: string;
    readonly callId: string;
    readonly success: boolean;
    readonly content?: ReadonlyArray<unknown>;
    readonly resultDisplay?: unknown;
    readonly artifacts?: ReadonlyArray<unknown>;
  } & QwenUpdateMetaOptions,
): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(options.toolName);
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId: options.callId,
    status: options.success ? "completed" : "failed",
    content: options.content ?? [],
    _meta: buildUpdateMeta({
      ...options,
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        ...(options.artifacts && options.artifacts.length > 0
          ? { artifacts: options.artifacts }
          : {}),
        ...(options.extra ?? {}),
      },
    }),
  };
  // ru-code (phase 4, f-6): a CONJUNCTION upstream (`TR:296-299`) — the builder
  // previously implemented only the first half while its own doc claimed both.
  // A truncated session diff is suppressed from `rawOutput` and surfaced as a
  // preview in `content` instead (`TR:1163-1170`), so a child's large-diff edit
  // would otherwise carry a `rawOutput` qwen never sends.
  if (
    options.resultDisplay !== undefined &&
    !isTruncatedSessionDiffDisplay(options.resultDisplay)
  ) {
    update["rawOutput"] = options.resultDisplay;
  }
  return update as unknown as AcpSchema.SessionUpdate;
};

/**
 * transcript-replay.ts:305-326. `priority` is ALWAYS the literal `"medium"`,
 * and the todo's `id` is DROPPED — it never reaches the entry. `_meta` is
 * conditional, so a plan with no cumulative-usage snapshot carries none.
 */
export const createTranscriptPlanUpdate = (
  todos: ReadonlyArray<{ readonly content: string; readonly status: string }>,
  cumulativeUsage?: Readonly<Record<string, number>>,
  options: QwenUpdateMetaOptions = {},
): AcpSchema.SessionUpdate => {
  const meta = buildUpdateMeta({
    ...options,
    extra: {
      ...(cumulativeUsage ? { stats: { ...cumulativeUsage } } : {}),
      ...(options.extra ?? {}),
    },
  });
  return {
    sessionUpdate: "plan",
    entries: todos.map((todo) => ({
      content: todo.content,
      priority: "medium" as const,
      status: todo.status,
    })),
    ...(meta ? { _meta: meta } : {}),
  } as AcpSchema.SessionUpdate;
};

// ─── the EMIT SITES (what actually calls the builders above) ─────────────────
//
// Below, one function per qwen emit site. The split matters: the builders above
// are shared by live emission AND `session/load` history replay, while the
// sites below are the live paths a sub-agent actually drives. Anything a
// sub-agent CANNOT reach is marked N/A with the reason, so the set is
// branch-complete rather than merely sufficient.

/** MessageEmitter.ts:137-150 (`emitAgentMessage`). */
export const qwenEmitAgentMessage = (
  text: string,
  timestamp?: string | number,
  subagentMeta?: QwenSubagentMeta,
): AcpSchema.SessionUpdate =>
  createTranscriptMessageUpdate({
    role: "assistant",
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(subagentMeta ? { extra: { ...subagentMeta } } : {}),
  });

/** MessageEmitter.ts:115-129 (`emitAgentThought`). */
export const qwenEmitAgentThought = (
  text: string,
  timestamp?: string | number,
  subagentMeta?: QwenSubagentMeta,
): AcpSchema.SessionUpdate =>
  createTranscriptMessageUpdate({
    role: "assistant",
    thought: true,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(subagentMeta ? { extra: { ...subagentMeta } } : {}),
  });

/**
 * MessageEmitter.ts:94-107 (`emitUserMessage`).
 * N/A for sub-agents: `emitMessage` routes `role:"user"` here WITHOUT passing
 * `subagentMeta` (MessageEmitter.ts:256), and SubAgentTracker only ever emits
 * `'assistant'` (SubAgentTracker.ts:306). Transcribed for completeness because
 * `session/load` replay drives it.
 */
export const qwenEmitUserMessage = (
  text: string,
  timestamp?: string | number,
  source?: string,
): AcpSchema.SessionUpdate =>
  createTranscriptMessageUpdate({
    role: "user",
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(source ? { extra: { source } } : {}),
  });

/**
 * MessageEmitter.ts:170-237 (`emitUsageMetadata`), the `sendUpdate` call at
 * :227-236. `durationMs` present ⇒ a LIVE model round, which is also what gates
 * the drained `apiErrors`/`apiRetries` counters onto this frame (:219-225);
 * replay frames omit it. SubAgentTracker always passes text `''`
 * (SubAgentTracker.ts:285), which is why a child's usage arrives as a dedicated
 * EMPTY-text `agent_message_chunk`.
 */
export const qwenEmitUsageMetadata = (input: {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly cachedContentTokenCount?: number;
  readonly text?: string;
  readonly durationMs?: number;
  readonly apiErrors?: number;
  readonly apiRetries?: number;
  readonly subagentMeta?: QwenSubagentMeta;
}): AcpSchema.SessionUpdate =>
  createTranscriptUsageUpdate(input, {
    text: input.text ?? "",
    extra: {
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(input.apiErrors !== undefined && input.apiErrors > 0
        ? { apiErrors: input.apiErrors }
        : {}),
      ...(input.apiRetries !== undefined && input.apiRetries > 0
        ? { apiRetries: input.apiRetries }
        : {}),
      ...input.subagentMeta,
    },
  });

/**
 * MessageEmitter.ts:37-64 (`emitStopHookLoop`). A SIGNAL FRAME: an empty-text
 * `agent_message_chunk` whose entire payload is `_meta`. Built by hand in qwen
 * — it does NOT go through `createTranscriptMessageUpdate`, so it carries no
 * `timestamp` and no `qwenTranscript`. Session-scoped: no `subagentMeta`
 * parameter exists, and SubAgentTracker never calls it.
 */
export const qwenEmitStopHookLoop = (input: {
  readonly iterationCount: number;
  readonly reasons: ReadonlyArray<string>;
  readonly stopHookCount: number;
  readonly goal?: {
    readonly condition: string;
    readonly iterations: number;
    readonly setAt?: number;
    readonly lastReason?: string;
  };
}): AcpSchema.SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
    _meta: {
      stopHookLoop: {
        iterationCount: input.iterationCount,
        reasons: input.reasons,
        stopHookCount: input.stopHookCount,
        ...(input.goal ? { goal: input.goal } : {}),
      },
    },
  }) as AcpSchema.SessionUpdate;

/** MessageEmitter.ts:66-74 (`emitGoalTerminal`). Signal frame; session-scoped. */
export const qwenEmitGoalTerminal = (event: {
  readonly kind: "achieved" | "aborted" | "failed";
  readonly condition: string;
  readonly iterations: number;
  readonly durationMs: number;
  readonly lastReason?: string;
  readonly systemMessage?: string;
}): AcpSchema.SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
    _meta: { goalTerminal: event },
  }) as AcpSchema.SessionUpdate;

/** MessageEmitter.ts:76-86 (`emitGoalStatus`). Signal frame; session-scoped. */
export const qwenEmitGoalStatus = (status: {
  readonly kind: "set" | "achieved" | "cleared" | "failed" | "aborted" | "checking";
  readonly condition: string;
  readonly iterations?: number;
  readonly setAt?: number;
  readonly durationMs?: number;
  readonly lastReason?: string;
}): AcpSchema.SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
    _meta: { goalStatus: status },
  }) as AcpSchema.SessionUpdate;

/**
 * MessageEmitter.ts:152-165 (`emitSlashCommandOutput`). Hand-built like the
 * signal frames, but with NON-empty text and `_meta.source:"slash_command"`.
 * Its timestamp is converted with the same epoch-ms helper (:156).
 */
export const qwenEmitSlashCommandOutput = (
  text: string,
  timestamp?: string | number,
): AcpSchema.SessionUpdate => {
  const epochMs = toTranscriptEpochMs(timestamp);
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: {
      source: "slash_command",
      ...(epochMs != null ? { timestamp: epochMs } : {}),
    },
  } as AcpSchema.SessionUpdate;
};

/**
 * tool-call-emitter.ts:80-126 (`emitStart`), the `sendUpdate` at :104-120.
 * Branches NOT reachable here and why:
 *   · TodoWrite (:82-84) → returns false, emits NOTHING (its plan rides
 *     `emitResult` instead — see `qwenEmitPlan`);
 *   · `phase:"preparing"` dedupe (:85-90) → a repeat preparing frame is
 *     swallowed. Sub-agent calls never carry a phase at all: the preparation
 *     tracker is wired only to Session.ts's top-level model-stream path
 *     (contract doc §2.4), so `phase` is always absent for a child.
 */
export const qwenEmitToolCallStart = (input: {
  readonly toolName: string;
  readonly callId: string;
  readonly status?: "pending" | "in_progress" | "completed" | "failed";
  readonly args?: Record<string, unknown>;
  readonly title: string;
  readonly locations?: ReadonlyArray<{ readonly path: string; readonly line: number | null }>;
  readonly kind?: AcpSchema.ToolKind;
  readonly timestamp?: string | number;
  readonly phase?: "preparing";
  readonly asUpdate?: boolean;
  readonly subagentMeta?: QwenSubagentMeta;
}): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(input.toolName, input.subagentMeta);
  return createTranscriptToolCallStartUpdate({
    toolName: input.toolName,
    callId: input.callId,
    status: input.status ?? "pending",
    ...(input.args ? { args: input.args } : {}),
    metadata: {
      title: input.title,
      locations: input.locations ?? [],
      // KIND_MAP (tool-call-emitter.ts:34-52) maps the internal Kind.Agent to
      // ACP `"other"` — ACP defines no `"agent"` ToolKind, so the Agent tool's
      // own frame is indistinguishable by `kind` and only `_meta` identifies it.
      kind: input.kind ?? "other",
    },
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.asUpdate !== undefined ? { asUpdate: input.asUpdate } : {}),
    extra: {
      ...(input.phase ? { phase: input.phase } : {}),
      ...input.subagentMeta,
      provenance: provenance.provenance,
      ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
    },
  });
};

/**
 * ru-code (agentic-flow wave, FIX ROUND 2): THE PREPARING FRAME — the REAL first
 * frame of a top-level tool call, and the one every fixture in this wave was
 * missing.
 *
 * `tool-call-preparation-tracker.ts:29-51` (`observe`) fires as soon as the
 * model's STREAM reveals a function call, long before its arguments have been
 * parsed, and calls `emitStart` with:
 *   · `args: {}`            (`:41` — literally the empty object)
 *   · `status: 'pending'`   (`:42`)
 *   · `phase: 'preparing'`  (`:43`)
 *
 * `emitStart` then resolves the frame's display metadata from those EMPTY args
 * (tool-call-emitter.ts:92-95 → `resolveToolMetadata`, `:316-361`): the tool is
 * found, so `title = tool.displayName` (`:334`), `tool.build({})` THROWS —
 * `validateToolParams` rejects a missing `description` (agent.ts:1022-1026) — and
 * the catch arm (`:349-357`) leaves the title at the bare display name because
 * `args['description']` is not a string (`:351`). For the Agent tool that is
 * `ToolDisplayNames.AGENT` = `'Agent'` (tool-names.ts:89), and the kind is
 * `KIND_MAP[Kind.Agent]` = `'other'` (tool-call-emitter.ts:50).
 *
 * WHY IT IS LOAD-BEARING: this frame carries NO `description` and NO
 * `subagent_type`, so a host that opens an agent row from it opens a row it
 * cannot name — `asString(payload.title) ?? asString(payload.detail) ?? id`
 * (subagentRuntime.ts:362) then names the card after its own `call_…` id, which
 * is exactly what the owner saw. It is also DISCARDABLE
 * (`emitPreparationDiscarded`, tool-call-emitter.ts:135-156): a call that never
 * executes still produced this frame.
 */
export const qwenEmitAgentPreparingStart = (callId: string): AcpSchema.SessionUpdate =>
  qwenEmitToolCallStart({
    toolName: "agent",
    callId,
    status: "pending",
    args: {},
    title: "Agent",
    kind: "other",
    phase: "preparing",
  });

/**
 * tool-call-emitter.ts:164-205 (`emitResult`), the `sendUpdate` at :187-204.
 * The TodoWrite branch (:166-180) does NOT reach here — see `qwenEmitPlan`.
 */
export const qwenEmitToolCallResult = (input: {
  readonly toolName: string;
  readonly callId: string;
  readonly success: boolean;
  readonly content?: ReadonlyArray<unknown>;
  readonly resultDisplay?: unknown;
  readonly artifacts?: ReadonlyArray<unknown>;
  readonly timestamp?: string | number;
  readonly subagentMeta?: QwenSubagentMeta;
}): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(input.toolName, input.subagentMeta);
  return createTranscriptToolCallResultUpdate({
    toolName: input.toolName,
    callId: input.callId,
    success: input.success,
    ...(input.content ? { content: input.content } : {}),
    ...(input.resultDisplay !== undefined ? { resultDisplay: input.resultDisplay } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    extra: {
      ...input.subagentMeta,
      provenance: provenance.provenance,
      ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
    },
  });
};

/**
 * PlanEmitter.ts:27-39 (`emitPlan`) — reached for a CHILD only via
 * `ToolCallEmitter.emitResult`'s TodoWrite branch (tool-call-emitter.ts:166-180).
 *
 * THE GAP THAT SURVIVED 0.21.1: `emitPlan(todos)` takes no `subagentMeta` and
 * passes none to `createTranscriptPlanUpdate`, so a sub-agent's todo list still
 * reaches the wire COMPLETELY UNTAGGED — exactly as at 0.13.1. Tag-keyed
 * demultiplexing therefore cannot attribute a child plan; only the open-window
 * heuristic can. Pinned by the phase-2 red matrix.
 */
export const qwenEmitPlan = (
  todos: ReadonlyArray<{ readonly content: string; readonly status: string }>,
  cumulativeUsage?: Readonly<Record<string, number>>,
): AcpSchema.SessionUpdate => createTranscriptPlanUpdate(todos, cumulativeUsage);

/**
 * tool-call-emitter.ts:135-156 (`emitPreparationDiscarded`). Hand-built, NOT
 * via the transcript builder. N/A for sub-agents: the signature accepts no
 * `subagentMeta` (:135-138) and the preparing phase is top-level-only, but it
 * is transcribed because it is a real `tool_call_update` shape our classifier
 * will meet on the parent's stream.
 */
export const qwenEmitPreparationDiscarded = (
  callId: string,
  toolName: string,
): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(toolName);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status: "failed",
    content: [],
    _meta: {
      toolName,
      phase: "preparing",
      preparationDiscarded: true,
      provenance: provenance.provenance,
      ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
    },
  } as AcpSchema.SessionUpdate;
};

/**
 * tool-call-emitter.ts:216-240 (`emitError`). Accepts `subagentMeta`, but
 * SubAgentTracker never calls it — a child's failure arrives through
 * `emitResult` with `success:false` instead (SubAgentTracker.ts:165-173).
 * Transcribed so the branch is documented rather than silently missing.
 */
export const qwenEmitToolCallError = (
  callId: string,
  toolName: string,
  errorMessage: string,
  subagentMeta?: QwenSubagentMeta,
): AcpSchema.SessionUpdate => {
  const provenance = resolveToolProvenance(toolName, subagentMeta);
  return createTranscriptToolCallResultUpdate({
    toolName,
    callId,
    success: false,
    // ru-code (agentic-flow wave, FIX ROUND 3 ADDENDUM): the error message is
    // the ONE field this builder exists to carry, and it used to be DROPPED —
    // the line here was `...(errorMessage ? {} : {})`, a spread of an empty
    // object either way. Upstream `emitError` passes `errorMessage: error.message`
    // to the result builder (tool-call-emitter.ts:232), and `buildToolResultContent`
    // turns it into the frame's ONLY content entry when there is no diff
    // (transcript-replay.ts:1112-1119). `createTranscriptToolCallResultUpdate`
    // models content as caller-supplied (it does not transcribe the errorMessage
    // branch), so the transcription is applied here, at the one call site that
    // has an errorMessage.
    ...(errorMessage
      ? { content: [{ type: "content", content: { type: "text", text: errorMessage } }] }
      : {}),
    extra: {
      ...subagentMeta,
      provenance: provenance.provenance,
      ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
    },
  });
};

/**
 * ru-code (agentic-flow wave, FIX ROUND 3): qwen's `toPermissionOptions` for an
 * `info` confirmation — permissionUtils.ts:200-227 plus `basicPermissionOptions`
 * (`:17-28`). The Agent tool has no `getConfirmationDetails` override, so it
 * takes the base class's generic `info` dialog (tools.ts:126-140) and therefore
 * exactly these four options, in this order. Every `optionId` is a
 * `ToolConfirmationOutcome` value (tools.ts:947-963); `filterAlwaysAllowOptions`
 * (`:39-67`) drops neither, because an `info` confirmation built by the base
 * class sets neither `autoModeFallback` nor `hideAlwaysAllow`.
 */
export const QWEN_INFO_PERMISSION_OPTIONS: ReadonlyArray<AcpSchema.PermissionOption> = [
  { optionId: "proceed_always_project", name: "Always Allow in project", kind: "allow_always" },
  { optionId: "proceed_always_user", name: "Always Allow for user", kind: "allow_always" },
  { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
  { optionId: "cancel", name: "Reject", kind: "reject_once" },
] as ReadonlyArray<AcpSchema.PermissionOption>;

/**
 * ru-code (agentic-flow wave, FIX ROUND 3): THE DEFAULT-MODE SPAWN FRAME —
 * Session.ts:7677-7697, the TOP-LEVEL permission REQUEST (an RPC, not a
 * `session/update`).
 *
 * THE SELECTOR AXIS THIS FILE WAS MISSING (approval mode). `AgentTool` overrides
 * `getDefaultPermission()` to `'ask'` (agent.ts:1566-1568), so `needsConfirmation`
 * is true in every non-YOLO mode (permissionFlow.ts:125-144) and `resolveQwenMode`
 * never asks for yolo (QwenAdapter.ts:813-822). On ru-code's DEFAULT runtime mode
 * a spawn therefore rides THIS frame, and `Session.ts:7861-7871`'s
 * `if (!didRequestPermission && !isTodoWriteTool)` SKIPS `emitStart` — the
 * args-bearing `tool_call` frame the other fixtures model does not exist here.
 * (In AUTO_EDIT the branch at `Session.ts:7621-7628` auto-approves an `info`
 * confirmation with `didRequestPermission` still false, which is why that wire
 * has the args frame and this one does not.)
 *
 * Every byte:
 *   · `title` = `invocation.getDescription()` (`:7683`) = `params.description`
 *     verbatim (agent.ts:1554-1556) — NOT `Agent: <description>`. That is the one
 *     byte separating this producer from the nested one below, whose title comes
 *     from `resolveToolMetadata` (`Agent` + `': '` + the description,
 *     tool-call-emitter.ts:334/:341);
 *   · `content` = `buildPermissionRequestContent` (`:7653`), which for an `info`
 *     confirmation with no `autoModeFallback` returns `[]` (permissionUtils.ts:103-149);
 *   · `locations` = `invocation.toolLocations()` (`:7685`) = `[]` (the base class's
 *     default, tools.ts:102-104 — `AgentToolInvocation` does not override it);
 *   · `kind` = `mapToolKind(tool.kind)` (`:7656`) = `KIND_MAP[Kind.Agent]` =
 *     `'other'` (tool-call-emitter.ts:50);
 *   · `rawInput` = the spawn args verbatim (`:7687`);
 *   · `_meta.toolName` (`:7692-7695`) — `interactionMetaFields` adds nothing for
 *     an `info` confirmation (permissionUtils.ts:92-101).
 *
 * `_meta` on a TOP-LEVEL permission request is NEW at 0.21.1: v0.13.1's
 * `Session.ts:782-793` (`git show v0.13.1:…/Session.ts`) builds the same struct
 * with no `_meta` key at all. It is therefore the same class of engine-generation
 * proof as `provenance`, one frame earlier on this wire.
 */
export const qwenAgentSpawnPermissionRequest = (input: {
  readonly sessionId: string;
  readonly callId: string;
  readonly args: Record<string, unknown>;
}): AcpSchema.RequestPermissionRequest =>
  ({
    sessionId: input.sessionId,
    options: [...QWEN_INFO_PERMISSION_OPTIONS],
    toolCall: {
      toolCallId: input.callId,
      status: "pending",
      title: input.args["description"],
      content: [],
      locations: [],
      kind: "other",
      rawInput: input.args,
      _meta: { toolName: "agent" },
    },
  }) as AcpSchema.RequestPermissionRequest;

/**
 * SubAgentTracker.ts:207-228 — the nested permission REQUEST (an RPC, not a
 * `session/update`).
 *
 * NOTE THE ABSENCE: `_meta` carries `toolName` plus `interactionMetaFields(...)`
 * and NOTHING ELSE — no `parentToolCallId`, no `subagentType`, no `provenance`.
 * A child's permission request is therefore UNATTRIBUTABLE by tag at 0.21.1,
 * which is precisely why our adapter marks the row waiting off the open window
 * (QwenAdapter.ts:1786-1791). Pinned by the phase-1 baseline and re-pinned in
 * the v2 matrix.
 */
export const qwenSubAgentPermissionRequest = (input: {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly title: string;
  readonly args?: Record<string, unknown>;
  readonly locations?: ReadonlyArray<{ readonly path: string; readonly line: number | null }>;
  readonly kind?: AcpSchema.ToolKind;
  readonly options: ReadonlyArray<AcpSchema.PermissionOption>;
  // ru-code (phase 4, f-7): the `ask_user_question` confirmation shape, which is
  // the ONLY branch `interactionMetaFields` stamps anything for.
  readonly questions?: ReadonlyArray<Record<string, unknown>>;
  /** Pre-built permission content (`buildPermissionRequestContent`, SAT:214). */
  readonly content?: ReadonlyArray<unknown>;
}): AcpSchema.RequestPermissionRequest =>
  ({
    sessionId: input.sessionId,
    options: [...input.options],
    toolCall: {
      toolCallId: input.callId,
      status: "pending",
      title: input.title,
      // SAT:214 — `buildPermissionRequestContent(fullConfirmationDetails)`, NOT a
      // literal []. Modelled as caller-supplied for the same reason the result
      // builder's content is (mapping §1a): deriving it needs the confirmation
      // union we do not transcribe.
      content: [...(input.content ?? [])],
      locations: [...(input.locations ?? [])],
      kind: input.kind ?? "other",
      rawInput: input.args,
      // SAT:223-226 — `{ toolName, ...interactionMetaFields(confirmation) }`.
      // `interactionMetaFields` (permissionUtils.ts:92-101) adds exactly two keys
      // and ONLY for `type === "ask_user_question"`; every other confirmation
      // yields `{}`. NONE of them is an attribution tag, so the mapping table's
      // "untagged" conclusion is unchanged — but the fixture can now reproduce a
      // child's ask_user_question, which the table claims it can.
      _meta: {
        toolName: input.toolName,
        ...(input.questions
          ? { qwenInteractionKind: "user_question", qwenQuestions: input.questions }
          : {}),
      },
    },
  }) as AcpSchema.RequestPermissionRequest;
