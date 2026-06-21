import { assert, it } from "@effect/vitest";

import { extractFileTelemetry } from "../../../src/ru-fork/stats/telemetry.ts";

// One ui_telemetry system record around a given uiEvent.
const telemetryLine = (uiEvent: Record<string, unknown>, base: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    cwd: "/Users/u/WORKSPACE/Projects/app",
    gitBranch: "main",
    sessionId: "sess-1",
    timestamp: "2026-06-10T10:00:00.000Z",
    ...base,
    systemPayload: { uiEvent },
  });

const apiResponse = (overrides: Record<string, unknown> = {}) => ({
  "event.name": "qwen-code.api_response",
  "event.timestamp": "2026-06-10T10:00:00.000Z",
  model: "qwen/qwen3.6-35b-a3b",
  input_token_count: 1000,
  output_token_count: 50,
  cached_content_token_count: 0,
  thoughts_token_count: 5,
  duration_ms: 8000,
  prompt_id: "sess-1########1",
  ...overrides,
});

it("extracts api_response token + latency fields", () => {
  const { events } = extractFileTelemetry(telemetryLine(apiResponse()));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.kind, "api_response");
  if (event.kind !== "api_response") return;
  assert.equal(event.inputTokens, 1000);
  assert.equal(event.outputTokens, 50);
  assert.equal(event.thinkingTokens, 5);
  assert.equal(event.cachedTokens, 0);
  assert.equal(event.durationMs, 8000);
  assert.equal(event.model, "qwen/qwen3.6-35b-a3b");
  assert.equal(event.promptId, "sess-1########1");
});

it("defaults missing numeric fields to 0", () => {
  const { events } = extractFileTelemetry(
    telemetryLine({ "event.name": "qwen-code.api_response", "event.timestamp": "2026-06-10T10:00:00.000Z" }),
  );
  const [event] = events;
  if (event.kind !== "api_response") throw new Error("expected api_response");
  assert.equal(event.inputTokens, 0);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.model, undefined);
});

it("extracts tool_call success + decision", () => {
  const text = [
    telemetryLine({ "event.name": "qwen-code.tool_call", "event.timestamp": "2026-06-10T10:00:01.000Z", function_name: "write_file", success: true, decision: "auto_accept" }),
    telemetryLine({ "event.name": "qwen-code.tool_call", "event.timestamp": "2026-06-10T10:00:02.000Z", function_name: "run_shell_command", success: false, decision: "reject" }),
  ].join("\n");
  const { events } = extractFileTelemetry(text);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => (event.kind === "tool_call" ? [event.functionName, event.success, event.decision] : null)),
    [["write_file", true, "auto_accept"], ["run_shell_command", false, "reject"]],
  );
});

it("drops a tool_call with no function_name", () => {
  const { events } = extractFileTelemetry(
    telemetryLine({ "event.name": "qwen-code.tool_call", "event.timestamp": "2026-06-10T10:00:01.000Z" }),
  );
  assert.equal(events.length, 0);
});

it("defaults tool_call success to true and decision to undefined when absent", () => {
  const { events } = extractFileTelemetry(
    telemetryLine({ "event.name": "qwen-code.tool_call", "event.timestamp": "2026-06-10T10:00:01.000Z", function_name: "read_file" }),
  );
  const [event] = events;
  if (event.kind !== "tool_call") throw new Error("expected tool_call");
  assert.equal(event.success, true);
  assert.equal(event.decision, undefined);
});

it("extracts api_error type and defaults unknown", () => {
  const text = [
    telemetryLine({ "event.name": "qwen-code.api_error", "event.timestamp": "2026-06-10T10:00:03.000Z", error_type: "APIUserAbortError" }),
    telemetryLine({ "event.name": "qwen-code.api_error", "event.timestamp": "2026-06-10T10:00:04.000Z" }),
  ].join("\n");
  const { events } = extractFileTelemetry(text);
  assert.deepEqual(
    events.map((event) => (event.kind === "api_error" ? event.errorType : null)),
    ["APIUserAbortError", "UnknownError"],
  );
});

it("ignores unknown ui_telemetry event names and non-telemetry records", () => {
  const text = [
    telemetryLine({ "event.name": "qwen-code.next_speaker_check", "event.timestamp": "2026-06-10T10:00:00.000Z" }),
    JSON.stringify({ type: "user", message: { parts: [] }, cwd: "/x", sessionId: "s", timestamp: "t" }),
  ].join("\n");
  const { events } = extractFileTelemetry(text);
  assert.equal(events.length, 0);
});

it("skips malformed + blank lines without throwing (one bad line never poisons)", () => {
  const text = ["{ not json", "", "   ", telemetryLine(apiResponse())].join("\n");
  const { events } = extractFileTelemetry(text);
  assert.equal(events.length, 1);
});

it("captures cwd (first), branch (last), sessionId (first)", () => {
  const text = [
    telemetryLine(apiResponse(), { cwd: "/a", gitBranch: "feat/x", sessionId: "s1" }),
    telemetryLine(apiResponse(), { cwd: "/b", gitBranch: "main", sessionId: "s2" }),
  ].join("\n");
  const { cwd, branch, sessionId } = extractFileTelemetry(text);
  assert.equal(cwd, "/a");
  assert.equal(branch, "main");
  assert.equal(sessionId, "s1");
});

it("returns empty telemetry for empty text", () => {
  const result = extractFileTelemetry("");
  assert.equal(result.events.length, 0);
  assert.equal(result.cwd, undefined);
});

it("captures the first user message text (string and {parts} shapes)", () => {
  const partsLine = JSON.stringify({ type: "user", message: { role: "user", parts: [{ text: "You write concise titles" }] } });
  assert.equal(extractFileTelemetry(partsLine).firstUserText, "You write concise titles");
  const stringLine = JSON.stringify({ type: "user", message: "hello there" });
  assert.equal(extractFileTelemetry(stringLine).firstUserText, "hello there");
  assert.equal(extractFileTelemetry(telemetryLine(apiResponse())).firstUserText, undefined);
});
