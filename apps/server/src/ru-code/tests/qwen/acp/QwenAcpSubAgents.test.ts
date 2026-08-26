// ru-code: the sub-agent frame classifier — the whole feature's decision point.
// Frames are the REAL qwen shapes (qwen-code ToolCallEmitter.emitStart/emitResult
// and MessageEmitter.emitUsageMetadata), and the toolCall argument is what the
// port's parser actually produces for them, so a change in either side fails here
// rather than silently degrading the Agents panel.
import { describe, expect, it } from "vite-plus/test";

import { parseSessionUpdateEvent } from "../../../../provider/acp/AcpRuntimeModel.ts";
import {
  appendQwenAgentText,
  classifyQwenToolCallFrame,
  formatQwenAgentPlanLine,
  formatQwenAgentToolLine,
  formatQwenAgentWaitingLine,
  isQwenSubAgentFrame,
  openQwenAgentWindow,
  readQwenFrameMeta,
  takeQwenAgentLine,
  withQwenAgentAttribution,
  QWEN_AGENT_LINE_LIMIT,
  QWEN_AGENT_LINE_QUANTUM,
  QWEN_AGENT_TOOL_NAME,
  QWEN_SUBAGENT_TASK_TYPE,
} from "../../../qwen/acp/QwenAcpSubAgents.ts";

const SESSION_ID = "fake-acp-session";
const AGENT_CALL = "call-agent-1";
const INNER_CALL = "call-inner-1";
const SUBAGENT_TYPE = "code-reviewer";

const EXECUTION_SUMMARY = {
  rounds: 3,
  totalDurationMs: 4200,
  totalToolCalls: 5,
  successfulToolCalls: 5,
  failedToolCalls: 0,
  successRate: 1,
  inputTokens: 4321,
  outputTokens: 120,
  thoughtTokens: 7,
  cachedTokens: 100,
  totalTokens: 4441,
  toolUsage: [],
};

const notification = (update: Record<string, unknown>) =>
  ({ sessionId: SESSION_ID, update }) as never;

const agentStartFrame = notification({
  sessionUpdate: "tool_call",
  toolCallId: AGENT_CALL,
  status: "in_progress",
  title: "Agent: Review the diff",
  content: [],
  locations: [],
  kind: "other",
  rawInput: {
    description: "Review the diff",
    prompt: "look at it",
    subagent_type: SUBAGENT_TYPE,
    run_in_background: false,
  },
  _meta: { toolName: "agent" },
});

const agentDoneFrame = (overrides?: Record<string, unknown>) =>
  notification({
    sessionUpdate: "tool_call_update",
    toolCallId: AGENT_CALL,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Found 2 issues." } }],
    rawOutput: {
      type: "task_execution",
      subagentName: SUBAGENT_TYPE,
      taskDescription: "Review the diff",
      taskPrompt: "look at it",
      status: "completed",
      result: "Found 2 issues.",
      executionSummary: EXECUTION_SUMMARY,
      ...overrides,
    },
    _meta: { toolName: "agent" },
  });

const innerFrame = notification({
  sessionUpdate: "tool_call",
  toolCallId: INNER_CALL,
  status: "pending",
  title: "ReadFile: /a.ts",
  content: [],
  locations: [{ path: "/a.ts", line: null }],
  kind: "read",
  rawInput: { absolute_path: "/a.ts" },
  _meta: { toolName: "read_file", parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
});

const plainFrame = notification({
  sessionUpdate: "tool_call",
  toolCallId: "call-plain-1",
  status: "pending",
  title: "ReadFile: /b.ts",
  content: [],
  locations: [],
  kind: "read",
  rawInput: { absolute_path: "/b.ts" },
  _meta: { toolName: "read_file" },
});

// The classifier consumes what the PORT parser produces — never a hand-made state.
const classify = (frame: ReturnType<typeof notification>) => {
  const [parsed] = parseSessionUpdateEvent(frame).events;
  if (parsed?._tag !== "ToolCallUpdated") throw new Error("expected a ToolCallUpdated event");
  return classifyQwenToolCallFrame(parsed.toolCall, parsed.rawPayload);
};

describe("readQwenFrameMeta", () => {
  it("reads the three keys qwen stamps", () => {
    expect(readQwenFrameMeta(innerFrame)).toEqual({
      toolName: "read_file",
      parentToolCallId: AGENT_CALL,
      subagentType: SUBAGENT_TYPE,
    });
  });

  it("returns an empty bundle for anything that is not a tagged frame", () => {
    expect(readQwenFrameMeta(undefined)).toEqual({});
    expect(readQwenFrameMeta({})).toEqual({});
    expect(readQwenFrameMeta({ update: {} })).toEqual({});
    expect(readQwenFrameMeta({ update: { _meta: { toolName: "   " } } })).toEqual({});
    expect(readQwenFrameMeta({ update: { _meta: [1, 2] } })).toEqual({});
  });
});

describe("isQwenSubAgentFrame", () => {
  it("is true only when a parentToolCallId is present", () => {
    expect(isQwenSubAgentFrame(innerFrame)).toBe(true);
    expect(isQwenSubAgentFrame(agentStartFrame)).toBe(false);
    expect(isQwenSubAgentFrame(plainFrame)).toBe(false);
  });

  it("separates the sub-agent usage chunk from the thread's own", () => {
    const threadUsage = notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: { usage: { inputTokens: 111 }, durationMs: 1 },
    });
    const subAgentUsage = notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: {
        usage: { inputTokens: 4321 },
        durationMs: 1,
        parentToolCallId: AGENT_CALL,
        subagentType: SUBAGENT_TYPE,
      },
    });
    expect(isQwenSubAgentFrame(threadUsage)).toBe(false);
    expect(isQwenSubAgentFrame(subAgentUsage)).toBe(true);
  });
});

describe("classifyQwenToolCallFrame — the spawn-args background rule (FIX ROUND 2)", () => {
  // qwen decides background-ness from these args and says so:
  // `agent.ts:2506-2513` calls `agent.ts:2526-2536` "the source of truth for the
  // background-classification rule" and names the two UI classifiers that
  // replicate it from tool-call args. This table IS that rule
  // (`toolClassification.ts:39-51`), one row per axis it reads.
  const openingFrame = (rawInput: Record<string, unknown>) =>
    notification({
      sessionUpdate: "tool_call",
      toolCallId: AGENT_CALL,
      status: "in_progress",
      title: "Agent: Review the diff",
      content: [],
      locations: [],
      kind: "other",
      rawInput,
      _meta: { toolName: "agent" },
    });
  const base = { description: "Review the diff", prompt: "p", subagent_type: SUBAGENT_TYPE };

  it("the ARGLESS preparing frame opens no row — it cannot say what it is yet", () => {
    // tool-call-preparation-tracker.ts:41 sends `args: {}`, and :43 marks it
    // `phase: 'preparing'`. Every `undefined` in the rule is satisfied, so the
    // rule's own answer is "background" — which is the correct answer for a
    // frame that carries neither a description nor a subagent type and may be
    // discarded before it ever runs.
    expect(classify(openingFrame({}))).toEqual({
      _tag: "AgentSpawnPending",
      toolUseId: AGENT_CALL,
    });
  });

  it("run_in_background:false is the ONLY thing that makes a spawn foreground", () => {
    expect(classify(openingFrame({ ...base, run_in_background: false }))._tag).toBe(
      "AgentRootStarted",
    );
  });

  it("the flag OMITTED is a background launch (qwen's documented default)", () => {
    // agent.ts:2528-2535: with no explicit flag, no `working_dir` and no `name`,
    // a non-fork top-level spawn defaults to background. This is the case a YOLO
    // wire delivers with real args and no preparing frame — the residual zombie
    // if the rule were not applied here.
    expect(classify(openingFrame(base))._tag).toBe("AgentSpawnPending");
  });

  it("run_in_background:true is background even with everything else set", () => {
    expect(
      classify(openingFrame({ ...base, run_in_background: true, name: "teammate" }))._tag,
    ).toBe("AgentSpawnPending");
  });

  it("working_dir forces foreground — a caller-owned worktree cannot detach", () => {
    // agent.ts:1150-1151 and :2537-2549 both reject the combination.
    expect(classify(openingFrame({ ...base, working_dir: "/w" }))._tag).toBe("AgentRootStarted");
  });

  it("a named teammate is foreground", () => {
    expect(classify(openingFrame({ ...base, name: "teammate" }))._tag).toBe("AgentRootStarted");
  });

  it("a fork without the explicit flag stays foreground — args cannot decide it", () => {
    // qwen's own carve-out and its reason, verbatim at toolClassification.ts:44-48;
    // agent.ts:926 confirms an interactive session needs the explicit flag.
    expect(classify(openingFrame({ ...base, subagent_type: "fork" }))._tag).toBe(
      "AgentRootStarted",
    );
    expect(classify(openingFrame({ ...base, subagent_type: "FORK" }))._tag).toBe(
      "AgentRootStarted",
    );
  });
});

describe("classifyQwenToolCallFrame", () => {
  it("the agent tool's opening frame becomes a root start, titled from rawInput", () => {
    expect(classify(agentStartFrame)).toEqual({
      _tag: "AgentRootStarted",
      taskId: AGENT_CALL,
      toolUseId: AGENT_CALL,
      title: "Review the diff",
      role: SUBAGENT_TYPE,
    });
  });

  it("the agent tool's terminal frame carries the final text and the mapped usage", () => {
    expect(classify(agentDoneFrame())).toEqual({
      _tag: "AgentRootSettled",
      taskId: AGENT_CALL,
      toolUseId: AGENT_CALL,
      status: "completed",
      // ru-code (agentic-flow wave, FIX ROUND 3 ADDENDUM): qwen sent an
      // `AgentResultDisplay`, so this terminal is the record of a run that
      // really happened. The caller settles such a row unconditionally; only a
      // terminal with NO result display AND no row we opened is silence (F-A5).
      hasResultDisplay: true,
      summary: "Found 2 issues.",
      title: "Review the diff",
      role: SUBAGENT_TYPE,
      typedUsage: {
        totalTokens: 4441,
        inputTokens: 4321,
        cachedInputTokens: 100,
        outputTokens: 120,
        reasoningOutputTokens: 7,
        toolUses: 5,
        durationMs: 4200,
      },
    });
  });

  it("qwen's `cancelled` is a STOP, not a failure", () => {
    const frame = classify(agentDoneFrame({ status: "cancelled", result: undefined }));
    if (frame._tag !== "AgentRootSettled") throw new Error("wrong tag");
    expect(frame.status).toBe("stopped");
  });

  it("falls back to terminateReason when the run produced no final text", () => {
    const frame = classify(
      agentDoneFrame({ status: "failed", result: undefined, terminateReason: "MAX_TURNS" }),
    );
    if (frame._tag !== "AgentRootSettled") throw new Error("wrong tag");
    expect(frame.status).toBe("failed");
    expect(frame.summary).toBe("MAX_TURNS");
  });

  it("emits no usage when the summary has no totalTokens (contract requires it)", () => {
    const frame = classify(
      agentDoneFrame({ executionSummary: { totalToolCalls: 2, inputTokens: 5 } }),
    );
    if (frame._tag !== "AgentRootSettled") throw new Error("wrong tag");
    expect(frame.typedUsage).toBeUndefined();
  });

  it("drops non-integer / negative counters instead of shipping them to a NonNegativeInt", () => {
    const frame = classify(
      agentDoneFrame({
        executionSummary: { ...EXECUTION_SUMMARY, totalDurationMs: 4200.5, cachedTokens: -1 },
      }),
    );
    if (frame._tag !== "AgentRootSettled") throw new Error("wrong tag");
    expect(frame.typedUsage?.durationMs).toBeUndefined();
    expect(frame.typedUsage?.cachedInputTokens).toBeUndefined();
    expect(frame.typedUsage?.totalTokens).toBe(4441);
  });

  it("an inner frame is attributed to its parent agent, not to itself", () => {
    expect(classify(innerFrame)).toEqual({
      _tag: "AgentInnerTool",
      taskId: AGENT_CALL,
      toolUseId: INNER_CALL,
      toolName: "read_file",
      role: SUBAGENT_TYPE,
      // ru-code (sub-agents): an OPENING inner frame is not settled and has no
      // result text yet — the row keeps the cheap `▸ tool` heartbeat for it.
      settled: false,
    });
  });

  it("a nested spawn (agent tool WITH a parent) attributes to the parent — order matters", () => {
    const nested = notification({
      sessionUpdate: "tool_call",
      toolCallId: "call-agent-2",
      status: "in_progress",
      title: "Agent: nested",
      content: [],
      locations: [],
      kind: "other",
      rawInput: {
        description: "nested",
        prompt: "p",
        subagent_type: "planner",
        run_in_background: false,
      },
      _meta: { toolName: "agent", parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
    });
    expect(classify(nested)._tag).toBe("AgentInnerTool");
  });

  it("an ordinary tool call is untouched (the whole non-agent path is unchanged)", () => {
    expect(classify(plainFrame)).toEqual({ _tag: "PlainToolCall" });
  });
});

describe("withQwenAgentAttribution", () => {
  const itemEvent = {
    type: "item.completed",
    eventId: "evt-1",
    createdAt: "2026-08-20T00:00:00.000Z",
    provider: "qwen",
    threadId: "thread-1",
    itemId: INNER_CALL,
    payload: { itemType: "dynamic_tool_call", status: "completed", title: "Tool" },
  } as never;

  it("stamps agentId + parentToolUseId on an item event", () => {
    const stamped = withQwenAgentAttribution(itemEvent, AGENT_CALL);
    if (stamped.type !== "item.completed") throw new Error("wrong variant");
    expect(stamped.payload.agentId).toBe(AGENT_CALL);
    expect(stamped.payload.parentToolUseId).toBe(AGENT_CALL);
    expect(stamped.payload.title).toBe("Tool");
  });

  it("returns a non-item event unchanged, by identity", () => {
    const other = { ...(itemEvent as object), type: "turn.completed" } as never;
    expect(withQwenAgentAttribution(other, AGENT_CALL)).toBe(other);
  });
});

describe("QWEN_SUBAGENT_TASK_TYPE", () => {
  it("is `subagent` — an agent-flavoured type, deliberately in neither classification set", () => {
    expect(QWEN_SUBAGENT_TASK_TYPE).toBe("subagent");
  });
});

// ru-code (livejitter): the anchored streaming window. qwen streams the
// child's answer in token-sized chunks that never respect word boundaries;
// feeding them through in 7-char slices (below) reproduces exactly that.
// Mutation target: revert `qwenAgentAnchoredLine` to the old raw
// `normalized.slice(-(LIMIT-1))` tail-slice and every assertion below goes red
// — the boundary check fails almost every tick, and the "stable prefix"
// check fails whenever the tail-slice's mid-word offset drifts between ticks.
describe("streaming tail: word-anchored window", () => {
  const WORDS = Array.from({ length: 40 }, (_, i) => `word${i}`);
  const FULL_TEXT = WORDS.join(" "); // single-spaced already — its own normal form.

  const openWindow = () =>
    openQwenAgentWindow({
      _tag: "AgentRootStarted",
      taskId: "t",
      toolUseId: "t",
      title: "d",
    });

  // Feeds FULL_TEXT through the window in word-boundary-agnostic 7-char
  // chunks, collecting every published line together with the window's
  // `anchor` at the moment it was published (fields are plain and readable —
  // no accessor needed).
  const runScriptedStream = () => {
    const window = openWindow();
    const emissions: Array<{ line: string; anchor: number; textSoFar: string }> = [];
    for (let i = 0; i < FULL_TEXT.length; i += 7) {
      const chunk = FULL_TEXT.slice(i, i + 7);
      const line = appendQwenAgentText(window, chunk);
      if (line !== undefined)
        emissions.push({ line, anchor: window.anchor, textSoFar: window.text });
    }
    const flushed = takeQwenAgentLine(window);
    if (flushed !== undefined) {
      emissions.push({ line: flushed, anchor: window.anchor, textSoFar: window.text });
    }
    return emissions;
  };

  it("never publishes a line whose content starts mid-word", () => {
    const emissions = runScriptedStream();
    expect(emissions.length).toBeGreaterThan(0);
    for (const { line, textSoFar } of emissions) {
      expect(line.length).toBeLessThanOrEqual(QWEN_AGENT_LINE_LIMIT);
      if (!line.startsWith("…")) continue; // anchor 0 — the true start, trivially clean.
      const content = line.slice(1);
      // textSoFar is already single-spaced (FULL_TEXT's own alphabet), so it
      // is its own normal form — the published content is a suffix of it.
      expect(textSoFar.endsWith(content)).toBe(true);
      const at = textSoFar.length - content.length;
      // Boundary: either the very start of the narration, or the char right
      // before the window is the separating space — never mid-word.
      expect(at === 0 || textSoFar[at - 1] === " ").toBe(true);
    }
  });

  it("keeps the left edge FIXED between ticks that still fit the bound (no back-and-forth)", () => {
    const emissions = runScriptedStream();
    let sawStablePair = false;
    for (let i = 1; i < emissions.length; i++) {
      const prev = emissions[i - 1]!;
      const cur = emissions[i]!;
      if (cur.anchor !== prev.anchor) continue; // a re-anchor tick — covered separately.
      sawStablePair = true;
      const prevContent = prev.anchor === 0 ? prev.line : prev.line.slice(1);
      const curContent = cur.anchor === 0 ? cur.line : cur.line.slice(1);
      // Same left edge ⇒ growing on the right only: the later line always
      // EXTENDS the earlier one, never re-slices it from a new offset.
      expect(curContent.startsWith(prevContent)).toBe(true);
    }
    expect(sawStablePair).toBe(true);
  });

  it("re-anchors forward only, and lands exactly on a word boundary", () => {
    const emissions = runScriptedStream();
    const anchors = emissions.map((e) => e.anchor);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]!).toBeGreaterThanOrEqual(anchors[i - 1]!);
    }
    expect(anchors.some((a) => a > 0)).toBe(true); // the 280-char stream must re-anchor at least once.
  });
});

// ─── BASELINE LOCK (agents wave, phase 1) ────────────────────────────────────
// The exported seams below carry today's behaviour but had no unit spec: the
// panel's whole live-line vocabulary (inner-tool result, parked child plan,
// wordless waiting glyph), the window constructor's description fallback chain,
// and the quantum/flush contract the settle paths depend on. Each block names
// the seam it guards so a mutation there lands here rather than in a red e2e.

describe("inner tool outcome — result text only on the TERMINAL frame", () => {
  // qwen's opening frame carries the call's ARGUMENT in the same `detail` field
  // the terminal frame carries the RESULT in (proven above: the port's parser
  // fills `detail: "/a.ts"` from the opening frame's content). Presenting the
  // argument as a result would put "▸ read_file · /a.ts" on the row as if the
  // read had already returned. Guards QwenAcpSubAgents.ts:159-161.
  const innerOpeningWithArgument = notification({
    sessionUpdate: "tool_call",
    toolCallId: INNER_CALL,
    status: "pending",
    title: "ReadFile: /a.ts",
    content: [{ type: "content", content: { type: "text", text: "/a.ts" } }],
    locations: [{ path: "/a.ts", line: null }],
    kind: "read",
    rawInput: { absolute_path: "/a.ts" },
    _meta: { toolName: "read_file", parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
  });

  const innerTerminal = (status: "completed" | "failed") =>
    notification({
      sessionUpdate: "tool_call_update",
      toolCallId: INNER_CALL,
      status,
      content: [{ type: "content", content: { type: "text", text: "42 lines" } }],
      _meta: { toolName: "read_file", parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
    });

  it("an opening frame's ARGUMENT is never surfaced as the call's result", () => {
    const frame = classify(innerOpeningWithArgument);
    if (frame._tag !== "AgentInnerTool") throw new Error("wrong tag");
    expect(frame.settled).toBe(false);
    expect(frame.detail).toBeUndefined();
  });

  it("a completed inner frame carries the tool's own result text", () => {
    const frame = classify(innerTerminal("completed"));
    if (frame._tag !== "AgentInnerTool") throw new Error("wrong tag");
    expect(frame.settled).toBe(true);
    expect(frame.detail).toBe("42 lines");
  });

  it("a FAILED inner frame settles too — its error text is the row's line", () => {
    const frame = classify(innerTerminal("failed"));
    if (frame._tag !== "AgentInnerTool") throw new Error("wrong tag");
    expect(frame.settled).toBe(true);
    expect(frame.detail).toBe("42 lines");
  });
});

describe("openQwenAgentWindow", () => {
  const started = (over?: { title?: string; role?: string }) =>
    openQwenAgentWindow({
      _tag: "AgentRootStarted",
      taskId: AGENT_CALL,
      toolUseId: AGENT_CALL,
      ...(over?.title !== undefined ? { title: over.title } : {}),
      ...(over?.role !== undefined ? { role: over.role } : {}),
    });

  it("starts empty at the text/quantum/anchor origin", () => {
    const window = started({ title: "Review the diff", role: SUBAGENT_TYPE });
    expect(window).toEqual({
      taskId: AGENT_CALL,
      description: "Review the diff",
      role: SUBAGENT_TYPE,
      toolUseId: AGENT_CALL,
      title: "Review the diff",
      text: "",
      emitted: "",
      pending: 0,
      anchor: 0,
    });
  });

  // `description` is a REQUIRED non-empty contract field on TaskProgressPayload:
  // an empty one makes every heartbeat of the run fail the schema. Guards the
  // fallback chain at QwenAcpSubAgents.ts:363.
  it("falls back title → role → the tool name so `description` is never empty", () => {
    expect(started({ title: "Review the diff", role: SUBAGENT_TYPE }).description).toBe(
      "Review the diff",
    );
    expect(started({ role: SUBAGENT_TYPE }).description).toBe(SUBAGENT_TYPE);
    expect(started().description).toBe(QWEN_AGENT_TOOL_NAME);
    expect(started().role).toBeUndefined();
  });
});

describe("the line quantum and its flush", () => {
  const openWindow = () =>
    openQwenAgentWindow({
      _tag: "AgentRootStarted",
      taskId: AGENT_CALL,
      toolUseId: AGENT_CALL,
      title: "d",
    });

  it("publishes nothing until the quantum is reached, then the whole tail", () => {
    const window = openWindow();
    const below = "x".repeat(QWEN_AGENT_LINE_QUANTUM - 1);
    expect(appendQwenAgentText(window, below)).toBeUndefined();
    expect(window.text).toBe(below);
    expect(window.pending).toBe(below.length);
    // One more character crosses it — and the line is everything accumulated.
    expect(appendQwenAgentText(window, "y")).toBe(`${below}y`);
    expect(window.pending).toBe(0);
  });

  // The settle paths (AgentRootSettled at QwenAdapter.ts:2303 and the teardown
  // twin settleOpenSubAgentAsStopped at :934) flush below the quantum so a run
  // that ends mid-sentence keeps the child's last words.
  it("takeQwenAgentLine publishes a sub-quantum tail the quantum withheld", () => {
    const window = openWindow();
    expect(appendQwenAgentText(window, "half a thought")).toBeUndefined();
    expect(takeQwenAgentLine(window)).toBe("half a thought");
  });

  // THE idempotency seam: the crash/Stop settle calls takeQwenAgentLine
  // unconditionally, and a real AgentRootSettled may have flushed already. A
  // second call with nothing new must publish NOTHING, or every interrupted run
  // duplicates its last line on the row.
  it("takeQwenAgentLine is idempotent — nothing new means nothing published", () => {
    const window = openWindow();
    appendQwenAgentText(window, "half a thought");
    expect(takeQwenAgentLine(window)).toBe("half a thought");
    expect(takeQwenAgentLine(window)).toBeUndefined();
    expect(takeQwenAgentLine(window)).toBeUndefined();
  });

  it("an empty window publishes nothing at all", () => {
    expect(takeQwenAgentLine(openWindow())).toBeUndefined();
  });
});

describe("formatQwenAgentPlanLine — the CHILD's todo list, parked on the row", () => {
  it("reads progress count plus the step actually in flight", () => {
    expect(
      formatQwenAgentPlanLine({
        plan: [
          { step: "read the files", status: "completed" },
          { step: "write the review", status: "inProgress" },
          { step: "post it", status: "pending" },
        ],
      }),
    ).toBe("▤ 1/3 · write the review");
  });

  // The pending step is deliberately NOT the last entry here: a fixture where it
  // is cannot tell the pending lookup from the trailing-step fallback below.
  it("with nothing in flight it names the next PENDING step", () => {
    expect(
      formatQwenAgentPlanLine({
        plan: [
          { step: "read the files", status: "completed" },
          { step: "post it", status: "pending" },
          { step: "clean up", status: "completed" },
        ],
      }),
    ).toBe("▤ 2/3 · post it");
  });

  it("with everything done it names the last step, not undefined", () => {
    expect(
      formatQwenAgentPlanLine({
        plan: [
          { step: "read the files", status: "completed" },
          { step: "post it", status: "completed" },
        ],
      }),
    ).toBe("▤ 2/2 · post it");
  });

  it("an empty plan produces no line (nothing to say)", () => {
    expect(formatQwenAgentPlanLine({ plan: [] })).toBeUndefined();
  });

  it("is bounded by the fold's SUMMARY_CHAR_LIMIT, with a leading ellipsis", () => {
    const line = formatQwenAgentPlanLine({
      plan: [{ step: "s".repeat(400), status: "inProgress" }],
    });
    expect(line!.length).toBe(QWEN_AGENT_LINE_LIMIT);
    expect(line!.startsWith("…")).toBe(true);
  });
});

describe("formatQwenAgentToolLine — an inner tool's result on the one channel that renders it", () => {
  it("joins the tool name and its result", () => {
    expect(formatQwenAgentToolLine("read_file", "42 lines")).toBe("▸ read_file · 42 lines");
  });

  it("a name with no result is the cheap heartbeat line", () => {
    expect(formatQwenAgentToolLine("read_file", undefined)).toBe("▸ read_file");
  });

  it("a result with no name still reaches the row", () => {
    expect(formatQwenAgentToolLine(undefined, "42 lines")).toBe("▸ 42 lines");
  });

  it("neither means no line — never a bare glyph", () => {
    expect(formatQwenAgentToolLine(undefined, undefined)).toBeUndefined();
    expect(formatQwenAgentToolLine("   ", "  ")).toBeUndefined();
  });

  it("collapses whitespace so a chunk boundary cannot render as a blank line", () => {
    expect(formatQwenAgentToolLine("read_file", "42\n\n  lines")).toBe("▸ read_file · 42 lines");
  });
});

// Deliberately WORDLESS: the server emits no English literal here, so the line
// owes no dictionary pair and reads identically in both locales. A word added
// to this line is a localization-contract break, which is what this pins.
describe("formatQwenAgentWaitingLine", () => {
  it("is a pause glyph plus the tool name — no prose", () => {
    expect(formatQwenAgentWaitingLine("write_file")).toBe("⏸ write_file");
  });

  it("is the bare glyph when the tool is unnamed", () => {
    expect(formatQwenAgentWaitingLine(undefined)).toBe("⏸");
    expect(formatQwenAgentWaitingLine("   ")).toBe("⏸");
  });
});
