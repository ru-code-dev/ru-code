// ru-fork: advanced chat mode — flatten qwen's record stream into a render-ready
// flow. One logical tool use is spread across THREE records (assistant
// functionCall + tool_result + ui_telemetry/tool_call); we merge them into a
// single ToolStep so the UI shows one card with args/diff/status/duration —
// including cancelled tools, which have NO tool_result (only a tool_call event).
// `api_response` telemetry is folded into the assistant line's latency.
import type { TranscriptPart, TranscriptToolDisplay } from "@t3tools/contracts";

import type {
  AssistantRecord,
  SystemRecord,
  ToolResultRecord,
  UserRecord,
} from "./transcriptTypes";

export type ToolStepStatus = "success" | "error" | "cancelled" | "running";

export interface ToolStep {
  readonly key: string;
  name: string;
  args: unknown;
  command: string | undefined;
  status: ToolStepStatus;
  durationMs: number | undefined;
  error: string | undefined;
  display: TranscriptToolDisplay | undefined;
  response: ReadonlyArray<TranscriptPart>;
}

export interface AssistantFlowItem {
  readonly kind: "assistant";
  readonly record: AssistantRecord;
  latencyMs: number | undefined;
  readonly tools: ToolStep[];
}

export type FlowItem =
  | { readonly kind: "user"; readonly record: UserRecord }
  | AssistantFlowItem
  | { readonly kind: "system"; readonly record: SystemRecord };

interface TelemetryEvent {
  readonly name: string;
  readonly durationMs: number | undefined;
  readonly status: string | undefined;
  readonly error: string | undefined;
  readonly functionName: string | undefined;
  readonly functionArgs: unknown;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function readTelemetry(record: SystemRecord): TelemetryEvent | null {
  if (record.subtype !== "ui_telemetry") return null;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const event = (payload as Record<string, unknown>)["uiEvent"];
  if (typeof event !== "object" || event === null) return null;
  const ev = event as Record<string, unknown>;
  return {
    name: asString(ev["event.name"]) ?? "",
    durationMs: asNumber(ev["duration_ms"]),
    status: asString(ev["status"]),
    error: asString(ev["error"]),
    functionName: asString(ev["function_name"]),
    functionArgs: ev["function_args"],
  };
}

function shellCommand(name: string, args: unknown): string | undefined {
  if (name !== "run_shell_command" || typeof args !== "object" || args === null) return undefined;
  return asString((args as Record<string, unknown>)["command"]);
}

function functionResponseName(record: ToolResultRecord): string | undefined {
  for (const part of record.parts) {
    if (part.kind === "function_response" && part.name.length > 0) return part.name;
  }
  return undefined;
}

export function buildTranscriptFlow(records: ReadonlyArray<unknown>): FlowItem[] {
  // records are TranscriptRecord; typed loosely to avoid a wide import union here.
  const items: FlowItem[] = [];
  let currentAssistant: AssistantFlowItem | null = null;
  let pendingLatencyMs: number | undefined;

  for (const raw of records) {
    const record = raw as { type: string } & Record<string, unknown>;

    if (record.type === "user") {
      currentAssistant = null;
      items.push({ kind: "user", record: raw as UserRecord });
      continue;
    }

    if (record.type === "assistant") {
      const assistant = raw as AssistantRecord;
      const tools: ToolStep[] = [];
      assistant.parts.forEach((part, index) => {
        if (part.kind === "function_call") {
          tools.push({
            key: `${assistant.uuid}-${index}`,
            name: part.name,
            args: part.args,
            command: shellCommand(part.name, part.args),
            status: "running",
            durationMs: undefined,
            error: undefined,
            display: undefined,
            response: [],
          });
        }
      });
      const item: AssistantFlowItem = {
        kind: "assistant",
        record: assistant,
        latencyMs: pendingLatencyMs,
        tools,
      };
      pendingLatencyMs = undefined;
      currentAssistant = item;
      items.push(item);
      continue;
    }

    if (record.type === "tool_result") {
      const result = raw as ToolResultRecord;
      const name = functionResponseName(result);
      const step = pickStep(currentAssistant, name, (candidate) => candidate.display === undefined);
      if (step) {
        step.display = result.toolCall?.display;
        step.response = result.parts.filter((part) => part.kind === "function_response");
        // A `tool_result` is written ONLY for a CompletedToolCall, whose status is
        // always success | error | cancelled (qwen coreToolScheduler.ts:165 +
        // checkAndNotifyCompletion gate :1583). Its presence is therefore terminal,
        // so anything that is not cancel/error resolves to success — a step that has
        // a result must never stay "running".
        const status = result.toolCall?.status;
        step.status =
          status === "cancelled" ? "cancelled" : status === "error" ? "error" : "success";
      }
      continue;
    }

    if (record.type === "system") {
      const telemetry = readTelemetry(raw as SystemRecord);
      if (!telemetry) {
        // compaction / slash_command / at_command — a real timeline divider.
        currentAssistant = null;
        items.push({ kind: "system", record: raw as SystemRecord });
        continue;
      }
      // Match by suffix, not the full `<cli>.` brand prefix, so a CLI rebrand
      // (e.g. "qwen-code." → "ru-code.") keeps working without a code change.
      if (telemetry.name.endsWith(".api_response")) {
        // Latency of the response that is about to be (or was just) emitted.
        pendingLatencyMs = telemetry.durationMs;
        if (currentAssistant && currentAssistant.latencyMs === undefined) {
          currentAssistant.latencyMs = telemetry.durationMs;
        }
      } else if (telemetry.name.endsWith(".tool_call")) {
        const step = pickStep(
          currentAssistant,
          telemetry.functionName,
          (candidate) => candidate.durationMs === undefined,
        );
        if (step) {
          step.durationMs = telemetry.durationMs;
          if (step.command === undefined) {
            step.command = shellCommand(step.name, telemetry.functionArgs);
          }
          if (telemetry.status === "error") {
            const cancelled = (telemetry.error ?? "").toLowerCase().includes("cancel");
            step.status = cancelled ? "cancelled" : "error";
            step.error = telemetry.error;
          } else if (telemetry.status === "success" && step.status === "running") {
            step.status = "success";
          }
        }
      }
      // any other telemetry event is intentionally ignored
      continue;
    }
  }

  return items;
}

/** First tool in the current assistant turn matching `name` (if given) for which
 *  `open` still holds — so call/result/telemetry land on the same step. */
function pickStep(
  assistant: AssistantFlowItem | null,
  name: string | undefined,
  open: (step: ToolStep) => boolean,
): ToolStep | undefined {
  if (!assistant) return undefined;
  const byName = name
    ? assistant.tools.find((step) => step.name === name && open(step))
    : undefined;
  return byName ?? assistant.tools.find(open);
}
