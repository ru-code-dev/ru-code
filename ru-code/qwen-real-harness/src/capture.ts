// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
// ru-code: the real-qwen harness is deliberately PLAIN NODE, not Effect — it is the
// ORACLE for the Effect-side fake, so sharing its runtime would let one bug hide
// the other. The Effect-API diagnostics are therefore off for this file.
// ru-code (qwen-compression wave): run one scenario against the real qwen binary
// and write the capture down.
//
// The capture IS the deliverable: raw `session/update` params, one per jsonl
// line, plus every prompt response, every inbound request, the mock's request
// bodies and the child's stderr. Nothing is filtered or normalised on the way
// out — a harness that pre-digests its evidence cannot be used to correct the
// fake it exists to check.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AcpCallError, AcpClient } from "./acpClient.ts";
import { startFakeOpenAIServer, type FakeOpenAIRequest } from "./fakeOpenAiServer.ts";
import { FAKE_MODEL, spawnQwen } from "./qwenProcess.ts";
import { scenarioByName, type Scenario } from "./scenarios.ts";

export interface CaptureTurnResult {
  readonly prompt: string;
  readonly sessionId: string;
  /** Present when the prompt resolved. */
  readonly stopReason?: string;
  /**
   * Present when the prompt was REJECTED (a JSON-RPC error, no frame).
   *
   * `data` is kept because it is where qwen's OWN sentence lives: a failed
   * `/compress` answers `-32603 "Internal error"` with the reason demoted into
   * `data.details`, which is the field the adapter reads (`readAcpDetails`) and
   * the fake reproduces. Dropping it left that field asserted by nothing, so a
   * qwen bump that moved the sentence back into `message` — or renamed
   * `details` — would pass every gate.
   */
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
  /** `session/update` params that arrived while this prompt was in flight. */
  readonly updates: ReadonlyArray<unknown>;
}

export interface CaptureResult {
  readonly scenario: string;
  readonly purpose: string;
  readonly qwenVersion: string;
  readonly cliJs: string;
  readonly runRoot: string;
  readonly sessionIds: ReadonlyArray<string>;
  readonly turns: ReadonlyArray<CaptureTurnResult>;
  /** Every `session/update` params of the whole run, in arrival order. */
  readonly allUpdates: ReadonlyArray<unknown>;
  readonly inboundRequests: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  readonly modelRequests: ReadonlyArray<FakeOpenAIRequest>;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CaptureOptions {
  /** The built bundle's entry; `$RU_CODE_QWEN_CLI_JS` when omitted. */
  readonly cliJs?: string;
  /** Where to write the capture; a temp dir when omitted. */
  readonly outDir?: string;
  /** Per-prompt budget. A real `/compress` costs one side-query round trip. */
  readonly promptTimeoutMs?: number;
  /** Version string for the manifest; read with `--version` when omitted. */
  readonly qwenVersion?: string;
}

/** The env switch. Without it nothing in this package may run. */
export const QWEN_CLI_ENV_VAR = "RU_CODE_QWEN_CLI_JS";

export const resolveQwenCliJs = (explicit?: string): string | undefined => {
  const value = explicit ?? process.env[QWEN_CLI_ENV_VAR];
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
};

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

const withTimeout = async <A>(work: Promise<A>, ms: number, description: string): Promise<A> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out after ${String(ms)}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const writeJsonl = (path: string, rows: ReadonlyArray<unknown>): void => {
  NodeFS.writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
  );
};

/**
 * Run `scenario` end to end against the real binary.
 *
 * Order matters and is qwen's, not ours: the mock starts first (its URL goes
 * into the child's env), then the child, then `initialize` → `authenticate` →
 * `session/new`, then the scenario's prompts in sequence. Each prompt's frames
 * are attributed by the window between its call and its answer, which is exact
 * here because the harness never has two prompts in flight.
 */
export async function captureScenario(
  scenario: Scenario | string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const resolved = typeof scenario === "string" ? scenarioByName(scenario) : scenario;
  const cliJs = resolveQwenCliJs(options.cliJs);
  if (cliJs === undefined) {
    throw new Error(
      `no qwen bundle: pass options.cliJs or set ${QWEN_CLI_ENV_VAR} to a built dist/cli.js`,
    );
  }
  const outDir =
    options.outDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-qwen-real-"));
  const runRoot = NodePath.join(outDir, "run");
  const workspace = NodePath.join(runRoot, "workspace");
  NodeFS.mkdirSync(workspace, { recursive: true });

  const startedAtMs = Date.now();
  const mock = await startFakeOpenAIServer(({ body, requestIndex }) =>
    resolved.respond({ body, requestIndex, workspace }),
  );

  const qwen = spawnQwen({
    cliJs,
    cwd: workspace,
    runRoot,
    openAiBaseUrl: mock.baseUrl,
    model: FAKE_MODEL,
    ...(resolved.settings !== undefined ? { settings: resolved.settings } : {}),
  });
  const client = new AcpClient(qwen.child);
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  const sessionIds: string[] = [];
  const turns: CaptureTurnResult[] = [];
  try {
    await withTimeout(client.initialize(), promptTimeoutMs, "initialize");
    await withTimeout(client.authenticate(), promptTimeoutMs, "authenticate");
    let sessionId = await withTimeout(client.newSession(workspace), promptTimeoutMs, "session/new");
    sessionIds.push(sessionId);

    for (const turn of resolved.turns) {
      if (turn.newSession === true) {
        sessionId = await withTimeout(client.newSession(workspace), promptTimeoutMs, "session/new");
        sessionIds.push(sessionId);
      }
      const before = client.notifications.length;
      let stopReason: string | undefined;
      let error: CaptureTurnResult["error"];
      try {
        const response = await withTimeout(
          client.prompt(sessionId, turn.prompt),
          promptTimeoutMs,
          `session/prompt ${JSON.stringify(turn.prompt)}`,
        );
        stopReason = response.stopReason;
      } catch (thrown) {
        if (!(thrown instanceof AcpCallError)) throw thrown;
        error = {
          code: thrown.code,
          message: thrown.rpcMessage,
          ...(thrown.data !== undefined ? { data: thrown.data } : {}),
        };
      }
      turns.push({
        prompt: turn.prompt,
        sessionId,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(error !== undefined ? { error } : {}),
        updates: client.notifications
          .slice(before)
          .filter((notification) => notification.method === "session/update")
          .map((notification) => notification.params),
      });
    }
  } finally {
    client.close();
    await qwen.kill();
    await mock.close();
  }

  const result: CaptureResult = {
    scenario: resolved.name,
    purpose: resolved.purpose,
    qwenVersion: options.qwenVersion ?? "unknown",
    cliJs,
    runRoot,
    sessionIds,
    turns,
    allUpdates: client.sessionUpdates,
    inboundRequests: client.inboundRequests.map(({ method, params }) => ({ method, params })),
    modelRequests: mock.requests,
    stderr: qwen.stderr(),
    durationMs: Date.now() - startedAtMs,
  };

  // The capture, on disk, beside the run root it came from.
  writeJsonl(NodePath.join(outDir, "acp-updates.jsonl"), result.allUpdates);
  writeJsonl(NodePath.join(outDir, "acp-requests.jsonl"), result.inboundRequests);
  writeJsonl(
    NodePath.join(outDir, "model-requests.jsonl"),
    result.modelRequests.map((r) => r.body),
  );
  writeJsonl(NodePath.join(outDir, "prompt-responses.jsonl"), result.turns);
  NodeFS.writeFileSync(NodePath.join(outDir, "stderr.log"), result.stderr);
  NodeFS.writeFileSync(
    NodePath.join(outDir, "run-meta.json"),
    `${JSON.stringify(
      {
        scenario: result.scenario,
        purpose: result.purpose,
        qwenVersion: result.qwenVersion,
        cliJs: result.cliJs,
        sessionIds: result.sessionIds,
        turns: result.turns.map((turn) => ({
          prompt: turn.prompt,
          sessionId: turn.sessionId,
          stopReason: turn.stopReason ?? null,
          // The whole error, `data` included — see `CaptureTurnResult.error`.
          error: turn.error ?? null,
          updateCount: turn.updates.length,
        })),
        updateCount: result.allUpdates.length,
        inboundRequestCount: result.inboundRequests.length,
        modelRequestCount: result.modelRequests.length,
        durationMs: result.durationMs,
      },
      null,
      2,
    )}\n`,
  );
  return result;
}
