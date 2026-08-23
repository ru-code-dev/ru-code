// ru-code (P1 phantom-agent fix): a Qwen turn-level CLI-error row uses
// `task.completed` purely as a transport for the classified error text
// (Surface.Timeline) — it is bookkeeping, never an agent. Without the
// `cli_error` taskType stamp `classifyTaskAgentKind`'s denylist-default puts
// the error text in the Agents roster as a phantom subagent plus a spawn CTA
// (the owner-observed «Отработал 1 субагент · 1 с ошибкой»). Mirrors
// compactionTaskClassification.test.ts's pattern exactly, for the sibling fix.
import { CLI_ERROR_TASK_TYPE, QWEN_KIND } from "@ru-code/branding";
import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "../../../orchestration/Layers/ProviderRuntimeIngestion.ts";

const THREAD_ID = ThreadId.make("thread-cli-error-classify-1");
const TASK_ID = RuntimeTaskId.make("cli-error:turn-3f9c-abcd");
const base = { provider: ProviderDriverKind.make(QWEN_KIND), threadId: THREAD_ID };

const cliErrorEvent = (taskType?: string) =>
  ({
    ...base,
    type: "task.completed",
    eventId: EventId.make("evt-cli-error"),
    createdAt: "2026-08-24T00:00:00.000Z",
    payload: {
      taskId: TASK_ID,
      status: "failed",
      summary: "Превышен лимит запросов.",
      ...(taskType !== undefined ? { taskType } : {}),
    },
  }) satisfies ProviderRuntimeEvent;

describe("cli-error task rows — ingestion agentKind stamp", () => {
  it("stamps agentKind background on the stamped row (FIX-1, the AFTER shape)", () => {
    const [activity] = runtimeEventToActivities(cliErrorEvent(CLI_ERROR_TASK_TYPE));
    const payload = activity!.payload as Record<string, unknown>;
    expect(payload.agentKind).toBe("background");
    expect(payload.taskType).toBe(CLI_ERROR_TASK_TYPE);
    expect(payload.taskId).toBe(TASK_ID);
    expect(payload.summary).toBe("Превышен лимит запросов.");
  });

  it("without the taskType the same row is stamped `agent` (the pre-fix phantom shape)", () => {
    const [activity] = runtimeEventToActivities(cliErrorEvent());
    expect((activity!.payload as Record<string, unknown>).agentKind).toBe("agent");
  });
});
