import { describe, expect, it } from "vitest";

import {
  normalizeRecord,
  parseAndNormalize,
  parseTranscriptJsonl,
} from "../../../src/ru-fork/qwen-transcript/parse.ts";

const baseRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work",
  ...over,
});

describe("parseTranscriptJsonl", () => {
  it("parses one object per line and skips blank lines", () => {
    const text = '{"a":1}\n\n  \n{"b":2}\n';
    const { rows, errorCount } = parseTranscriptJsonl(text);
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errorCount).toBe(0);
  });

  it("counts malformed lines and skips them", () => {
    const text = '{"a":1}\n{not json}\n{"b":2}';
    const { rows, errorCount } = parseTranscriptJsonl(text);
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errorCount).toBe(1);
  });

  it("counts non-object JSON values as errors", () => {
    const { rows, errorCount } = parseTranscriptJsonl("123\n[1,2]\n{\"ok\":true}");
    expect(rows).toEqual([{ ok: true }]);
    expect(errorCount).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(parseTranscriptJsonl("")).toEqual({ rows: [], errorCount: 0 });
  });
});

describe("normalizeRecord — base validation", () => {
  it("returns null without uuid/sessionId/timestamp", () => {
    expect(normalizeRecord({ type: "user" })).toBeNull();
    expect(normalizeRecord({ type: "user", uuid: "u" })).toBeNull();
    expect(normalizeRecord({ type: "user", uuid: "u", sessionId: "s" })).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(normalizeRecord(baseRow({ type: "mystery" }))).toBeNull();
  });

  it("keeps a string parentUuid and defaults non-strings to null", () => {
    const withParent = normalizeRecord(baseRow({ type: "user", parentUuid: "p1" }));
    expect(withParent?.parentUuid).toBe("p1");
    const noParent = normalizeRecord(baseRow({ type: "user", parentUuid: 42 }));
    expect(noParent?.parentUuid).toBeNull();
  });

  it("carries gitBranch only when present", () => {
    expect(normalizeRecord(baseRow({ type: "user", gitBranch: "main" }))).toMatchObject({
      gitBranch: "main",
    });
    expect(normalizeRecord(baseRow({ type: "user" }))).not.toHaveProperty("gitBranch");
  });
});

describe("normalizeRecord — parts", () => {
  it("normalizes text / thought / function_call / function_response / inline_data / unknown", () => {
    const record = normalizeRecord(
      baseRow({
        type: "user",
        message: {
          parts: [
            { text: "hello" },
            { thought: true, text: "thinking" },
            { functionCall: { name: "Edit", args: { file: "a" } } },
            { functionResponse: { name: "Edit", response: { ok: true } } },
            { inlineData: { mimeType: "image/png" } },
            { somethingElse: 1 },
            "raw-string",
          ],
        },
      }),
    );
    expect(record?.type).toBe("user");
    expect(record && "parts" in record ? record.parts : []).toEqual([
      { kind: "text", text: "hello" },
      { kind: "thought", text: "thinking" },
      { kind: "function_call", name: "Edit", args: { file: "a" } },
      { kind: "function_response", name: "Edit", response: { ok: true } },
      { kind: "inline_data", mimeType: "image/png" },
      { kind: "unknown", raw: { somethingElse: 1 } },
      { kind: "unknown", raw: "raw-string" },
    ]);
  });

  it("returns [] parts when message is missing or parts is not an array", () => {
    expect(normalizeRecord(baseRow({ type: "user" }))).toMatchObject({ parts: [] });
    expect(normalizeRecord(baseRow({ type: "user", message: { parts: "nope" } }))).toMatchObject({
      parts: [],
    });
  });

  it("defaults a thought part with no text to empty string", () => {
    const record = normalizeRecord(
      baseRow({ type: "user", message: { parts: [{ thought: true }] } }),
    );
    expect(record && "parts" in record ? record.parts : []).toEqual([{ kind: "thought", text: "" }]);
  });
});

describe("normalizeRecord — assistant", () => {
  it("maps model, contextWindowSize and usage", () => {
    const record = normalizeRecord(
      baseRow({
        type: "assistant",
        model: "claude-opus-4",
        contextWindowSize: 200000,
        usageMetadata: {
          promptTokenCount: 10,
          cachedInputTokenCount: 2,
          candidatesTokenCount: 5,
          totalTokenCount: 17,
        },
      }),
    );
    expect(record).toMatchObject({
      type: "assistant",
      model: "claude-opus-4",
      contextWindowSize: 200000,
      usage: { promptTokens: 10, cachedTokens: 2, outputTokens: 5, totalTokens: 17 },
    });
  });

  it("omits usage when usageMetadata is absent or empty", () => {
    expect(normalizeRecord(baseRow({ type: "assistant" }))).not.toHaveProperty("usage");
    expect(normalizeRecord(baseRow({ type: "assistant", usageMetadata: {} }))).not.toHaveProperty(
      "usage",
    );
  });
});

describe("normalizeRecord — tool_result display variants", () => {
  const toolResult = (resultDisplay: unknown, extra: Record<string, unknown> = {}) =>
    normalizeRecord(
      baseRow({ type: "tool_result", toolCallResult: { callId: "c1", status: "success", resultDisplay, ...extra } }),
    );

  it("string display → text", () => {
    expect(toolResult("done")).toMatchObject({
      toolCall: { callId: "c1", status: "success", display: { kind: "text", text: "done" } },
    });
  });

  it("file_diff display", () => {
    expect(
      toolResult({
        fileName: "a.ts",
        fileDiff: "@@",
        originalContent: "old",
        newContent: "new",
        diffStat: { added: 1 },
      }),
    ).toMatchObject({
      toolCall: {
        display: {
          kind: "file_diff",
          fileName: "a.ts",
          fileDiff: "@@",
          originalContent: "old",
          newContent: "new",
          diffStat: { added: 1 },
        },
      },
    });
  });

  it("file_diff with non-string originalContent becomes null", () => {
    const record = toolResult({ fileName: "a", fileDiff: "d", newContent: "n" });
    const display = record && "toolCall" in record ? record.toolCall?.display : undefined;
    expect(display).toMatchObject({ kind: "file_diff", originalContent: null });
  });

  it("todo_list display (with invalid status defaulting to pending)", () => {
    const record = toolResult({
      type: "todo_list",
      todos: [
        { id: "1", content: "a", status: "completed" },
        { id: "2", content: "b", status: "bogus" },
        "not-an-object",
      ],
    });
    const display = record && "toolCall" in record ? record.toolCall?.display : undefined;
    expect(display).toEqual({
      kind: "todo_list",
      todos: [
        { id: "1", content: "a", status: "completed" },
        { id: "2", content: "b", status: "pending" },
      ],
    });
  });

  it("plan_summary display (+ rejected)", () => {
    expect(
      toolResult({ type: "plan_summary", message: "m", plan: "p", rejected: true }),
    ).toMatchObject({ toolCall: { display: { kind: "plan_summary", message: "m", plan: "p", rejected: true } } });
  });

  it("task_execution display (+ result + toolCalls)", () => {
    expect(
      toolResult({
        type: "task_execution",
        subagentName: "explorer",
        status: "completed",
        taskDescription: "look",
        result: "found",
        toolCalls: [{ callId: "x" }],
      }),
    ).toMatchObject({
      toolCall: {
        display: {
          kind: "task_execution",
          subagentName: "explorer",
          status: "completed",
          taskDescription: "look",
          result: "found",
          toolCalls: [{ callId: "x" }],
        },
      },
    });
  });

  it("mcp_tool_progress display (+ total + message)", () => {
    expect(
      toolResult({ type: "mcp_tool_progress", progress: 3, total: 10, message: "half" }),
    ).toMatchObject({
      toolCall: { display: { kind: "mcp_progress", progress: 3, total: 10, message: "half" } },
    });
  });

  it("ansiOutput display → ansi", () => {
    expect(toolResult({ ansiOutput: [["x"]] })).toMatchObject({
      toolCall: { display: { kind: "ansi", raw: [["x"]] } },
    });
  });

  it("unrecognized object display → unknown", () => {
    expect(toolResult({ type: "future_kind" })).toMatchObject({
      toolCall: { display: { kind: "unknown" } },
    });
  });

  it("drops an invalid status and omits display when absent", () => {
    const record = normalizeRecord(
      baseRow({ type: "tool_result", toolCallResult: { callId: "c", status: "bogus" } }),
    );
    const toolCall = record && "toolCall" in record ? record.toolCall : undefined;
    expect(toolCall).toEqual({ callId: "c" });
  });

  it("omits toolCall entirely when toolCallResult is absent", () => {
    expect(normalizeRecord(baseRow({ type: "tool_result" }))).not.toHaveProperty("toolCall");
  });
});

describe("normalizeRecord — system", () => {
  it("keeps a known subtype and payload", () => {
    expect(
      normalizeRecord(
        baseRow({ type: "system", subtype: "chat_compression", systemPayload: { info: 1 } }),
      ),
    ).toMatchObject({ type: "system", subtype: "chat_compression", payload: { info: 1 } });
  });

  it("drops an unknown subtype but stays a system record", () => {
    const record = normalizeRecord(baseRow({ type: "system", subtype: "future" }));
    expect(record).toMatchObject({ type: "system" });
    expect(record).not.toHaveProperty("subtype");
  });
});

describe("normalizeRecord — defensive defaults for missing fields", () => {
  const display = (resultDisplay: unknown) => {
    const record = normalizeRecord(baseRow({ type: "tool_result", toolCallResult: { resultDisplay } }));
    return record && "toolCall" in record ? record.toolCall?.display : undefined;
  };

  it("defaults cwd to empty string when absent", () => {
    const record = normalizeRecord({ uuid: "u", sessionId: "s", timestamp: "t", type: "user" });
    expect(record).toMatchObject({ cwd: "" });
  });

  it("defaults function_call / function_response / inline_data fields when absent", () => {
    const record = normalizeRecord(
      baseRow({
        type: "user",
        message: { parts: [{ functionCall: {} }, { functionResponse: {} }, { inlineData: {} }] },
      }),
    );
    expect(record && "parts" in record ? record.parts : []).toEqual([
      { kind: "function_call", name: "", args: undefined },
      { kind: "function_response", name: "", response: undefined },
      { kind: "inline_data", mimeType: "" },
    ]);
  });

  it("plan_summary with no fields → empty strings, no rejected", () => {
    expect(display({ type: "plan_summary" })).toEqual({ kind: "plan_summary", message: "", plan: "" });
  });

  it("task_execution with no optionals → empty strings, no result/toolCalls", () => {
    expect(display({ type: "task_execution" })).toEqual({
      kind: "task_execution",
      subagentName: "",
      status: "",
      taskDescription: "",
    });
  });

  it("mcp_tool_progress with no fields → progress 0, no total/message", () => {
    expect(display({ type: "mcp_tool_progress" })).toEqual({ kind: "mcp_progress", progress: 0 });
  });

  it("todo_list with non-array todos → unknown", () => {
    expect(display({ type: "todo_list" })).toMatchObject({ kind: "unknown" });
  });

  it("file_diff with no fileName/newContent → empty strings, null original", () => {
    expect(display({ fileDiff: "@@" })).toEqual({
      kind: "file_diff",
      fileName: "",
      fileDiff: "@@",
      originalContent: null,
      newContent: "",
    });
  });

  it("todo_list maps the in_progress status", () => {
    expect(display({ type: "todo_list", todos: [{ id: "1", content: "c", status: "in_progress" }] })).toEqual({
      kind: "todo_list",
      todos: [{ id: "1", content: "c", status: "in_progress" }],
    });
  });

  it("non-object, non-string display → unknown", () => {
    expect(display(42)).toEqual({ kind: "unknown", raw: 42 });
  });

  it("todo item missing id/content → empty strings", () => {
    expect(display({ type: "todo_list", todos: [{ status: "completed" }] })).toEqual({
      kind: "todo_list",
      todos: [{ id: "", content: "", status: "completed" }],
    });
  });
});

describe("parseAndNormalize", () => {
  it("parses + normalizes + drops unusable rows in order", () => {
    const text = [
      JSON.stringify(baseRow({ uuid: "a", type: "user", message: { parts: [{ text: "hi" }] } })),
      JSON.stringify({ type: "user" }), // missing ids → dropped
      "{bad json}", // malformed → dropped
      JSON.stringify(baseRow({ uuid: "b", type: "assistant", model: "m" })),
    ].join("\n");
    const records = parseAndNormalize(text);
    expect(records.map((r) => r.uuid)).toEqual(["a", "b"]);
    expect(records[0]?.type).toBe("user");
    expect(records[1]?.type).toBe("assistant");
  });
});
