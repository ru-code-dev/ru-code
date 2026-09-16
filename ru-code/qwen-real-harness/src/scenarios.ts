// ru-code (qwen-compression wave): the COMPRESSION SCENARIOS, as scripts for the
// mock model plus the prompts to send.
//
// Each one exists to make the real binary produce one wire shape the in-memory
// fake claims to model. Nothing here asserts; the assertions live beside the
// fake's own builders (apps/server/src/ru-code/tests/qwen/real-acp/).

import {
  fakeToolCall,
  type FakeOpenAIFailure,
  type FakeOpenAIResponse,
} from "./fakeOpenAiServer.ts";

/** A turn to drive: the text sent over `session/prompt`. */
export interface ScenarioTurn {
  readonly prompt: string;
  /** A fresh `session/new` before this turn instead of reusing the open one. */
  readonly newSession?: boolean;
  /** This prompt is expected to FAIL with a JSON-RPC error. */
  readonly expectRejected?: boolean;
}

export interface Scenario {
  readonly name: string;
  /** What the scenario is for, verbatim into the capture's manifest. */
  readonly purpose: string;
  readonly turns: ReadonlyArray<ScenarioTurn>;
  /** Extra `settings.json` keys for the run (see `QwenSpawnInput.settings`). */
  readonly settings?: Record<string, unknown>;
  /**
   * The mock's answer for each `/chat/completions` call, by call index.
   *
   * `workspace` is the run's own working directory — a tool call must name a
   * real absolute path for qwen to execute it, and the path only exists once the
   * run root has been made.
   */
  readonly respond: (ctx: {
    readonly body: Record<string, unknown>;
    readonly requestIndex: number;
    readonly workspace: string;
  }) => FakeOpenAIResponse | FakeOpenAIFailure;
}

/**
 * The inflated prompt count that makes qwen auto-compact.
 *
 * qwen measures its auto threshold against the model's context window, which for
 * an unknown slug is `DEFAULT_TOKEN_LIMIT = 200_000` (tokenLimits.ts:11), giving
 * `auto = min(0.85·200 000, 200 000 − 20 000 − 13 000) = 167 000`
 * (chatCompressionService.ts:159-254). The estimate it compares is seeded from
 * the previous response's `usage.prompt_tokens` (`lastPromptTokenCount`), so a
 * first turn that reports this number puts the SECOND turn over the line.
 */
export const INFLATED_PROMPT_TOKENS = 190_000;

/**
 * The session cap for the `session-token-limit` scenario. It must sit BELOW the
 * post-compaction count the summariser produces (~1 000 for the short summary
 * the mock returns) and above 0, so the turn compacts FIRST and only then trips
 * the cap — which is the order that makes qwen emit both notices
 * (Session.ts:4418-4434).
 */
export const SESSION_TOKEN_LIMIT = 500;

const ordinaryUsage = (promptTokens: number): NonNullable<FakeOpenAIResponse["usage"]> => ({
  prompt_tokens: promptTokens,
  completion_tokens: 8,
  total_tokens: promptTokens + 8,
});

/** A plain assistant reply with a modest prompt count. */
const reply = (content: string, promptTokens = 1_200): FakeOpenAIResponse => ({
  content,
  contentChunks: [content],
  finishReason: "stop",
  usage: ordinaryUsage(promptTokens),
});

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "manual-compress",
    purpose:
      "A manual `/compress` sent as the prompt text. Pins the two " +
      '`agent_message_chunk`s stamped `_meta.source:"slash_command"` and the ' +
      "`end_turn` the prompt resolves with.",
    turns: [
      { prompt: "Reply with exactly the word OK and nothing else." },
      { prompt: "/compress" },
    ],
    respond: ({ requestIndex }) =>
      requestIndex === 0
        ? reply("OK")
        : // The compression side-query. Its answer becomes the summary, so it is
          // long enough to be a plausible one and far under the inflated count.
          reply("<state_snapshot>The user asked for OK and got it.</state_snapshot>"),
  },
  {
    name: "manual-compress-then-turn",
    purpose:
      "A `/compress` followed by an ordinary turn on the SAME ACP session. Pins " +
      "that no session restart is needed for the next prompt to answer.",
    turns: [
      { prompt: "Reply with exactly the word OK and nothing else." },
      { prompt: "/compress" },
      { prompt: "Now reply with exactly the word AFTER and nothing else." },
    ],
    respond: ({ requestIndex }) => {
      if (requestIndex === 0) return reply("OK");
      if (requestIndex === 1) {
        return reply("<state_snapshot>The user asked for OK and got it.</state_snapshot>");
      }
      return reply("AFTER");
    },
  },
  {
    name: "auto-compaction",
    purpose:
      "qwen's OWN pre-send auto-compaction, forced by an inflated " +
      "`usage.prompt_tokens` on turn 1. Pins the BARE `agent_message_chunk` " +
      "notice (no `_meta` at all) and the post-compaction usage frame that follows.",
    turns: [
      { prompt: "Reply with exactly the word FILL and nothing else." },
      { prompt: "Now reply with exactly the word CONTINUE and nothing else." },
    ],
    respond: ({ requestIndex }) => {
      // Turn 1: an ordinary answer carrying the INFLATED prompt count, which is
      // what qwen remembers as its context size.
      if (requestIndex === 0) return reply("FILL", INFLATED_PROMPT_TOKENS);
      // Turn 2's pre-send compaction side-query, then turn 2's own model round.
      if (requestIndex === 1) {
        return reply(
          "<state_snapshot>The user asked for FILL and got it.</state_snapshot>",
          INFLATED_PROMPT_TOKENS,
        );
      }
      return reply("CONTINUE");
    },
  },
  {
    name: "auto-compaction-on-continuation",
    purpose:
      "qwen's auto-compaction on a TOOL-RESULT CONTINUATION, not on the turn's " +
      "first send. The compaction check runs before EVERY send of the turn loop " +
      "(Session.ts:3602 → :3655), so the notice arrives AFTER the turn has " +
      "already produced a tool call — the position a gate keyed on 'the turn's " +
      "opening agent message' cannot see.",
    turns: [{ prompt: "List the working directory, then reply with exactly the word DONE." }],
    respond: ({ requestIndex, workspace }) => {
      // Send #1: the model asks for a tool, and reports the INFLATED prompt
      // count that puts the CONTINUATION over the compaction threshold. `--yolo`
      // auto-approves, and `list_directory` is read-only.
      if (requestIndex === 0) {
        return {
          // TEXT FIRST, then the tool call — so the turn has already SPOKEN
          // before the continuation's notice arrives. That is the exact shape a
          // gate keyed on "the turn's opening agent message" drops.
          contentChunks: ["Listing the directory…"],
          toolCalls: [fakeToolCall("list_directory", { path: workspace })],
          finishReason: "tool_calls",
          usage: ordinaryUsage(INFLATED_PROMPT_TOKENS),
        };
      }
      // The continuation's pre-send compaction side-query …
      if (requestIndex === 1) {
        return reply(
          "<state_snapshot>The user asked for a directory listing.</state_snapshot>",
          INFLATED_PROMPT_TOKENS,
        );
      }
      // … and then the continuation's own model round.
      return reply("DONE");
    },
  },
  {
    name: "compress-failure",
    purpose:
      "A `/compress` whose summariser call FAILS (HTTP 500). Pins that the " +
      "prompt is REJECTED with a JSON-RPC error and NO frame is emitted — the " +
      "`stream_messages` error message is thrown before it can `sendUpdate` " +
      "(Session.ts:8475-8477).",
    turns: [
      { prompt: "Reply with exactly the word OK and nothing else." },
      { prompt: "/compress", expectRejected: true },
    ],
    respond: ({ requestIndex }) =>
      requestIndex === 0
        ? reply("OK")
        : { status: 500, message: "fake backend refuses the summary call" },
  },
  {
    name: "session-token-limit",
    purpose:
      "A turn that compacts and STILL exceeds `model.sessionTokenLimit`. Pins " +
      "that the cap notice REPLACES the compaction notice (the cap's early " +
      "return at Session.ts:4432 never reaches the compaction emit at " +
      ":4436-4440), so the turn carries ONE bare frame and resolves " +
      "`max_tokens` with no model round.",
    settings: { model: { sessionTokenLimit: SESSION_TOKEN_LIMIT } },
    turns: [
      { prompt: "Reply with exactly the word FILL and nothing else." },
      { prompt: "Now reply with exactly the word CONTINUE and nothing else." },
    ],
    respond: ({ requestIndex }) => {
      if (requestIndex === 0) return reply("FILL", INFLATED_PROMPT_TOKENS);
      return reply(
        "<state_snapshot>The user asked for FILL and got it.</state_snapshot>",
        INFLATED_PROMPT_TOKENS,
      );
    },
  },
  {
    name: "two-sessions",
    purpose:
      "TWO ACP sessions on one agent process, compaction in the second. Pins " +
      "that every compression frame carries its own `sessionId`, so a host " +
      "routing per session cannot cross-talk.",
    turns: [
      { prompt: "Reply with exactly the word ONE and nothing else." },
      { prompt: "Reply with exactly the word TWO and nothing else.", newSession: true },
      { prompt: "/compress" },
    ],
    respond: ({ requestIndex }) => {
      if (requestIndex === 0) return reply("ONE");
      if (requestIndex === 1) return reply("TWO");
      return reply("<state_snapshot>The user asked for TWO and got it.</state_snapshot>");
    },
  },
];

export const scenarioByName = (name: string): Scenario => {
  const found = SCENARIOS.find((scenario) => scenario.name === name);
  if (!found) {
    throw new Error(
      `unknown scenario ${JSON.stringify(name)}; have: ${SCENARIOS.map((s) => s.name).join(", ")}`,
    );
  }
  return found;
};
