// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// ru-code (agents wave, phase 2): a 1:1 TRANSCRIPTION of qwen 0.21.1's
// per-subagent JSONL transcript tree — the surface that did NOT exist at
// v0.13.1 (proven: `git ls-tree -r v0.13.1 -- packages/core/src/agents/` lists
// only arena/, backends/, runtime/ and index.ts; `agent-transcript.ts` appears
// only at v0.21.1).
//
// Why our fake needs it at all: the extended chat view tails qwen's JSONL
// rather than the ACP wire, so a sub-agent run that is correct on the wire can
// still be invisible (or wrong) in the extended view. The main transcript
// carries only a rolled-up `task_execution` tool_result for a child run; the
// per-turn child detail lives ONLY in this tree.
//
// Every pin below is `packages/core/src/agents/agent-transcript.ts` at tag
// v0.21.1 (commit 41b4ee8373) unless stated otherwise.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** agent-transcript.ts:48-50. One `_` per offending char — no collapsing. */
export const sanitizeFilenameComponent = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");

/** agent-transcript.ts:52-55. `projectDir` itself is NOT sanitized. */
export const getSubagentsRootDir = (projectDir: string): string =>
  NodePath.join(projectDir, "subagents");

/** agent-transcript.ts:66-76. */
export const getSubagentSessionDir = (projectDir: string, sessionId: string): string =>
  NodePath.join(getSubagentsRootDir(projectDir), sanitizeFilenameComponent(sessionId));

/**
 * agent-transcript.ts:78-88. The `agent-` prefix is UNCONDITIONAL and applied
 * after sanitizing the id, so an agentId that already starts with `agent-`
 * doubles up — reproduced deliberately.
 */
export const getAgentJsonlPath = (projectDir: string, sessionId: string, agentId: string): string =>
  NodePath.join(
    getSubagentSessionDir(projectDir, sessionId),
    `agent-${sanitizeFilenameComponent(agentId)}.jsonl`,
  );

/** agent-transcript.ts:90-100. */
export const getAgentMetaPath = (projectDir: string, sessionId: string, agentId: string): string =>
  NodePath.join(
    getSubagentSessionDir(projectDir, sessionId),
    `agent-${sanitizeFilenameComponent(agentId)}.meta.json`,
  );

/** agent-transcript.ts:360 — derived by concatenation; qwen exports no helper. */
export const getAgentStreamPath = (jsonlPath: string): string => `${jsonlPath}.stream`;

/** agent-transcript.ts:102-151. `undefined` values vanish via JSON.stringify. */
export interface QwenAgentMeta {
  readonly agentId: string;
  readonly agentType: string;
  readonly description: string;
  readonly parentSessionId: string;
  readonly toolUseId?: string;
  readonly parentAgentId: string | null;
  readonly createdAt: string;
  readonly status?: "running" | "completed" | "failed" | "cancelled" | "paused";
  readonly isBackgrounded?: boolean;
  readonly isolation?: "worktree";
  readonly lastUpdatedAt?: string;
  readonly subagentName?: string;
  readonly agentColor?: string;
  readonly resumeCount?: number;
  readonly depth?: number;
  readonly model?: string;
  readonly lastError?: string;
}

export interface QwenAgentTranscriptOptions {
  readonly projectDir: string;
  /** The PARENT user-session uuid — stamped on every record (:286, :393). */
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly version: string;
  readonly agentName?: string;
  readonly agentColor?: string;
  readonly gitBranch?: string;
}

/**
 * One writer per agent id, mirroring qwen's own `attachAgentJsonlWriter`.
 *
 * Deliberate reproductions of qwen's behaviour, each of which a "cleaner" fake
 * would get wrong:
 *   · the fd opens LAZILY on first write (:376-388), so an agent that never
 *     emits a record leaves NO FILE AT ALL;
 *   · records are append-only, `JSON.stringify(record) + "\n"` (:405-413) —
 *     compact, LF, UTF-8, terminator on every line including the last;
 *   · `parentUuid` forms a strictly linear chain that advances ONLY on a
 *     successful write (:409);
 *   · there is NO finish/summary record — qwen has no FINISH listener at all;
 *     completion is recorded by patching `.meta.json` instead. Inventing a
 *     terminal record here would let a spec pass against a shape qwen never
 *     writes.
 */
export class QwenAgentTranscriptWriter {
  private readonly jsonlPath: string;
  private readonly metaPath: string;
  private lastUuid: string | null = null;
  private uuidSeq = 0;
  private readonly runId: string;
  private opened = false;
  private readonly options: QwenAgentTranscriptOptions;

  constructor(options: QwenAgentTranscriptOptions) {
    this.options = options;
    this.jsonlPath = getAgentJsonlPath(options.projectDir, options.sessionId, options.agentId);
    this.metaPath = getAgentMetaPath(options.projectDir, options.sessionId, options.agentId);
    // Deterministic instead of randomUUID(): a test that pins bytes must not
    // race a random. Shape (a v4-looking string) is what consumers parse.
    this.runId = `run-${sanitizeFilenameComponent(options.agentId)}`;
  }

  get paths(): { readonly jsonl: string; readonly meta: string } {
    return { jsonl: this.jsonlPath, meta: this.metaPath };
  }

  /**
   * agent-transcript.ts:390-403. Key ORDER is load-bearing: JSON.stringify
   * emits insertion order, and readers (and byte-comparing specs) see these 12
   * keys first, in exactly this sequence, before any per-type extras.
   */
  private baseFields(
    type: "user" | "assistant" | "tool_result" | "system",
  ): Record<string, unknown> {
    this.uuidSeq += 1;
    const uuid = `${sanitizeFilenameComponent(this.options.agentId)}-${this.uuidSeq}`;
    return {
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.options.sessionId,
      timestamp: new Date().toISOString(),
      type,
      cwd: this.options.cwd,
      version: this.options.version,
      gitBranch: this.options.gitBranch,
      agentId: this.options.agentId,
      agentName: this.options.agentName,
      agentColor: this.options.agentColor,
      isSidechain: true,
    };
  }

  private append(record: Record<string, unknown>): void {
    if (!this.opened) {
      NodeFS.mkdirSync(NodePath.dirname(this.jsonlPath), { recursive: true });
      this.opened = true;
    }
    NodeFS.appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`);
    this.lastUuid = record["uuid"] as string;
  }

  /**
   * agent-transcript.ts:562-564. For a NON-fork agent this is the file's first
   * line, written before the model has produced anything — qwen's own readers
   * depend on that (`transcripts.ts:14-19` treats the first `user` record as
   * the launch prompt).
   */
  writeLaunchPrompt(text: string): void {
    this.append({
      ...this.baseFields("user"),
      message: { role: "user", parts: [{ text }] },
    });
  }

  /** agent-transcript.ts:460-475. The ONLY record type carrying agentRunId/agentRound. */
  writeRoundText(input: {
    readonly round: number;
    readonly text?: string;
    readonly thought?: string;
    readonly usageMetadata?: Record<string, unknown>;
  }): void {
    const parts: Array<Record<string, unknown>> = [
      ...(input.thought !== undefined ? [{ text: input.thought, thought: true }] : []),
      ...(input.text !== undefined ? [{ text: input.text }] : []),
    ];
    // :469 — skipped entirely when there is neither text nor usage.
    if (parts.length === 0 && input.usageMetadata === undefined) return;
    this.append({
      ...this.baseFields("assistant"),
      message: { role: "model", parts },
      ...(input.usageMetadata ? { usageMetadata: input.usageMetadata } : {}),
      agentRunId: this.runId,
      agentRound: input.round,
    });
  }

  /** agent-transcript.ts:477-493. */
  writeToolCall(input: {
    readonly callId: string;
    readonly name: string;
    readonly args?: Record<string, unknown>;
  }): void {
    this.append({
      ...this.baseFields("assistant"),
      message: {
        role: "model",
        parts: [{ functionCall: { id: input.callId, name: input.name, args: input.args ?? {} } }],
      },
    });
  }

  /** agent-transcript.ts:495-510. ONE record per response in the event. */
  writeToolResult(input: {
    readonly callId: string;
    readonly responseParts: ReadonlyArray<Record<string, unknown>>;
    readonly durationMs?: number;
  }): void {
    this.append({
      ...this.baseFields("tool_result"),
      message: { role: "user", parts: [...input.responseParts] },
      toolCallResult: {
        callId: input.callId,
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
    });
  }

  /**
   * agent-transcript.ts:204-221. Pretty-printed with 2 spaces and NO trailing
   * newline; a full rewrite, never an append. `patchAgentMeta` (:234-246) is a
   * read-modify-write spread, so key order survives and new keys land last.
   */
  writeMeta(meta: QwenAgentMeta): void {
    NodeFS.mkdirSync(NodePath.dirname(this.metaPath), { recursive: true });
    NodeFS.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), "utf8");
  }

  patchMeta(updates: Partial<QwenAgentMeta>): void {
    const current = JSON.parse(NodeFS.readFileSync(this.metaPath, "utf8")) as QwenAgentMeta;
    this.writeMeta({ ...current, ...updates });
  }
}
