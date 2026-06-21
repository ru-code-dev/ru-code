import { assert, it } from "@effect/vitest";

import { aggregateSession } from "../../../src/ru-fork/stats/aggregate.ts";
import type { FileTelemetry, TelemetryEvent } from "../../../src/ru-fork/stats/telemetry.ts";

const NOW = "2026-06-17T12:00:00.000Z";

const makeSession = (events: ReadonlyArray<TelemetryEvent>, overrides: Partial<FileTelemetry> = {}) =>
  aggregateSession({
    telemetry: {
      events,
      cwd: "/Users/u/WORKSPACE/Projects/app",
      branch: "main",
      sessionId: "sess-1",
      firstUserText: undefined,
      ...overrides,
    },
    projectDir: "-Users-u-WORKSPACE-Projects-app",
    fileSessionId: "file-sess",
    nowIso: NOW,
    timeZone: "UTC",
  });

const apiResponse = (overrides: Partial<Extract<TelemetryEvent, { kind: "api_response" }>> = {}): TelemetryEvent => ({
  kind: "api_response",
  timestamp: "2026-06-10T10:00:00.000Z",
  model: "qwen/qwen3.6-35b-a3b",
  inputTokens: 1000,
  outputTokens: 50,
  thinkingTokens: 5,
  cachedTokens: 0,
  durationMs: 8000,
  promptId: "sess-1########1",
  ...overrides,
});

it("sums tokens across api_response events", () => {
  const session = makeSession([apiResponse(), apiResponse({ inputTokens: 2000, outputTokens: 100 })]);
  assert.equal(session.tokens.input, 3000);
  assert.equal(session.tokens.output, 150);
  assert.equal(session.tokens.thinking, 10);
  assert.equal(session.tokens.cached, 0);
  assert.equal(session.apiCalls, 2);
});

it("computes avg + max latency", () => {
  const session = makeSession([apiResponse({ durationMs: 4000 }), apiResponse({ durationMs: 12000 })]);
  assert.equal(session.avgLatencyMs, 8000);
  assert.equal(session.maxLatencyMs, 12000);
});

it("counts distinct turns, excluding side-queries", () => {
  const session = makeSession([
    apiResponse({ promptId: "sess-1########1" }),
    apiResponse({ promptId: "sess-1########1" }), // same turn
    apiResponse({ promptId: "sess-1########2" }),
    apiResponse({ promptId: "side-query:auto-memory-recall" }), // excluded
  ]);
  assert.equal(session.turns, 2);
});

it("marks a fully side-query session as background", () => {
  const session = makeSession([apiResponse({ promptId: "side-query:a" }), apiResponse({ promptId: "side-query:b" })]);
  assert.equal(session.isBackground, true);
  assert.equal(session.turns, 0);
});

it("a session with any real turn is not background", () => {
  const session = makeSession([apiResponse({ promptId: "side-query:a" }), apiResponse({ promptId: "sess-1########1" })]);
  assert.equal(session.isBackground, false);
});

it("aggregates tool calls, failures, and approval decisions", () => {
  const session = makeSession([
    { kind: "tool_call", timestamp: "t", functionName: "write_file", success: true, decision: "auto_accept" },
    { kind: "tool_call", timestamp: "t", functionName: "write_file", success: false, decision: undefined },
    { kind: "tool_call", timestamp: "t", functionName: "run_shell_command", success: false, decision: "reject" },
  ]);
  assert.deepEqual(session.toolCounts, { write_file: 2, run_shell_command: 1 });
  assert.deepEqual(session.toolFailures, { write_file: 1, run_shell_command: 1 });
  assert.equal(session.autoAccepted, 1);
  assert.equal(session.rejected, 1);
});

it("aggregates error types", () => {
  const session = makeSession([
    { kind: "api_error", timestamp: "t", errorType: "APIError" },
    { kind: "api_error", timestamp: "t", errorType: "APIError" },
    { kind: "api_error", timestamp: "t", errorType: "BadRequestError" },
  ]);
  assert.deepEqual(session.errorTypes, { APIError: 2, BadRequestError: 1 });
});

it("derives time span + duration from event timestamps", () => {
  const session = makeSession([
    apiResponse({ timestamp: "2026-06-10T10:00:00.000Z" }),
    apiResponse({ timestamp: "2026-06-10T10:05:00.000Z" }),
  ]);
  assert.equal(session.startedAt, "2026-06-10T10:00:00.000Z");
  assert.equal(session.durationMs, 300000);
});

it("buckets tokens by UTC day across multiple days", () => {
  const session = makeSession([
    apiResponse({ timestamp: "2026-06-19T10:00:00.000Z", inputTokens: 1000, outputTokens: 10 }),
    apiResponse({ timestamp: "2026-06-19T14:00:00.000Z", inputTokens: 2000, outputTokens: 20 }),
    apiResponse({ timestamp: "2026-06-20T09:00:00.000Z", inputTokens: 500, outputTokens: 5 }),
  ]);
  assert.deepEqual(session.tokensByDay["2026-06-19"], { input: 3000, output: 30, thinking: 10, cached: 0, apiCalls: 2 });
  assert.deepEqual(session.tokensByDay["2026-06-20"], { input: 500, output: 5, thinking: 5, cached: 0, apiCalls: 1 });
});

it("buckets visible tokens by weekday:hour (Mon=0, UTC)", () => {
  // 2026-06-19 is a Friday (weekday 4); 10:00Z → slot "4:10".
  const session = makeSession([apiResponse({ timestamp: "2026-06-19T10:00:00.000Z", inputTokens: 1000, outputTokens: 50, thinkingTokens: 5 })]);
  assert.equal(session.tokensByWeekdayHour["4:10"], 1055);
});

it("records an activity day even for a token-less event (api_error)", () => {
  const session = makeSession([{ kind: "api_error", timestamp: "2026-06-19T10:00:00.000Z", errorType: "APIError" }]);
  assert.deepEqual(session.tokensByDay["2026-06-19"], { input: 0, output: 0, thinking: 0, cached: 0, apiCalls: 0 });
  assert.equal(Object.keys(session.tokensByWeekdayHour).length, 0);
});

it("picks the dominant model", () => {
  const session = makeSession([
    apiResponse({ model: "qwen/a" }),
    apiResponse({ model: "qwen/b" }),
    apiResponse({ model: "qwen/b" }),
  ]);
  assert.equal(session.model, "qwen/b");
});

it("categorizes a real ######## turn as dialog", () => {
  const session = makeSession([apiResponse({ promptId: "sess-1########1" })]);
  assert.equal(session.category, "dialog");
  assert.equal(session.isBackground, false);
});

it("categorizes side-query / compress / subagent by prompt_id", () => {
  assert.equal(makeSession([apiResponse({ promptId: "side-query:auto-memory-recall" })]).category, "memory");
  assert.equal(makeSession([apiResponse({ promptId: "compress-3" })]).category, "compress");
  assert.equal(makeSession([apiResponse({ promptId: "uuid#Explore-abc#1" })]).category, "subagent");
});

it("categorizes our service prompts by content (title), and marks them background", () => {
  const session = makeSession([apiResponse({ promptId: "0a15340de2a" })], {
    firstUserText: "You write concise titles for coding conversations. Reply in Russian.",
  });
  assert.equal(session.category, "title");
  assert.equal(session.isBackground, true);
  assert.equal(session.turns, 0);
});

it("falls back to 'service' for an unrecognized one-shot", () => {
  const session = makeSession([apiResponse({ promptId: "deadbeef123" })], { firstUserText: "hi" });
  assert.equal(session.category, "service");
  assert.equal(session.isBackground, true);
});

it("classifies temp cwd as a sandbox project + labels by last segment", () => {
  const session = makeSession([apiResponse()], { cwd: "/var/folders/41/T/acp-test-xyz" });
  assert.equal(session.projectKind, "temp");
  assert.equal(session.projectLabel, "acp-test-xyz");
});

it("classifies a normal cwd as real + keeps project id from the dir", () => {
  const session = makeSession([apiResponse()]);
  assert.equal(session.projectKind, "real");
  assert.equal(session.projectLabel, "app");
  assert.equal(session.projectId, "-Users-u-WORKSPACE-Projects-app");
});

it("falls back to fileSessionId + nowIso for an empty file", () => {
  const session = aggregateSession({
    telemetry: { events: [], cwd: undefined, branch: undefined, sessionId: undefined, firstUserText: undefined },
    projectDir: "dir",
    fileSessionId: "abc",
    nowIso: NOW,
    timeZone: "UTC",
  });
  assert.equal(session.sessionId, "abc");
  assert.equal(session.startedAt, NOW);
  assert.equal(session.apiCalls, 0);
  assert.equal(session.avgLatencyMs, 0);
  // No real ######## turn → not a dialog (empties are ghost-skipped in production anyway).
  assert.equal(session.category, "service");
  assert.equal(session.isBackground, true);
  assert.equal(session.present, true);
  assert.equal(session.branch, "");
  assert.equal(session.model, "");
});
