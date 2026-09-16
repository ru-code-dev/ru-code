// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
// ru-code: the real-qwen harness is deliberately PLAIN NODE, not Effect — it is the
// ORACLE for the Effect-side fake, so sharing its runtime would let one bug hide
// the other. The Effect-API diagnostics are therefore off for this file.
// ru-code (qwen-compression wave): a MINIMAL ACP client — just enough of the
// host side to drive the real qwen binary and record what it says.
//
// Deliberately not the app's client (`effect-acp` + QwenAcpSessionRuntime): this
// is the ORACLE for that client's fake, so it must share no parsing, no
// dispatch and no assumptions with the code under test. Newline-delimited
// JSON-RPC 2.0 over the child's stdio, which is the whole ACP transport
// (@agentclientprotocol/sdk `ndJsonStream`).
//
// Method names and the protocol version are read off the SDK qwen 0.21.1 itself
// depends on (`@agentclientprotocol/sdk` schema/index.js: PROTOCOL_VERSION = 1,
// AGENT_METHODS, CLIENT_METHODS), so a rename there breaks this loudly rather
// than silently.

import type * as NodeChildProcess from "node:child_process";

/** `PROTOCOL_VERSION` in @agentclientprotocol/sdk (schema/index.js). */
export const ACP_PROTOCOL_VERSION = 1;

/** Every agent-side method this harness calls (SDK `AGENT_METHODS`). */
export const AGENT_METHOD = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
} as const;

/** Every client-side method the agent may call on us (SDK `CLIENT_METHODS`). */
export const CLIENT_METHOD = {
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
} as const;

export interface AcpNotification {
  readonly method: string;
  readonly params: unknown;
  /** Milliseconds since the client was created — the frames' ORDER, recorded. */
  readonly atMs: number;
}

export interface AcpRequestRecord {
  readonly method: string;
  readonly params: unknown;
  readonly atMs: number;
}

export interface AcpCallRecord {
  readonly method: string;
  readonly params: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly atMs: number;
  readonly durationMs: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AcpCallError) => void;
  readonly method: string;
  readonly params: unknown;
  readonly startedAtMs: number;
}

/** A JSON-RPC error answer to one of our calls — a FIRST-CLASS outcome here. */
export class AcpCallError extends Error {
  readonly method: string;
  readonly code: number;
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(method: string, code: number, rpcMessage: string, data?: unknown) {
    super(`${method} failed: [${String(code)}] ${rpcMessage}`);
    this.name = "AcpCallError";
    this.method = method;
    this.code = code;
    this.rpcMessage = rpcMessage;
    this.data = data;
  }
}

export interface AcpClientOptions {
  /** Auto-answer for `session/request_permission`; `--yolo` should mean none arrive. */
  readonly permissionOptionId?: string;
  /** Called for every line we fail to parse — a transport bug, never normal. */
  readonly onMalformedLine?: (line: string) => void;
}

/**
 * The host leg. Records EVERY notification, every inbound request and every call
 * outcome, in arrival order, with a relative timestamp — the capture is the
 * product, so nothing is filtered on the way in.
 */
export class AcpClient {
  readonly notifications: AcpNotification[] = [];
  readonly inboundRequests: AcpRequestRecord[] = [];
  readonly calls: AcpCallRecord[] = [];

  #nextId = 1;
  #buffer = "";
  readonly #pending = new Map<number, Pending>();
  readonly #createdAtMs = Date.now();
  #closed = false;

  readonly #child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly #options: AcpClientOptions;

  constructor(
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    options: AcpClientOptions = {},
  ) {
    this.#child = child;
    this.#options = options;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.on("exit", () => this.#failPending("the qwen child exited"));
  }

  get elapsedMs(): number {
    return Date.now() - this.#createdAtMs;
  }

  /** Every `session/update` params, in arrival order — the frames under study. */
  get sessionUpdates(): ReadonlyArray<unknown> {
    return this.notifications
      .filter((notification) => notification.method === CLIENT_METHOD.sessionUpdate)
      .map((notification) => notification.params);
  }

  initialize(): Promise<unknown> {
    return this.call(AGENT_METHOD.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "ru-code-qwen-real-harness", version: "0.0.0" },
    });
  }

  /** `methodId` is `AuthType.USE_OPENAI` = "openai" (qwen authMethods.ts:10-21). */
  authenticate(methodId = "openai"): Promise<unknown> {
    return this.call(AGENT_METHOD.authenticate, { methodId });
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.call(AGENT_METHOD.sessionNew, { cwd, mcpServers: [] });
    const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`session/new returned no sessionId: ${JSON.stringify(result)}`);
    }
    return sessionId;
  }

  /** One prompt. Resolves with the `PromptResponse`, or throws `AcpCallError`. */
  prompt(sessionId: string, text: string): Promise<{ readonly stopReason?: string }> {
    return this.call(AGENT_METHOD.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    }) as Promise<{ readonly stopReason?: string }>;
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`${method} after close`));
    const id = this.#nextId;
    this.#nextId += 1;
    const startedAtMs = this.elapsedMs;
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method, params, startedAtMs });
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return settled;
  }

  close(): void {
    this.#closed = true;
    this.#failPending("the harness closed the connection");
  }

  #write(payload: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) this.#onLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      this.#options.onMalformedLine?.(line);
      return;
    }

    const id = message["id"];
    const method = message["method"];

    // An answer to one of our calls.
    if (typeof id === "number" && method === undefined) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      const error = message["error"];
      if (error !== undefined && error !== null) {
        const record = error as { code?: unknown; message?: unknown; data?: unknown };
        const code = typeof record.code === "number" ? record.code : -32603;
        const rpcMessage = typeof record.message === "string" ? record.message : "unknown error";
        this.calls.push({
          method: pending.method,
          params: pending.params,
          error: {
            code,
            message: rpcMessage,
            ...(record.data !== undefined ? { data: record.data } : {}),
          },
          atMs: pending.startedAtMs,
          durationMs: this.elapsedMs - pending.startedAtMs,
        });
        pending.reject(new AcpCallError(pending.method, code, rpcMessage, record.data));
        return;
      }
      this.calls.push({
        method: pending.method,
        params: pending.params,
        result: message["result"],
        atMs: pending.startedAtMs,
        durationMs: this.elapsedMs - pending.startedAtMs,
      });
      pending.resolve(message["result"]);
      return;
    }

    if (typeof method !== "string") return;

    // A notification from the agent — every one is recorded verbatim.
    if (id === undefined) {
      this.notifications.push({ method, params: message["params"], atMs: this.elapsedMs });
      return;
    }

    // A request from the agent. Answered minimally; `--yolo` means the
    // permission arm should never fire, and an empty capture of it is the
    // positive confirmation of that rather than a gap.
    this.inboundRequests.push({ method, params: message["params"], atMs: this.elapsedMs });
    if (method === CLIENT_METHOD.requestPermission) {
      const optionId =
        this.#options.permissionOptionId ?? this.#firstAllowOptionId(message["params"]);
      this.#write({
        jsonrpc: "2.0",
        id,
        result:
          optionId === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId } },
      });
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  #firstAllowOptionId(params: unknown): string | undefined {
    const options = (params as { options?: unknown } | null)?.options;
    if (!Array.isArray(options)) return undefined;
    for (const option of options) {
      const kind = (option as { kind?: unknown }).kind;
      const optionId = (option as { optionId?: unknown }).optionId;
      if (typeof optionId === "string" && typeof kind === "string" && kind.startsWith("allow")) {
        return optionId;
      }
    }
    const first = options[0] as { optionId?: unknown } | undefined;
    return typeof first?.optionId === "string" ? first.optionId : undefined;
  }

  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new AcpCallError(pending.method, -32603, reason));
    }
  }
}
