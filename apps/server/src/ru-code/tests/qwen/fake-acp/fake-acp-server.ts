// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// ru-code: stdio shell for the fake ACP agent — LIVE manual mode.
//
// A standalone Node entry that speaks the real ndJSON-RPC ACP wire over actual
// stdin/stdout, so the REAL app can be driven against a scripted wire failure for
// manual UI checks. It shares `fakeAcpCore` with the unit tests, so "passes in CI"
// and "looks right when driven live" exercise the SAME agent behaviour — the only
// difference is real pipes instead of in-memory queues.
//
// Wire it in via the dev-only override (no production code change), on the DEFAULT
// (custom-profile) provider instance so the env override reaches the spawn:
//   RU_CODE_CLI_JS=<abs path to THIS file> RU_CODE_FAKE_ACP=C4 <start the app>
// Then send a turn and watch the real timeline + notification banner + bubble.
// Change RU_CODE_FAKE_ACP to another id below to reproduce a different error.
// No build step: our spawn treats a `.ts` bin as `node --experimental-strip-types
// <file>`, exactly how the server itself runs `node src/bin.ts`.
//
// NOTE on transport vs process-exit: a true "broken pipe, child still alive" (C4)
// isn't cheaply reproducible over a real OS pipe without hanging on the child's
// exitCode, so over stdio `closeTransport` exits the process — visually identical
// (T+N banner + persisting row + stopped timer). The exact C4 transport
// CLASSIFICATION is pinned by the in-memory unit tests. Likewise B2 (exit with no
// readable code) and the D-bucket (provider-adapter errors) are not wire-inducible
// from a running agent — they are covered by the in-memory + classifier tests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// ru-code(e2e): the REAL path formula (win32 lowercasing included) — the fake
// used to re-implement the sanitize regex and would have silently diverged.
import { resolveTranscriptFilePath } from "@smart-tools/qwen-cli-transcript-core";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { type FakeAcpScript, type PromptSteps, runFakeAcpAgent } from "./fakeAcpCore.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

// CRITICAL: stdout is the ACP wire (ndJSON-RPC) — ANYTHING non-protocol on it
// corrupts the stream and the client fails to parse the handshake. Effect's
// default logger writes via `console.log` (→ stdout), so route the whole console
// to stderr. The protocol writer below uses `process.stdout.write` directly, so it
// is unaffected; only stray logs are redirected.
const toStderr =
  (prefix: string) =>
  (...args: ReadonlyArray<unknown>) =>
    process.stderr.write(`${prefix}${args.map((value) => String(value)).join(" ")}\n`);
console.log = toStderr("");
console.info = toStderr("");
console.debug = toStderr("");
console.warn = toStderr("");

// One script per error id (mirrors the error truth table). Default = a clean turn.
const SCENARIOS: Record<string, FakeAcpScript> = {
  // Mid-turn transport / process death → T+N (banner + row), timer stops.
  C4: { onPrompt: (steps) => steps.emitText("частичный ответ…").closeTransport() },
  C1: { onPrompt: (steps) => steps.emitText("привет").writeRaw("}{ not json\n") },
  B1: { onPrompt: (steps) => steps.emitText("частичный ответ…").exit(1) },
  // RPC errors while the agent stays alive.
  A5: { onPrompt: (steps) => steps.respondError(-32000, "auth required") }, // T+N
  A4: { onPrompt: (steps) => steps.respondError(-32601, "method not found") }, // T
  A6: { onPrompt: (steps) => steps.respondError(-32002, "resource not found") }, // T
  // B-surface: friendly bubble, turn completes, no banner.
  A1: {
    onPrompt: (steps) =>
      steps.respondError(-32603, "internal", {
        details: "Model stream ended with empty response text",
      }),
  },
  A2: { onPrompt: (steps) => steps.respondError(429, "rate limit") },
  A3: {
    onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }),
  },
  A7: {
    onPrompt: (steps) =>
      steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
  },
  // Unrecognized clean request error → Z (T+N, detail verbatim).
  Z: { onPrompt: (steps) => steps.respondError(-32050, "Какая-то понятная ошибка из движка") },
  // Start handshake fails / hangs (drive the boot-time error / timeout paths).
  START_ERROR: { onPrompt: (steps) => steps.respondOk(), startBehavior: "error" },
  START_HANG: { onPrompt: (steps) => steps.respondOk(), startBehavior: "hang" },
  // Stop demo: a long-running turn the user can interrupt from the UI.
  HOLD: { onPrompt: (steps) => steps.emitText("работаю, нажмите Стоп…") },
  OK: { onPrompt: (steps) => steps.emitText("Готово.").respondOk("end_turn") },
  // ru-code(e2e): the browser-harness flow — a realistic "user asks, CLI responds"
  // turn that ALSO writes the session JSONL the extended view tails (raw shapes
  // mirror a real qwen 0.13.1 fixture). Per-spawn knobs come from the JSON file
  // at RU_CODE_FAKE_CONTROL_FILE ({delayMs, responseText}), re-read every prompt,
  // so specs steer latency without restarting the app.
  FLOW: makeFlowScenario(),
};

interface FlowControl {
  readonly delayMs?: number;
  readonly responseText?: string;
  // ru-code(e2e, agents): drive ONE qwen `agent` tool call through the browser
  // harness. Same knob channel as the two above — the control file is re-read on
  // every prompt, so a spec switches the whole run on without rebooting the app,
  // and a spec that never sets it gets today's text-only FLOW byte-for-byte.
  // Frame shapes are the ones the in-memory suite already pins
  // (subAgentFlow.e2e.test.ts:45-105); this is the same wire, over real pipes.
  // ru-code (mid-turn wave, P3d): hold the turn open for `holdMs` and then run
  // ONE mid-turn drain. That window is what lets a browser spec type a second
  // message WHILE the first turn is genuinely running — the only state in which
  // the delivery marks exist at all.
  // ru-code (live-issues T1): a SLOW, MULTI-CHUNK response — the baseline the
  // working-line specs pin. `chunks` deltas `gapMs` apart, so the turn is
  // genuinely running for roughly chunks*gapMs and the DOM timer has real
  // seconds to count. REAL wall-clock on purpose: the working timer ticks off a
  // `setInterval` over `new Date()` inside the browser
  // (MessagesTimeline.tsx:1326-1340), which nothing on this side can virtualize.
  readonly stream?: { readonly chunks: number; readonly gapMs: number };
  // ru-code (live-issues T1): N BACKGROUND agents launched in this turn and left
  // genuinely running in the fake's task registry (served over
  // `qwen/status/session/tasks`), with the main turn PARKED when `hold` — the
  // exact state the owner's scenario needs before pressing Stop.
  readonly backgroundAgents?: { readonly count: number; readonly hold?: boolean };
  // ru-code (agentic-flow wave, timer-bug): the OWNER'S REPRO turn — a turn big
  // enough to FOLD. The reported defect lands "at the exact commit where the
  // previous turn's rows collapse (rowsCount 14→11)", and a collapse of that
  // size needs a turn carrying many foldable work entries; `backgroundAgents`
  // alone cannot produce one, because agent-spawn rows are explicitly exempt
  // from folding (MessagesTimeline.logic.ts:404-409). So this knob emits
  // `toolCalls` ordinary completed tool calls (foldable), `agents` background
  // launches (the running fleet), and then keeps EMITTING TEXT while the turn
  // stays parked — which is what makes the Stop land on a genuinely streaming
  // turn and leak a partial chunk during the kill, exactly as qwen does.
  readonly richTurn?: {
    readonly toolCalls: number;
    readonly agents: number;
    readonly holdChunks?: number;
    readonly holdGapMs?: number;
  };
  readonly midTurn?: { readonly holdMs: number };
  readonly subAgent?: {
    readonly title: string;
    readonly role: string;
    readonly innerTool?: string;
    // Omitted ⇒ the run stays OPEN and the prompt never resolves (the HOLD
    // shape): that is the Stop leg, where qwen sends no settling frame at all
    // and only the server-side teardown settle can close the row.
    readonly settle?: {
      readonly status: "completed" | "failed" | "cancelled";
      readonly result?: string;
    };
  };
}

// ru-code(e2e, agents): tool-call ids must be unique PER CALL, exactly as qwen's
// own are — the Agents panel keys a row by the spawn's tool-call id, so a fixed
// id would merge two separate runs (even in different threads) into one row.
let agentCallSeq = 0;

/**
 * ru-code(e2e, agents): scripts one root `agent` call plus its child's inner
 * tool. Terminal ops are the CALLER's business — this returns the still-open
 * chain so the caller decides between `respondOk()` (settled run) and parking
 * (the Stop leg).
 */
function scriptSubAgentRun(
  steps: PromptSteps,
  subAgent: NonNullable<FlowControl["subAgent"]>,
): PromptSteps {
  agentCallSeq += 1;
  const agentCallId = `e2e-call-agent-${process.pid}-${agentCallSeq}`;
  const innerCallId = `e2e-call-inner-${process.pid}-${agentCallSeq}`;
  const meta = { parentToolCallId: agentCallId, subagentType: subAgent.role };
  const innerTool = subAgent.innerTool ?? "read_file";
  const opened = steps
    .emitToolCall({
      toolCallId: agentCallId,
      toolName: "agent",
      title: `Agent: ${subAgent.title}`,
      rawInput: {
        description: subAgent.title,
        prompt: "p",
        subagent_type: subAgent.role,
        run_in_background: false,
      },
    })
    // Real spacing: qwen runs the child's tool loop after the spawn frame is on
    // the wire, and the browser needs a paint between them anyway.
    .sleep(120)
    .emitToolCall({
      toolCallId: innerCallId,
      toolName: innerTool,
      title: `${innerTool}: /a.ts`,
      status: "pending",
      kind: "read",
      rawInput: { absolute_path: "/a.ts" },
      subagentMeta: meta,
    })
    .emitToolCallUpdate({
      toolCallId: innerCallId,
      toolName: innerTool,
      status: "completed",
      text: "42 lines",
      subagentMeta: meta,
    })
    .sleep(120);
  if (!subAgent.settle) return opened;
  return opened.emitToolCallUpdate({
    toolCallId: agentCallId,
    toolName: "agent",
    status: subAgent.settle.status === "failed" ? "failed" : "completed",
    ...(subAgent.settle.result ? { text: subAgent.settle.result } : {}),
    rawOutput: {
      type: "task_execution",
      subagentName: subAgent.role,
      taskDescription: subAgent.title,
      status: subAgent.settle.status,
      ...(subAgent.settle.result ? { result: subAgent.settle.result } : {}),
      executionSummary: { totalDurationMs: 4200, totalToolCalls: 5, totalTokens: 4441 },
    },
  });
}

// ru-code(e2e): append-only diagnostics file (RU_CODE_FAKE_LOG_FILE) — the real
// spawn's stderr is not surfaced by the server, so the harness reads this file.
function fakeLog(line: string): void {
  const logFile = process.env["RU_CODE_FAKE_LOG_FILE"];
  if (!logFile) return;
  try {
    NodeFS.appendFileSync(logFile, `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`);
  } catch {
    // diagnostics only — SWALLOW-BY-DESIGN: a broken log file must never take
    // down the fake CLI mid-scenario; the ACP wire is the observable contract
  }
}

function makeFlowScenario(): FakeAcpScript {
  // Per-process session id → each thread (one spawn each) tails its OWN file.
  const sessionId = `fake-acp-session-${process.pid}`;
  const cwd = process.cwd();
  let lastPromptText = "";
  let lastRecordUuid: string | null = null;
  let recordCounter = 0;

  const readControl = (): FlowControl => {
    const controlPath = process.env["RU_CODE_FAKE_CONTROL_FILE"];
    if (!controlPath) return {};
    try {
      return JSON.parse(NodeFS.readFileSync(controlPath, "utf8")) as FlowControl;
    } catch {
      return {};
    }
  };

  const transcriptPath = (): string | null => {
    const configDir = process.env["RU_CODE_FAKE_CLI_CONFIG_DIR"];
    if (!configDir) return null;
    return resolveTranscriptFilePath({
      cliConfigDir: configDir,
      cwd,
      // oxlint-disable-next-line t3code/no-global-process-runtime -- ru-code: standalone stdio Node entry (no Effect runtime to inject HostProcessPlatform); mirrors the real CLI which also reads its own process
      platform: process.platform,
      sessionId,
    });
  };

  const appendRecord = (record: Record<string, unknown>): void => {
    const filePath = transcriptPath();
    if (!filePath) return;
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  };

  const baseRecord = (type: string) => {
    recordCounter += 1;
    const uuid = `flow-${type}-${process.pid}-${recordCounter}`;
    const record = {
      uuid,
      parentUuid: lastRecordUuid,
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      cwd,
      version: "0.13.1",
    };
    lastRecordUuid = uuid;
    return record;
  };

  // ru-code (live-issues T1): the fake's LIVE background registry. Mutable and
  // shared with the poll surface below, exactly as qwen's own `getAll()` returns
  // live Map entries rather than clones (research §14.1).
  const bgEntries: QwenAgentTaskEntry[] = [];
  let bgSeq = 0;
  // ru-code (timer-bug): tool-call ids for the rich repro turn — unique per call
  // for the same reason `agentCallSeq` is (a reused id merges two rows into one).
  let richSeq = 0;

  return {
    sessionId,
    // ru-code (live-issues T1): serve `qwen/status/session/tasks` from the live
    // registry above. Inert until a prompt actually launches something.
    backgroundTasks: { entries: bgEntries },
    // ru-code (mid-turn wave, P3d): the drain knob is always ON for this
    // scenario. It is inert unless a prompt actually scripts `.drainMidTurn()`,
    // so every pre-existing e2e leg is byte-identical; only the mid-turn leg
    // opts in via the control file.
    midTurnDrain: {},
    onCreateSession: () => fakeLog("session/new"),
    onStepExecuting: (kind) => fakeLog(`step: ${kind}`),
    onSetConfigOption: (configId, value) =>
      fakeLog(`set_config_option ${configId}=${String(value)}`),
    onLoadSession: (loaded) => fakeLog(`session/load ${loaded}`),
    onPromptText: (text) => {
      lastPromptText = text;
      fakeLog(`prompt text: ${text.slice(0, 120)}`);
    },
    onPrompt: (steps) => {
      const control = readControl();
      fakeLog(`onPrompt control=${JSON.stringify(control)}`);
      const delayMs = control.delayMs ?? 0;
      const responseText =
        control.responseText ??
        "Понял вас! Вот развёрнутый ответ на ваш вопрос — несколько строк текста,\nчтобы пузырь имел реальную высоту, как настоящий ответ модели.";
      const promptText = lastPromptText;
      // Real qwen writes the user record only after boot/binding — the delay
      // reproduces the fresh-spawn window the empty-screen bug lived in.
      setTimeout(() => {
        fakeLog("writing user record");
        appendRecord({
          ...baseRecord("user"),
          message: { role: "user", parts: [{ text: promptText }] },
        });
      }, delayMs);
      setTimeout(() => {
        appendRecord({
          ...baseRecord("assistant"),
          model: "fake/model",
          message: { role: "model", parts: [{ text: responseText }] },
        });
      }, delayMs + 400);
      const opened = steps.sleep(delayMs + 500);
      // ru-code (P3d): the mid-turn window. Hold, drain once (the host answers
      // from its queue), then finish the turn normally.
      if (control.midTurn) {
        opened
          .sleep(control.midTurn.holdMs)
          .drainMidTurn()
          .emitText(responseText)
          .respondOk("end_turn");
        return;
      }
      // ru-code (agentic-flow wave, timer-bug): the foldable, parked, streaming turn.
      if (control.richTurn) {
        let chain = opened;
        for (let index = 0; index < control.richTurn.toolCalls; index += 1) {
          richSeq += 1;
          const callId = `e2e-rich-${String(process.pid)}-${String(richSeq)}`;
          chain = chain
            .emitToolCall({
              toolCallId: callId,
              toolName: "read_file",
              title: `read_file: /rich${String(index)}.ts`,
              status: "pending",
              kind: "read",
              rawInput: { absolute_path: `/rich${String(index)}.ts` },
            })
            .emitToolCallUpdate({
              toolCallId: callId,
              toolName: "read_file",
              status: "completed",
              text: `${String(20 + index)} lines`,
            })
            .sleep(80);
        }
        for (let index = 0; index < control.richTurn.agents; index += 1) {
          bgSeq += 1;
          const agentId = qwenBackgroundAgentId("general-purpose", `e2erich${String(bgSeq)}`);
          const callId = `call_rich_bg_${String(bgSeq)}`;
          const description = `Background job ${String(index + 1)}`;
          bgEntries.push({
            id: agentId,
            description,
            subagentType: "general-purpose",
            status: "running",
            startTime: Date.now(),
            isBackgrounded: true,
            toolUseId: callId,
          });
          chain = chain.emitBackgroundLaunch({
            toolCallId: callId,
            agentId,
            subagentName: "general-purpose",
            taskDescription: description,
          });
        }
        // Park while STREAMING: no terminal frame ever, so only the Stop's
        // force-kill ends it — and it ends mid-chunk.
        for (let index = 0; index < (control.richTurn.holdChunks ?? 0); index += 1) {
          chain = chain
            .emitText(`${responseText} [${String(index + 1)}]\n`)
            .sleep(control.richTurn.holdGapMs ?? 800);
        }
        return;
      }
      // ru-code (live-issues T1): two background agents, genuinely running.
      if (control.backgroundAgents) {
        let chain = opened;
        for (let index = 0; index < control.backgroundAgents.count; index += 1) {
          bgSeq += 1;
          const agentId = qwenBackgroundAgentId("general-purpose", `e2ebg${String(bgSeq)}`);
          const callId = `call_bg_${String(bgSeq)}`;
          const description = `Background job ${String(index + 1)}`;
          bgEntries.push({
            id: agentId,
            description,
            subagentType: "general-purpose",
            status: "running",
            startTime: Date.now(),
            isBackgrounded: true,
            toolUseId: callId,
          });
          chain = chain.emitBackgroundLaunch({
            toolCallId: callId,
            agentId,
            subagentName: "general-purpose",
            taskDescription: description,
          });
        }
        // `hold` parks the MAIN turn: no terminal frame at all, so the turn is
        // still running while both agents work — the Stop leg's precondition.
        if (control.backgroundAgents.hold) return;
        chain.emitText(responseText).respondOk("end_turn");
        return;
      }
      // ru-code (live-issues T1): the slow streaming baseline.
      if (control.stream) {
        let chain = opened;
        for (let index = 0; index < control.stream.chunks; index += 1) {
          chain = chain
            .emitText(`${responseText} [${String(index + 1)}]\n`)
            .sleep(control.stream.gapMs);
        }
        chain.respondOk("end_turn");
        return;
      }
      if (control.subAgent) {
        const withAgent = scriptSubAgentRun(opened, control.subAgent);
        // No settling frame ⇒ the turn parks: the row can only be closed by the
        // Stop button's server-side settle, which is exactly what that leg pins.
        if (!control.subAgent.settle) return;
        withAgent.emitText(responseText).respondOk("end_turn");
        return;
      }
      opened.emitText(responseText).respondOk("end_turn");
    },
  };
}

const scenarioId = process.env["RU_CODE_FAKE_ACP"] ?? "OK";
const script = SCENARIOS[scenarioId] ?? SCENARIOS["OK"]!;

// Bridge Node process.stdin → an Effect queue the agent reads. This wiring lives at
// MODULE scope (the Node event-loop ↔ Effect boundary), so `Effect.runSync` here is
// a legitimate top-level run, not a nested one inside a surrounding Effect.
const stdinQueue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done<void>>());
process.stdin.on("data", (chunk: Buffer) => {
  Effect.runSync(Queue.offer(stdinQueue, new Uint8Array(chunk)).pipe(Effect.asVoid));
});
process.stdin.on("end", () => {
  Effect.runSync(Queue.end(stdinQueue).pipe(Effect.asVoid));
});

const stdio = Stdio.make({
  args: Effect.succeed([]),
  stdin: Stream.fromQueue(stdinQueue),
  stdout: () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        fakeLog(`OUT ${text.slice(0, 100).replaceAll("\n", "\\n")}`);
        process.stdout.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
      }),
    ),
  stderr: () => Sink.drain,
});

const controls = {
  writeRaw: (bytes: string) =>
    Effect.sync(() => {
      process.stdout.write(bytes);
    }),
  // Over a real pipe we exit the process (see header note).
  closeTransport: Effect.sync(() => process.exit(1)),
  exit: (code: number) => Effect.sync(() => process.exit(code)),
};

const program = Effect.scoped(
  Effect.gen(function* () {
    process.stderr.write(`[fake-acp-server] serving scenario ${scenarioId}\n`);
    yield* runFakeAcpAgent(stdio, script, controls);
    return yield* Effect.never; // keep serving until the parent kills us
  }),
);

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`[fake-acp-server] fatal: ${String(error)}\n`);
  process.exit(1);
});
