// ru-code: transport-agnostic fake ACP **agent** for the error-engine tests. It
// speaks the REAL ndJSON-RPC wire contract by reusing effect-acp's own
// `AcpAgent` (so the port exercises the same protocol machinery a live qwen
// would). A test supplies a per-prompt script via the `PromptSteps` DSL; the
// agent interprets it to reproduce each error class from the qwen error truth
// table (RPC error, malformed frame, broken pipe, process exit, …).
//
// The in-memory shell (`fakeAcpSpawner.ts`) drives this core for unit tests: it
// backs the fake agent with in-memory queues so the REAL QwenAdapter runs
// unchanged over it — no real process, no real pipe, no wall-clock.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Stdio from "effect/Stdio";
import * as AcpAgent from "effect-acp/agent";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

/** The session id the fake hands back from `session/new` (and accepts on prompt). */
export const FAKE_SESSION_ID = "fake-acp-session";

type StopReason = AcpSchema.PromptResponse["stopReason"];

/**
 * Transport-level controls the SHELL provides. These reach below the JSON-RPC
 * layer to reproduce wire failures the agent handler cannot express as a normal
 * response:
 *   - `writeRaw`        → emit a malformed frame   → client AcpProtocolParseError (C1)
 *   - `closeTransport`  → EOF + failed exit status  → client AcpTransportError    (C4)
 *   - `exit(code)`      → EOF + exit status `code`   → client AcpProcessExitedError (B1)
 */
export interface FakeAcpTransportControls {
  readonly writeRaw: (bytes: string) => Effect.Effect<void>;
  readonly closeTransport: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
}

/** Fluent recorder for a single `session/prompt`. Chainable; terminal ops end it. */
export interface PromptSteps {
  /** Stream an assistant text chunk (`session/update` agent_message_chunk). */
  emitText(text: string): PromptSteps;
  /**
   * ru-code (sub-agents): the REAL qwen THOUGHT frame — `agent_thought_chunk`
   * with NO `_meta` at all. qwen emits it for the parent AND for a sub-agent;
   * the sub-agent variant loses its attribution at
   * qwen-code SubAgentTracker.ts:275 exactly like the text chunk, so it reaches
   * the wire indistinguishable from the parent's. Scripted so the flow test can
   * prove the chat never shows a child's thinking.
   */
  emitThought(text: string): PromptSteps;
  /** ru-code(e2e): real wall-clock pause between steps — the stdio fake uses it to
   *  simulate qwen's spawn/think latency for the live browser harness. */
  sleep(ms: number): PromptSteps;
  /**
   * ru-code: like emitText but stamps running usage on the chunk under
   * `update._meta.usage.inputTokens` — exactly where qwen puts its live
   * promptTokenCount. Drives the adapter's live token-feed (thread.token-usage.updated).
   */
  emitTextWithUsage(text: string, inputTokens: number): PromptSteps;
  /**
   * ru-code: emit the REAL qwen usage frame. qwen does NOT put usage on streaming
   * text chunks — it emits a DEDICATED `agent_message_chunk` whose `content.text`
   * is `""` (empty), carrying `_meta.usage.*`, once per model-response stream after
   * the text loop (qwen-code MessageEmitter.ts:77-101 `emitUsageMetadata` with
   * text=''; Session.ts:341-348). This step reproduces that exact frame so the
   * live token-feed is tested against the shape qwen actually sends (unlike
   * emitTextWithUsage, whose non-empty text never co-occurs with usage in reality).
   */
  emitUsageChunk(inputTokens: number): PromptSteps;
  /**
   * ru-code: emit the REAL qwen TASK-LIST frame. qwen's `todo_write` tool routes
   * through PlanEmitter.emitPlan (qwen-code Session.ts:893-902), which sends a
   * `session/update` with `sessionUpdate:"plan"` and
   * `entries:[{content, priority:"medium", status}]` where status ∈
   * pending|in_progress|completed (qwen-code PlanEmitter.ts + types.ts:89-92).
   * This is the live task-list surface (distinct from exit_plan_mode approval).
   */
  emitPlan(entries: ReadonlyArray<{ content: string; status: string }>): PromptSteps;
  /**
   * ru-code: emit the REAL qwen `tool_call` frame. `_meta.toolName` always rides
   * along (qwen-code ToolCallEmitter.ts:64-80); `subagentMeta`, when given, adds
   * `{ parentToolCallId, subagentType }` — the exact bundle SubAgentTracker
   * attaches to every frame a sub-agent produces (SubAgentTracker.ts:70-75).
   */
  emitToolCall(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly title: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
    readonly kind?: AcpSchema.ToolKind;
    readonly rawInput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps;
  /**
   * ru-code: emit the REAL qwen `tool_call_update` frame (same `_meta` rules).
   * `rawOutput` is qwen's result display — for the `agent` tool that is the
   * AgentResultDisplay the adapter reads the final text and usage from
   * (qwen-code ToolCallEmitter.ts:144-147, tools.ts:486-512).
   */
  emitToolCallUpdate(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "completed" | "failed";
    readonly text?: string;
    readonly rawOutput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps;
  /**
   * ru-code: the SUB-AGENT variant of {@link emitUsageChunk} — same dedicated
   * empty-text agent_message_chunk, but tagged with the sub-agent bundle
   * (qwen-code SubAgentTracker.ts:247-259 → MessageEmitter.ts:77-101). The
   * thread's context meter must ignore it.
   */
  emitSubAgentUsageChunk(input: {
    readonly inputTokens: number;
    readonly parentToolCallId: string;
    readonly subagentType: string;
  }): PromptSteps;
  /**
   * ru-code: send an agent→client `session/request_permission` and AWAIT the client's
   * choice (the adapter parks it behind a Deferred until the user responds). Chainable —
   * drives the exit_plan_mode held-approval + ask-permission paths.
   */
  requestPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps;
  /**
   * ru-code: send an arbitrary agent→client ACP extension NOTIFICATION (no id).
   * Drives the adapter's `handleUnknownExtNotification` slash-command path (the
   * `_qwencode/slash_command` /compress feed). Chainable; fire-and-forget.
   */
  emitExtNotification(method: string, params: unknown): PromptSteps;
  /** Resolve the prompt with a stopReason (turn completes). Terminal. */
  respondOk(stopReason?: StopReason): void;
  /** Reply with a JSON-RPC error (qwen stays alive). Terminal. */
  respondError(code: number, message: string, data?: unknown): void;
  /** Write a malformed frame to the client (→ AcpProtocolParseError). Terminal. */
  writeRaw(bytes: string): void;
  /** Close the transport mid-prompt (→ AcpTransportError). Terminal. */
  closeTransport(): void;
  /** Exit the child with `code` (→ AcpProcessExitedError). Terminal. */
  exit(code: number): void;
}

export interface FakeAcpScript {
  /** Called once per `session/prompt`; build the response with the step DSL. */
  readonly onPrompt: (steps: PromptSteps) => void;
  /** ru-code(e2e): step-execution observer for the stdio harness diagnostics. */
  readonly onStepExecuting?: (kind: string) => void;
  /** ru-code(e2e): session id `session/new` answers with (default FAKE_SESSION_ID).
   *  The stdio harness uses a per-process id so parallel threads get separate
   *  transcript files. */
  readonly sessionId?: string;
  /**
   * ru-code: wire-capture hooks (optional). The fake records the session-start
   * `authenticate` methodId and every `session/set_config_option` so tests can
   * assert the exact bytes the adapter sends — the resolved auth method and the
   * `${slug}(${authMethod})` setModel value. Omitted ⇒ no capture (existing tests).
   */
  readonly onAuthenticate?: (methodId: string) => void;
  readonly onSetConfigOption?: (configId: string, value: string | boolean) => void;
  /**
   * ru-code: capture the `RequestPermissionResponse.outcome` the adapter (client)
   * sends back for each `session/request_permission` — the proceed_once /
   * proceed_always / cancelled wire decision the parked callback resolves to.
   * Fires once per request, the instant the client responds. Omitted ⇒ discarded
   * (the historical behaviour).
   */
  readonly onPermissionOutcome?: (outcome: AcpSchema.RequestPermissionResponse["outcome"]) => void;
  /**
   * ru-code: capture the FULL decoded `RequestPermissionResponse` the client sends
   * back — not just `.outcome`. Needed to observe the sibling `answers` field that
   * ask_user_question rides on (qwen reads `output.answers`). onPermissionOutcome
   * discards everything but the outcome, so it cannot see whether `answers`
   * survived the schema encode. Omitted ⇒ discarded.
   */
  readonly onPermissionResponse?: (response: AcpSchema.RequestPermissionResponse) => void;
  /**
   * ru-code: session-setup capture. `onCreateSession` fires when the start
   * handshake takes the fresh `session/new` path; `onLoadSession` fires (with the
   * requested sessionId) when it takes the `session/load` reconnect path. Lets a
   * resume test prove which branch ran (a valid cursor reconnects; an
   * absent/invalid cursor falls back to a fresh start).
   */
  readonly onCreateSession?: () => void;
  /**
   * ru-code: EFFECTFUL session/new observation — runs (awaited) inside the
   * handler BEFORE the response, in the fake agent's fiber. Lets a test
   * observe bind-time state that only exists during the handshake (e.g. the
   * slot overlay file's live bytes) through Effect services it captured in
   * its own context, with no synchronous fs escape hatch. Keep the effect
   * INFALLIBLE (pipe `orDie`): a failing reader derails the fake handshake,
   * which the host typically sees as a start timeout — not as your error.
   */
  readonly onCreateSessionEffect?: () => Effect.Effect<void>;
  readonly onLoadSession?: (sessionId: string) => void;
  /**
   * ru-code: history replay DURING `session/load`. Real qwen re-sends the whole
   * prior conversation as ordinary `session/update` notifications and AWAITS
   * them BEFORE responding to the load (acpAgent.ts createAndStoreSession →
   * HistoryReplayer). The runtime must drop that window (replay suppression)
   * and still stream the NEXT turn normally. Each entry becomes one
   * agent_message_chunk sent before the load response.
   */
  readonly loadReplayChunks?: ReadonlyArray<string>;
  /**
   * ru-code: fires when the agent receives a `session/cancel` (graceful ACP
   * cancel). The Stop button uses end-force SIGKILL (never session/cancel), so a
   * test can assert this was NOT called to prove the force-kill teardown path.
   */
  readonly onCancel?: () => void;
  /**
   * ru-code: how the fake answers the START handshake (`session/new` + `session/load`).
   *   - "ok" (default) → reply with FAKE_SESSION_ID (a real session establishes).
   *   - "hang"         → never respond (simulates a wedged `cli --acp` boot; the
   *                      adapter's start timeout must convert this into an error).
   *   - "error"        → reply with a JSON-RPC error (start fails cleanly).
   *   - "exit"         → the PROCESS DIES (exit 1) instead of responding — real
   *                      qwen 0.13.1 does exactly this on `session/load` of a
   *                      session file with a corrupt non-first line: jsonl.read
   *                      returns [] for the whole file (jsonl-utils.ts:96-109),
   *                      loadSession → undefined, and loadCliConfig calls
   *                      process.exit(1) (config.ts:998-1002) — a process death
   *                      mid-request, NOT a JSON-RPC error.
   */
  readonly startBehavior?: "ok" | "hang" | "error" | "exit";
  /**
   * ru-code: overrides the START behaviour for `session/load` ONLY (`session/new`
   * keeps following `startBehavior`). Lets a resume test express "load fails but
   * a fresh create succeeds" — the fallback path. Omitted ⇒ `session/load`
   * follows `startBehavior`, exactly as before.
   */
  readonly loadBehavior?: "ok" | "error" | "exit";
  /**
   * ru-code: how the fake answers `initialize` — the very first RPC, before any
   * session exists. Real qwen only reaches its ACP loop at the END of main()
   * (gemini.tsx:410); everything before it can kill or wedge the process with
   * the host's initialize left pending:
   *   - "ok" (default) → normal capabilities response.
   *   - "hang"         → never respond (boot stalled — e.g. a network-stalled
   *                      boot auth refresh, initializeApp → refreshAuth, runs
   *                      BEFORE runAcpAgent creates the connection).
   *   - "exit"         → process dies without responding (fatal boot error —
   *                      e.g. malformed settings JSON throws FatalConfigError,
   *                      exit code 52, settings.ts:726-733 + errors.ts:154).
   * Drives the WARMUP failure paths of the warm pool (a prewarmed child that
   * crashes or wedges before it ever answers initialize).
   */
  readonly initializeBehavior?: "ok" | "hang" | "exit";
  /** Exit code for `initializeBehavior: "exit"`. Default 52 (FatalConfigError). */
  readonly initializeExitCode?: number;
  /**
   * ru-code: how the parked prompt settles after a `session/cancel`.
   *   - "cancelled" (default) → resolve with stopReason "cancelled" (qwen's
   *     normal next-checkpoint cancel, Session.ts:293-295).
   *   - "error" → FAIL the pending `session/prompt` with a JSON-RPC error —
   *     real qwen has this race: when the abort fires as an AbortError thrown
   *     by the underlying stream (instead of a yield), the catch at
   *     Session.ts:330-339 rethrows non-429 errors, so the cancelled prompt
   *     resolves as an ERROR response, not a cancelled stopReason. A host that
   *     already settled the turn on Stop must not let this late error corrupt
   *     its state.
   */
  readonly cancelResponse?: "cancelled" | "error";
  /**
   * ru-code: raw bytes the SHELL writes to the child's stdout BEFORE the agent
   * serves its first frame — boot-time stdout pollution. Real qwen redirects
   * console.log/info/debug to stderr only INSIDE runAcpAgent (acpAgent.ts:81-83);
   * anything printed to real stdout before that line (or any direct
   * process.stdout.write — never redirected) lands in front of the host's
   * ndjson parser. Stock 0.13.1 is clean on the traced paths, but fork builds /
   * wrappers can differ — the pool must survive a parser-poisoned child.
   * Consumed by fakeAcpSpawner (transport-level; the agent never sees it).
   */
  readonly preludeStdout?: string;
  /**
   * ru-code: the model advertisement in the START responses. qwen 0.13.1 returns
   * `models: { currentModelId, availableModels[] }` on BOTH `session/new` and
   * `session/load` (acpAgent.ts newSession/loadSession → buildAvailableModels),
   * each entry `{ modelId: "id(authType)", name, description, _meta: { contextLimit } }`.
   * Set this to drive the adapter's channel-A model discovery with the real shape.
   */
  readonly sessionModels?: AcpSchema.SessionModelState;
  /**
   * ru-code: make `session/set_config_option` for `configId:"model"` FAIL with
   * this JSON-RPC error — the qwen-local registry miss surfaces exactly like
   * this (`Model 'X' not found for authType 'Y'` thrown in modelsConfig.ts →
   * SDK internalError -32603 with data.details). Drives channel-B discovery.
   */
  readonly setModelError?: { code: number; message: string; data?: unknown };
  /**
   * ru-code: capture each `session/prompt`'s first text block — the exact text
   * the adapter dispatched (e.g. the hidden "/compress" of compactContext).
   */
  readonly onPromptText?: (text: string) => void;
  /**
   * ru-code: out-of-band agent→client emitter, handed to the test once the
   * fake agent is wired. Real qwen does NOT await its chunk notifications
   * (qwen-code Session.ts:308 calls emitMessage without await inside the
   * stream loop), so a chunk can reach the client AFTER the `session/prompt`
   * response. The step DSL can't express that (steps run before the terminal
   * response); this hook lets a test send a chunk at a point IT controls —
   * e.g. strictly after `sendTurn` returned, when the adapter's turn finalizer
   * has provably run.
   */
  readonly onOutOfBandEmitter?: (emit: {
    readonly agentMessageChunk: (text: string) => Effect.Effect<void>;
  }) => void;
}

type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "textWithUsage"; readonly text: string; readonly inputTokens: number }
  | { readonly kind: "usageChunk"; readonly inputTokens: number }
  | {
      readonly kind: "plan";
      readonly entries: ReadonlyArray<{ content: string; status: string }>;
    }
  | {
      readonly kind: "toolCall";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly title: string;
      readonly status: "pending" | "in_progress" | "completed" | "failed";
      readonly toolKind: AcpSchema.ToolKind;
      readonly rawInput: unknown;
      readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
    }
  | {
      readonly kind: "toolCallUpdate";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "completed" | "failed";
      readonly text?: string;
      readonly rawOutput?: unknown;
      readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
    }
  | {
      readonly kind: "subAgentUsageChunk";
      readonly inputTokens: number;
      readonly parentToolCallId: string;
      readonly subagentType: string;
    }
  | { readonly kind: "requestPermission"; readonly payload: AcpSchema.RequestPermissionRequest }
  | { readonly kind: "sleep"; readonly ms: number }
  | { readonly kind: "extNotification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "ok"; readonly stopReason: StopReason }
  | {
      readonly kind: "error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    }
  | { readonly kind: "raw"; readonly bytes: string }
  | { readonly kind: "close" }
  | { readonly kind: "exit"; readonly code: number };

class PromptStepsRecorder implements PromptSteps {
  readonly steps: FakeStep[] = [];
  emitText(text: string): PromptSteps {
    this.steps.push({ kind: "text", text });
    return this;
  }
  emitThought(text: string): PromptSteps {
    this.steps.push({ kind: "thought", text });
    return this;
  }
  sleep(ms: number): PromptSteps {
    this.steps.push({ kind: "sleep", ms });
    return this;
  }
  emitTextWithUsage(text: string, inputTokens: number): PromptSteps {
    this.steps.push({ kind: "textWithUsage", text, inputTokens });
    return this;
  }
  emitUsageChunk(inputTokens: number): PromptSteps {
    this.steps.push({ kind: "usageChunk", inputTokens });
    return this;
  }
  emitPlan(entries: ReadonlyArray<{ content: string; status: string }>): PromptSteps {
    this.steps.push({ kind: "plan", entries });
    return this;
  }
  emitToolCall(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly title: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
    readonly kind?: AcpSchema.ToolKind;
    readonly rawInput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps {
    this.steps.push({
      kind: "toolCall",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      title: input.title,
      status: input.status ?? "in_progress",
      toolKind: input.kind ?? "other",
      rawInput: input.rawInput ?? {},
      ...(input.subagentMeta ? { subagentMeta: input.subagentMeta } : {}),
    });
    return this;
  }
  emitToolCallUpdate(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "completed" | "failed";
    readonly text?: string;
    readonly rawOutput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps {
    this.steps.push({
      kind: "toolCallUpdate",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.rawOutput !== undefined ? { rawOutput: input.rawOutput } : {}),
      ...(input.subagentMeta ? { subagentMeta: input.subagentMeta } : {}),
    });
    return this;
  }
  emitSubAgentUsageChunk(input: {
    readonly inputTokens: number;
    readonly parentToolCallId: string;
    readonly subagentType: string;
  }): PromptSteps {
    this.steps.push({ kind: "subAgentUsageChunk", ...input });
    return this;
  }
  requestPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps {
    this.steps.push({ kind: "requestPermission", payload });
    return this;
  }
  emitExtNotification(method: string, params: unknown): PromptSteps {
    this.steps.push({ kind: "extNotification", method, params });
    return this;
  }
  respondOk(stopReason: StopReason = "end_turn"): void {
    this.steps.push({ kind: "ok", stopReason });
  }
  respondError(code: number, message: string, data?: unknown): void {
    this.steps.push({ kind: "error", code, message, ...(data !== undefined ? { data } : {}) });
  }
  writeRaw(bytes: string): void {
    this.steps.push({ kind: "raw", bytes });
  }
  closeTransport(): void {
    this.steps.push({ kind: "close" });
  }
  exit(code: number): void {
    this.steps.push({ kind: "exit", code });
  }
}

/**
 * Build the fake agent over `stdio` and register the core method handlers. Returns
 * after registration; the agent's RPC server runs forked in the current scope.
 * `controls` lets the prompt DSL induce transport-level failures.
 */
export const runFakeAcpAgent = (
  stdio: Stdio.Stdio,
  script: FakeAcpScript,
  controls: FakeAcpTransportControls,
): Effect.Effect<void, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    // Per-prompt cancel hook: session/cancel resolves the in-flight prompt with
    // stopReason "cancelled" (matches qwen's wire behaviour). Stop in the adapter
    // currently force-kills, so this is exercised only by a graceful cancel path.
    // ru-code: the error channel carries `cancelResponse: "error"` — the parked
    // prompt then FAILS with a JSON-RPC error instead of resolving cancelled.
    const activeCancelRef = yield* Ref.make<
      Deferred.Deferred<StopReason, AcpErrors.AcpRequestError> | undefined
    >(undefined);

    // ru-code: process-death arm shared by initialize/new/load — the child dies
    // without ever responding; the host's pending request fails on EOF + exit.
    const dieWithoutResponse = (code: number) =>
      controls.exit(code).pipe(Effect.andThen(Effect.never));

    yield* agent.handleInitialize(() =>
      // ru-code: boot-failure behaviours (see `initializeBehavior` doc).
      script.initializeBehavior === "hang"
        ? Effect.never
        : script.initializeBehavior === "exit"
          ? dieWithoutResponse(script.initializeExitCode ?? 52)
          : Effect.succeed({
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, embeddedContext: true },
              },
            }),
    );
    yield* agent.handleAuthenticate((request) => {
      script.onAuthenticate?.(request.methodId); // ru-code: capture the resolved methodId
      return Effect.succeed({});
    });
    // ru-code: the START handshake honours `script.startBehavior` so tests can drive
    // a wedged ("hang") or failing ("error") `cli --acp` boot, not just the happy path.
    // session/new and session/load carry DIFFERENT response shapes (only session/new
    // returns a sessionId), so the ok arm differs per handler.
    const handshakeFailure = () =>
      new AcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "start handshake failed (fake)",
      });
    yield* agent.handleCreateSession(() => {
      script.onCreateSession?.(); // ru-code: capture the fresh-start path
      return script.startBehavior === "hang"
        ? Effect.never
        : script.startBehavior === "error"
          ? handshakeFailure()
          : script.startBehavior === "exit"
            ? dieWithoutResponse(1)
            : (script.onCreateSessionEffect?.() ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.succeed({
                    sessionId: script.sessionId ?? FAKE_SESSION_ID,
                    // ru-code: real qwen advertises its model catalog here.
                    ...(script.sessionModels ? { models: script.sessionModels } : {}),
                  }),
                ),
              );
    });
    yield* agent.handleLoadSession((request) => {
      script.onLoadSession?.(request.sessionId); // ru-code: capture the reconnect path
      // ru-code: `loadBehavior` (when set) governs this handler alone.
      const loadBehavior = script.loadBehavior ?? script.startBehavior;
      if (loadBehavior === "hang") return Effect.never;
      if (loadBehavior === "error") return handshakeFailure();
      // ru-code: the corrupt-session-file shape — process.exit(1) mid-load
      // (qwen-code config.ts:998-1002; see the `startBehavior` doc).
      if (loadBehavior === "exit") return dieWithoutResponse(1);
      // ru-code: replay history DURING the load, awaited before the response —
      // exactly like real qwen (see the loadReplayChunks doc).
      return Effect.forEach(
        script.loadReplayChunks ?? [],
        (text) =>
          agent.client.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
              // Real replay chunks carry the record timestamp (HistoryReplayer).
              _meta: { timestamp: 1_700_000_000_000 },
            },
          }),
        { discard: true },
      ).pipe(
        // ru-code: session/load re-advertises the catalog too (acpAgent.ts:239-247).
        Effect.as(script.sessionModels ? { models: script.sessionModels } : {}),
        Effect.orDie,
      );
    });
    yield* agent.handleSetSessionConfigOption((request) => {
      // ru-code: capture the setModel wire — configId "model" + the encoded value.
      script.onSetConfigOption?.(request.configId, request.value);
      // ru-code: scripted qwen-local registry miss for channel-B discovery tests.
      if (script.setModelError && request.configId === "model") {
        return new AcpErrors.AcpRequestError({
          code: script.setModelError.code,
          errorMessage: script.setModelError.message,
          ...(script.setModelError.data !== undefined ? { data: script.setModelError.data } : {}),
        });
      }
      return Effect.succeed({ configOptions: [] });
    });
    yield* agent.handleSetSessionModel(() => Effect.succeed({}));
    yield* agent.handleCancel(() =>
      Effect.sync(() => script.onCancel?.()).pipe(
        // ru-code: record the graceful session/cancel so a Stop-button test can
        // assert it was NOT reached (the Stop path is end-force SIGKILL).
        Effect.andThen(
          Ref.get(activeCancelRef).pipe(
            Effect.flatMap((deferred) =>
              deferred
                ? // ru-code: `cancelResponse: "error"` reproduces qwen's abort-vs-
                  // error race — the cancelled prompt FAILS with a JSON-RPC error
                  // instead of the clean cancelled stopReason (see the doc).
                  (script.cancelResponse === "error"
                    ? Deferred.fail(
                        deferred,
                        new AcpErrors.AcpRequestError({
                          code: -32603,
                          errorMessage: "The operation was aborted (fake abort-race error)",
                        }),
                      )
                    : Deferred.succeed(deferred, "cancelled")
                  ).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        ),
      ),
    );

    // ru-code: hand the out-of-band emitter to the test (see the hook doc —
    // reproduces qwen's un-awaited chunk emission trailing the prompt response).
    script.onOutOfBandEmitter?.({
      agentMessageChunk: (text) =>
        agent.client
          .sessionUpdate({
            sessionId: script.sessionId ?? FAKE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          })
          // A transport failure here is the scenario under test elsewhere;
          // for the emitter it just means the update was not deliverable.
          .pipe(Effect.asVoid, Effect.orDie),
    });

    yield* agent.handlePrompt((request) =>
      Effect.gen(function* () {
        // ru-code: capture the prompt's first text block — lets a test assert
        // the exact text the adapter sent (e.g. the hidden "/compress").
        const firstBlock = request.prompt[0];
        script.onPromptText?.(firstBlock && firstBlock.type === "text" ? firstBlock.text : "");
        const recorder = new PromptStepsRecorder();
        script.onPrompt(recorder);
        // ru-code: error channel carries the cancelResponse:"error" abort-race.
        const cancelled = yield* Deferred.make<StopReason, AcpErrors.AcpRequestError>();
        yield* Ref.set(activeCancelRef, cancelled);

        for (const step of recorder.steps) {
          script.onStepExecuting?.(step.kind);
          switch (step.kind) {
            case "sleep":
              // ru-code(e2e): wall-clock pause (browser-harness realism only).
              yield* Effect.sleep(step.ms);
              break;
            case "text":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                },
              });
              break;
            case "thought":
              // ru-code (sub-agents): qwen's thought frame carries NO _meta —
              // neither the parent's nor a child's (SubAgentTracker.ts:275).
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: step.text },
                },
              });
              break;
            case "textWithUsage":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                  // ru-code: qwen stamps running usage on the chunk's _meta; the
                  // adapter reads update._meta.usage.inputTokens off the raw params.
                  _meta: { usage: { inputTokens: step.inputTokens } },
                },
              });
              break;
            case "usageChunk":
              // ru-code: the REAL qwen usage frame — a dedicated agent_message_chunk
              // with EMPTY text carrying _meta.usage (qwen-code MessageEmitter.ts:77-101,
              // called with text=''). This is the ONLY frame qwen stamps usage on.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "" },
                  _meta: {
                    usage: {
                      inputTokens: step.inputTokens,
                      outputTokens: 0,
                      totalTokens: step.inputTokens,
                    },
                    durationMs: 0,
                  },
                },
              });
              break;
            case "plan":
              // ru-code: the REAL qwen task-list frame. todo_write →
              // PlanEmitter.emitPlan (qwen-code Session.ts:893-906) sends a single
              // session/update with sessionUpdate:"plan" and
              // entries:[{content, priority:"medium", status}] (PlanEmitter.ts).
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "plan",
                  entries: step.entries.map((entry) => ({
                    content: entry.content,
                    priority: "medium" as const,
                    // qwen status ∈ pending|in_progress|completed (types.ts:89-92); the
                    // FakeStep carries it as string, so narrow to the ACP PlanEntry union.
                    status: entry.status as "pending" | "in_progress" | "completed",
                  })),
                },
              });
              break;
            case "toolCall":
              // ru-code: the REAL qwen tool_call frame — `_meta.toolName` always,
              // plus the sub-agent bundle when the frame belongs to a child.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: step.toolCallId,
                  status: step.status,
                  title: step.title,
                  content: [],
                  locations: [],
                  kind: step.toolKind,
                  rawInput: step.rawInput,
                  _meta: { toolName: step.toolName, ...step.subagentMeta },
                },
              });
              break;
            case "toolCallUpdate":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: step.toolCallId,
                  status: step.status,
                  content:
                    step.text === undefined
                      ? []
                      : [{ type: "content", content: { type: "text", text: step.text } }],
                  ...(step.rawOutput !== undefined ? { rawOutput: step.rawOutput } : {}),
                  _meta: { toolName: step.toolName, ...step.subagentMeta },
                },
              });
              break;
            case "subAgentUsageChunk":
              // ru-code: same frame as `usageChunk`, tagged as a child's usage.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "" },
                  _meta: {
                    usage: {
                      inputTokens: step.inputTokens,
                      outputTokens: 0,
                      totalTokens: step.inputTokens,
                    },
                    durationMs: 0,
                    parentToolCallId: step.parentToolCallId,
                    subagentType: step.subagentType,
                  },
                },
              });
              break;
            case "requestPermission": {
              // ru-code: agent→client request; blocks until the adapter (client) responds
              // to the parked request, mirroring qwen's held prompt() during plan approval.
              const response = yield* agent.client.requestPermission(step.payload);
              // ru-code: expose the decision the client resolved to (proceed_once /
              // proceed_always / cancelled) for the M2 wire-contract assertions.
              script.onPermissionOutcome?.(response.outcome);
              // ru-code: expose the FULL response so answer-round-trip tests can see
              // the sibling `answers` field (the outcome-only hook cannot).
              script.onPermissionResponse?.(response);
              break;
            }
            case "extNotification":
              // ru-code: fire-and-forget agent→client extension notification (the
              // slash-command /compress feed the adapter's handleUnknownExtNotification reads).
              yield* agent.client.extNotification(step.method, step.params);
              break;
            case "raw":
              yield* controls.writeRaw(step.bytes);
              break;
            case "close":
              yield* controls.closeTransport;
              break;
            case "exit":
              yield* controls.exit(step.code);
              break;
            case "ok":
              return { stopReason: step.stopReason };
            case "error":
              return yield* new AcpErrors.AcpRequestError({
                code: step.code,
                errorMessage: step.message,
                ...(step.data !== undefined ? { data: step.data } : {}),
              });
          }
        }
        // No terminal response in the script: park until session/cancel resolves
        // us cancelled, or until the transport dies (the client fails the prompt
        // and this fiber is interrupted on scope teardown).
        const stopReason = yield* Deferred.await(cancelled);
        return { stopReason };
      }),
    );
  });

export { PromptStepsRecorder };
