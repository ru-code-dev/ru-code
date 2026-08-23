// ru-code: coverage for our additive deltas to the provider-runtime contracts —
// the `"plan_approval"` CanonicalRequestType member (qwen's exit_plan_mode
// held approval) and the optional `tone` on `task.completed` payloads (the
// near-no-op-compaction warning row).
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CONTEXT_COMPACTION_TASK_TYPE } from "@ru-code/branding";
import {
  CanonicalRequestType,
  classifyTaskAgentKind,
  INERT_TASK_TYPES,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";

const decodeCanonicalRequestType = Schema.decodeUnknownSync(CanonicalRequestType);
const isCanonicalRequestType = Schema.is(CanonicalRequestType);
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

// ru-code: hoisted to module scope (was nested inside the describe below) so the
// context_compaction delta block appended at the end of this file can reuse it
// too — same helper, same intent, no new Schema.decode* call inside a function body.
const taskCompletedEvent = (payload: Record<string, unknown>) => ({
  type: "task.completed",
  eventId: "evt-1",
  provider: "qwen",
  threadId: "thread-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { taskId: "context-compaction:abc", status: "completed", ...payload },
});

describe("CanonicalRequestType — ru-code plan_approval delta", () => {
  it("decodes the added `plan_approval` member", () => {
    const decoded = decodeCanonicalRequestType("plan_approval");
    expect(decoded).toBe("plan_approval");
  });

  it("accepts `plan_approval` via Schema.is", () => {
    expect(isCanonicalRequestType("plan_approval")).toBe(true);
  });

  it("still rejects a non-member request type", () => {
    expect(isCanonicalRequestType("not_a_request_type")).toBe(false);
  });

  it("preserves an upstream member alongside the delta", () => {
    expect(isCanonicalRequestType("command_execution_approval")).toBe(true);
  });
});

describe("task.completed payload — ru-code optional tone delta", () => {
  it("decodes the warning tone override", () => {
    const decoded = decodeRuntimeEvent(taskCompletedEvent({ tone: "warning", summary: "x" }));
    if (decoded.type !== "task.completed") throw new Error("wrong variant");
    expect(decoded.payload.tone).toBe("warning");
  });

  it("old persisted events without tone decode unchanged (backcompat)", () => {
    const decoded = decodeRuntimeEvent(taskCompletedEvent({ summary: "x" }));
    if (decoded.type !== "task.completed") throw new Error("wrong variant");
    expect(decoded.payload.tone).toBeUndefined();
    expect(decoded.payload.status).toBe("completed");
  });

  it("rejects a tone outside the info|warning union", () => {
    expect(() => decodeRuntimeEvent(taskCompletedEvent({ tone: "error" }))).toThrow();
  });

  it("decodes the optional detail body alongside the summary title", () => {
    const decoded = decodeRuntimeEvent(
      taskCompletedEvent({ summary: "Заголовок", detail: "Развёрнутое пояснение." }),
    );
    if (decoded.type !== "task.completed") throw new Error("wrong variant");
    expect(decoded.payload.summary).toBe("Заголовок");
    expect(decoded.payload.detail).toBe("Развёрнутое пояснение.");
  });

  it("old persisted events without detail decode unchanged (backcompat)", () => {
    const decoded = decodeRuntimeEvent(taskCompletedEvent({ summary: "x" }));
    if (decoded.type !== "task.completed") throw new Error("wrong variant");
    expect(decoded.payload.detail).toBeUndefined();
  });
});

describe("INERT_TASK_TYPES — ru-code context_compaction delta", () => {
  it("contains the compaction task type", () => {
    expect(INERT_TASK_TYPES.has(CONTEXT_COMPACTION_TASK_TYPE)).toBe(true);
  });

  it("preserves the upstream members", () => {
    expect(INERT_TASK_TYPES.has("plan")).toBe(true);
    expect(INERT_TASK_TYPES.has("dream")).toBe(true);
  });

  it("classifies the compaction as background, not an agent", () => {
    // The whole point of the delta: without the member this returns "agent" and
    // the compaction lands in the Agents panel instead of the chat.
    expect(classifyTaskAgentKind({ taskType: CONTEXT_COMPACTION_TASK_TYPE })).toBe("background");
  });

  it("leaves a real subagent task type classified as an agent", () => {
    expect(classifyTaskAgentKind({ taskType: "subagent" })).toBe("agent");
    expect(classifyTaskAgentKind({})).toBe("agent");
  });

  it("decodes the taskType on both compaction payloads with no schema change", () => {
    const progress = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "evt-1",
      provider: "qwen",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        taskId: "context-compaction:abc",
        description: "Compacting context…",
        taskType: CONTEXT_COMPACTION_TASK_TYPE,
      },
    });
    if (progress.type !== "task.progress") throw new Error("wrong variant");
    expect(progress.payload.taskType).toBe(CONTEXT_COMPACTION_TASK_TYPE);

    const completed = decodeRuntimeEvent(
      taskCompletedEvent({ summary: "ok", taskType: CONTEXT_COMPACTION_TASK_TYPE }),
    );
    if (completed.type !== "task.completed") throw new Error("wrong variant");
    expect(completed.payload.taskType).toBe(CONTEXT_COMPACTION_TASK_TYPE);
  });
});
