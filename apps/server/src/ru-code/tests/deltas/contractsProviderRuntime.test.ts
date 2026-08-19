// ru-code: coverage for our additive deltas to the provider-runtime contracts —
// the `"plan_approval"` CanonicalRequestType member (qwen's exit_plan_mode
// held approval) and the optional `tone` on `task.completed` payloads (the
// near-no-op-compaction warning row).
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CanonicalRequestType, ProviderRuntimeEvent } from "@t3tools/contracts";

const decodeCanonicalRequestType = Schema.decodeUnknownSync(CanonicalRequestType);
const isCanonicalRequestType = Schema.is(CanonicalRequestType);
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

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
  const taskCompletedEvent = (payload: Record<string, unknown>) => ({
    type: "task.completed",
    eventId: "evt-1",
    provider: "qwen",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { taskId: "context-compaction:abc", status: "completed", ...payload },
  });

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
