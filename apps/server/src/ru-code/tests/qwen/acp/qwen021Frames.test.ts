// ru-code (agents wave, phase 2): fidelity specs for the qwen 0.21.1 emitter
// TRANSCRIPTION (`fake-acp/qwen021Frames.ts`).
//
// The red v2 matrix asserts what our ADAPTER must do. This file asserts that
// the frames the matrix feeds it are the frames qwen actually emits — without
// it, the matrix would only prove we can satisfy our own guesses. Each spec
// pins a shape to the qwen src line it was copied from, so the next version
// bump fails here (a diffable byte) rather than in a vague integration test.
//
// Every expectation below is a FULL `toEqual` on the built object, not a field
// probe: an extra key qwen does not send is as wrong as a missing one, and only
// exact equality catches it.
import { describe, expect, it } from "vite-plus/test";

import {
  createTranscriptMessageUpdate,
  createTranscriptPlanUpdate,
  createTranscriptToolCallResultUpdate,
  createTranscriptUsageUpdate,
  qwenEmitAgentMessage,
  qwenEmitAgentThought,
  qwenEmitGoalStatus,
  qwenEmitGoalTerminal,
  qwenEmitPlan,
  qwenEmitStopHookLoop,
  qwenEmitToolCallResult,
  qwenEmitToolCallStart,
  qwenEmitUsageMetadata,
  resolveToolProvenance,
  toTranscriptEpochMs,
} from "../fake-acp/qwen021Frames.ts";

const META = { parentToolCallId: "call-agent-1", subagentType: "code-reviewer" };

describe("buildUpdateMeta semantics (transcript-replay.ts:171-188)", () => {
  // THE fact the whole wave rests on: `extra` is spread FLAT. Our production
  // reader (QwenAcpSubAgents.readQwenFrameMeta) looks at `_meta.parentToolCallId`,
  // and it is right to. `qwen-acp-contract-021.md` §1.6's `_meta.extra.usage`
  // claim is wrong — corrected in the phase-2 report.
  it("spreads subagent tags FLAT at the _meta root, never under an `extra` key", () => {
    const frame = qwenEmitAgentMessage("hello", undefined, META) as unknown as {
      _meta: Record<string, unknown>;
    };
    expect(frame._meta).toEqual(META);
    expect(frame._meta["extra"]).toBeUndefined();
  });

  it("omits _meta entirely for an untagged chunk (conditional spread, :202)", () => {
    expect(qwenEmitAgentMessage("hello")).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
  });

  // :184 — the key is only spread when the conversion yields a finite number,
  // so garbage does NOT become 0 (which would look like the epoch).
  it("converts a timestamp to epoch ms, and drops an unparseable one", () => {
    expect(toTranscriptEpochMs("2026-08-26T00:00:00.000Z")).toBe(
      Date.parse("2026-08-26T00:00:00.000Z"),
    );
    expect(toTranscriptEpochMs("not a date")).toBeUndefined();
    expect(toTranscriptEpochMs(Number.NaN)).toBeUndefined();
    expect(toTranscriptEpochMs(1234)).toBe(1234);
    const stamped = createTranscriptMessageUpdate({
      role: "assistant",
      text: "x",
      timestamp: "not a date",
    });
    expect(stamped).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x" },
    });
  });
});

describe("message chunks (MessageEmitter.ts:115-150 → transcript-replay.ts:190-204)", () => {
  it("the role/thought pair selects the variant", () => {
    expect(qwenEmitAgentMessage("a").sessionUpdate).toBe("agent_message_chunk");
    expect(qwenEmitAgentThought("a").sessionUpdate).toBe("agent_thought_chunk");
    expect(createTranscriptMessageUpdate({ role: "user", text: "a" }).sessionUpdate).toBe(
      "user_message_chunk",
    );
  });

  // The 0.21.1 fix in one assertion: at v0.13.1 `emitAgentThought` did not even
  // DECLARE a subagentMeta parameter, so a child's thinking was untaggable.
  it("a child's thought carries the subagent tag (new at 0.21.1)", () => {
    expect(qwenEmitAgentThought("thinking", undefined, META)).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
      _meta: META,
    });
  });
});

describe("usage frames (MessageEmitter.ts:170-237 → transcript-replay.ts:220-246)", () => {
  // The rename that will bite a careless port: `cachedContentTokenCount` becomes
  // `cachedReadTokens` HERE, while the Agent tool's rawOutput.executionSummary
  // spells the same idea `cachedTokens`. Two different structures, two spellings.
  it("renames the genai counters and keeps the first three unconditionally", () => {
    const frame = qwenEmitUsageMetadata({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
      thoughtsTokenCount: 7,
      cachedContentTokenCount: 50,
      durationMs: 900,
    }) as unknown as { _meta: { usage: Record<string, unknown> } };
    expect(frame._meta.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      thoughtTokens: 7,
      cachedReadTokens: 50,
    });
  });

  it("a missing counter becomes 0 for the required three, and drops the optional two", () => {
    const frame = createTranscriptUsageUpdate({}) as unknown as {
      _meta: { usage: Record<string, unknown> };
      content: { text: string };
    };
    expect(frame._meta.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    // A usage frame is an EMPTY-text agent_message_chunk — the shape a host that
    // only switches on non-empty text never sees.
    expect(frame.content.text).toBe("");
  });

  it("a child's usage rides the same frame, tagged, with durationMs alongside", () => {
    const frame = qwenEmitUsageMetadata({
      promptTokenCount: 4321,
      candidatesTokenCount: 0,
      totalTokenCount: 4321,
      durationMs: 0,
      subagentMeta: META,
    }) as unknown as { _meta: Record<string, unknown> };
    expect(frame._meta).toEqual({
      usage: { inputTokens: 4321, outputTokens: 0, totalTokens: 4321 },
      durationMs: 0,
      ...META,
    });
  });
});

describe("tool calls (tool-call-emitter.ts:80-205 → transcript-replay.ts:248-303)", () => {
  it("a subagent's tool call is stamped provenance:'subagent' plus both tags", () => {
    expect(
      qwenEmitToolCallStart({
        toolName: "read_file",
        callId: "call-inner-1",
        status: "pending",
        args: { absolute_path: "/a.ts" },
        title: "read_file: /a.ts",
        kind: "read",
        subagentMeta: META,
      }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "call-inner-1",
      status: "pending",
      title: "read_file: /a.ts",
      content: [],
      locations: [],
      kind: "read",
      rawInput: { absolute_path: "/a.ts" },
      _meta: { toolName: "read_file", provenance: "subagent", ...META },
    });
  });

  // resolveToolProvenance checks the OBJECT for `!== undefined`, so an empty
  // bundle still reads as a subagent (tool-call-emitter.ts:268-270).
  it("provenance: subagent beats mcp, a malformed mcp name falls back to builtin", () => {
    expect(resolveToolProvenance("mcp__github__list", META).provenance).toBe("subagent");
    expect(resolveToolProvenance("read_file", {})).toEqual({ provenance: "subagent" });
    expect(resolveToolProvenance("mcp__github__list")).toEqual({
      provenance: "mcp",
      serverId: "github",
    });
    expect(resolveToolProvenance("mcp__broken")).toEqual({ provenance: "builtin" });
    expect(resolveToolProvenance("read_file")).toEqual({ provenance: "builtin" });
  });

  // The Agent tool's OWN frame is top-level: provenance 'builtin', no tags, and
  // kind 'other' because ACP defines no 'agent' ToolKind (KIND_MAP :50).
  it("the agent ROOT call is a builtin 'other' with no subagent tags", () => {
    const frame = qwenEmitToolCallStart({
      toolName: "agent",
      callId: "call-agent-1",
      status: "in_progress",
      args: { description: "Review the diff", subagent_type: "code-reviewer" },
      title: "Agent: Review the diff",
    }) as unknown as { kind: string; _meta: Record<string, unknown> };
    expect(frame.kind).toBe("other");
    expect(frame._meta).toEqual({ toolName: "agent", provenance: "builtin" });
  });

  it("asUpdate flips the opening frame's variant to tool_call_update", () => {
    expect(
      qwenEmitToolCallStart({
        toolName: "read_file",
        callId: "c1",
        title: "t",
        asUpdate: true,
      }).sessionUpdate,
    ).toBe("tool_call_update");
  });

  // `rawOutput` is assigned by MUTATION after `_meta` (:300), so it is the LAST
  // key. A `null` display still passes the `!== undefined` gate.
  it("a result carries rawOutput last, and only when a display exists", () => {
    const withOutput = qwenEmitToolCallResult({
      toolName: "agent",
      callId: "call-agent-1",
      success: true,
      resultDisplay: { type: "task_execution", status: "completed" },
    });
    expect(Object.keys(withOutput).at(-1)).toBe("rawOutput");

    const withoutOutput = createTranscriptToolCallResultUpdate({
      toolName: "read_file",
      callId: "c1",
      success: false,
    });
    expect(Object.keys(withoutOutput)).not.toContain("rawOutput");
    expect((withoutOutput as unknown as { status: string }).status).toBe("failed");
  });
});

describe("plan frames (PlanEmitter.ts:27-39 → transcript-replay.ts:305-326)", () => {
  // THE GAP THAT SURVIVED 0.21.1: emitPlan takes no subagentMeta, so a child's
  // todo list is untagged on the wire and tag-keyed demux cannot attribute it.
  // Pinning it here means a future qwen that DOES tag plans fails this spec
  // loudly instead of silently changing our attribution story.
  it("a plan frame carries NO subagent tag — the window heuristic stays load-bearing", () => {
    expect(qwenEmitPlan([{ content: "read the files", status: "completed" }])).toEqual({
      sessionUpdate: "plan",
      entries: [{ content: "read the files", priority: "medium", status: "completed" }],
    });
  });

  it("priority is always 'medium' and the todo id is dropped", () => {
    const frame = createTranscriptPlanUpdate([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
    ]) as unknown as { entries: ReadonlyArray<Record<string, unknown>> };
    expect(frame.entries.every((entry) => entry["priority"] === "medium")).toBe(true);
    expect(frame.entries.some((entry) => "id" in entry)).toBe(false);
  });

  it("a cumulative-usage snapshot rides _meta.stats, shallow-copied", () => {
    const frame = createTranscriptPlanUpdate([{ content: "a", status: "pending" }], {
      promptTokens: 10,
    }) as unknown as { _meta: Record<string, unknown> };
    expect(frame._meta).toEqual({ stats: { promptTokens: 10 } });
  });
});

describe("signal frames (MessageEmitter.ts:37-86)", () => {
  // All three are EMPTY-text agent_message_chunks whose entire payload is
  // `_meta`. Hand-built in qwen (they bypass the transcript builder), so they
  // carry no timestamp and no qwenTranscript — pinned exactly.
  it("stopHookLoop is an empty-text chunk carrying only its _meta", () => {
    expect(
      qwenEmitStopHookLoop({ iterationCount: 2, reasons: ["todo open"], stopHookCount: 1 }),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: { stopHookLoop: { iterationCount: 2, reasons: ["todo open"], stopHookCount: 1 } },
    });
  });

  it("goalTerminal and goalStatus follow the identical envelope", () => {
    const terminal = { kind: "achieved" as const, condition: "c", iterations: 1, durationMs: 5 };
    expect(qwenEmitGoalTerminal(terminal)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: { goalTerminal: terminal },
    });
    const status = { kind: "set" as const, condition: "c" };
    expect(qwenEmitGoalStatus(status)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: { goalStatus: status },
    });
  });
});
