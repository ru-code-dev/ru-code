// ru-code (qwen-compression wave): the compaction-wire readers, pure.
//
// These three functions are the WHOLE decision "is this chunk a compaction
// report, and what are its numbers" for qwen 0.21.1, where the only carrier is
// prose (WORKFLOW/02 §2.5). Every real text is pinned here verbatim from the
// qwen source line that builds it, together with the two traps that make the
// naive reading wrong: the model name's digit ("qwen3-coder-plus") sitting ahead
// of the counts, and ordinary model prose that mentions compressing.
import { describe, expect, it } from "vite-plus/test";

import {
  QWEN_AUTO_COMPACTION_HEAD,
  QWEN_SESSION_LIMIT_HEAD,
  hasQwenDiagnosticHead,
  isQwenBareAgentFrame,
  isQwenSlashCommandFrame,
  parseQwenCompactionText,
} from "../../../qwen/compaction/compactionWire.ts";

/** A raw SessionNotification params object with the given `update._meta`. */
const frame = (meta?: Record<string, unknown>): unknown => ({
  sessionId: "s",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
    ...(meta === undefined ? {} : { _meta: meta }),
  },
});

describe("parseQwenCompactionText — manual /compress texts", () => {
  it("reads the 0.21.1 result line (trailing period outside the parenthesis)", () => {
    // qwen compressCommand.ts:109-112
    expect(parseQwenCompactionText("Context compressed (152340 -> 18211).")).toEqual({
      kind: "result",
      preTokens: 152340,
      postTokens: 18211,
    });
  });

  it("reads the 0.13.1 result line (no trailing period) with the same rule", () => {
    expect(parseQwenCompactionText("Context compressed (200000 -> 12345)")).toEqual({
      kind: "result",
      preTokens: 200000,
      postTokens: 12345,
    });
  });

  it("reads the progress line as progress (contains compress, carries no pair)", () => {
    // qwen compressCommand.ts:97-100
    expect(parseQwenCompactionText("Compressing context...")).toEqual({ kind: "progress" });
  });

  it("reads the truncation notice as progress (one number, no pair)", () => {
    // qwen compressCommand.ts:90-95
    expect(
      parseQwenCompactionText("Compression instructions were truncated to 2000 characters."),
    ).toEqual({ kind: "progress" });
  });
});

describe("parseQwenCompactionText — qwen's auto-compaction notice", () => {
  const notice = (model: string): string =>
    `IMPORTANT: This conversation approached the input token limit for ${model}. ` +
    `A compressed context will be sent for future messages ` +
    `(compressed from: 190000 to 12345 tokens).`;

  it("reads the notice's pair", () => {
    // qwen Session.ts:4378-4392
    expect(parseQwenCompactionText(notice("gpt-oss"))).toEqual({
      kind: "result",
      preTokens: 190000,
      postTokens: 12345,
    });
  });

  it("THE TRAP: a model name carrying a digit does not become the pre count", () => {
    // "qwen3-coder-plus" puts a bare 3 ahead of both counts. A naive
    // first-two-integers scan reads {3, 190000}.
    expect(parseQwenCompactionText(notice("qwen3-coder-plus"))).toEqual({
      kind: "result",
      preTokens: 190000,
      postTokens: 12345,
    });
  });

  it("THE TRAP: a hyphenated model version does not become the pre count either", () => {
    // "-4" is not letter-adjacent, so only the "after the last compress" anchor
    // rejects it.
    expect(parseQwenCompactionText(notice("gpt-4"))).toEqual({
      kind: "result",
      preTokens: 190000,
      postTokens: 12345,
    });
  });

  it("reads the image-overflow clause the same way", () => {
    // qwen Session.ts:4383-4386
    expect(
      parseQwenCompactionText(
        "IMPORTANT: This conversation accumulated enough tool screenshots to trigger " +
          "compaction for qwen3-coder-plus. A compressed context will be sent for future " +
          "messages (compressed from: 88000 to 9100 tokens).",
      ),
    ).toEqual({ kind: "result", preTokens: 88000, postTokens: 9100 });
  });

  it("reads a notice with unknown counts as progress, never as zeros", () => {
    // qwen Session.ts:4390-4391 renders the literal "unknown".
    expect(
      parseQwenCompactionText(
        "IMPORTANT: This conversation approached the input token limit for m. A compressed " +
          "context will be sent for future messages (compressed from: unknown to unknown tokens).",
      ),
    ).toEqual({ kind: "progress" });
  });
});

describe("parseQwenCompactionText — the session-cap notice", () => {
  it("is recognised even though it never says compress", () => {
    // qwen Session.ts:4427-4431
    expect(
      parseQwenCompactionText(
        "Session token limit exceeded: 210000 tokens > 200000 limit. Please start a new " +
          "session or increase the sessionTokenLimit in your settings.json.",
      ),
    ).toEqual({ kind: "session-limit" });
  });

  it("wins over the compaction reading when both words appear", () => {
    expect(
      parseQwenCompactionText("Session token limit exceeded after compressing (1 -> 2)."),
    ).toEqual({ kind: "session-limit" });
  });
});

describe("parseQwenCompactionText — what it must NOT claim", () => {
  it("returns undefined for ordinary prose", () => {
    expect(parseQwenCompactionText("Готово.")).toBeUndefined();
    expect(parseQwenCompactionText("")).toBeUndefined();
    expect(parseQwenCompactionText("I read 12 files and wrote 3.")).toBeUndefined();
  });

  it("still parses model prose that mentions compressing — the GATE is what rejects it", () => {
    // Loose on purpose: one rule for every shape, no per-version strings. What
    // stops this being ACTED on is the gate, and the gate is pinned by name:
    //   apps/server/src/ru-code/tests/qwen/fake-acp/qwen021Compression.e2e.test.ts
    //   "0.21.1 false positive: model prose that PARSES as a compaction is left alone"
    // — this exact sentence, on a bare chunk, mid-turn: no compaction row, no
    // ring write, the text in the bubble verbatim. The head half of the gate is
    // pinned below by `hasQwenDiagnosticHead` "FAILS CLOSED on model prose".
    expect(parseQwenCompactionText("I compressed 200 files into 3 archives.")).toEqual({
      kind: "result",
      preTokens: 200,
      postTokens: 3,
    });
  });

  it("applies NO size check: an inflated result is a real confirmation", () => {
    // qwen reports COMPRESSION_FAILED_INFLATED_TOKEN_COUNT as an ordinary
    // success line (WORKFLOW/02 §2.2); the adapter's low-gain branch judges it.
    expect(parseQwenCompactionText("Context compressed (15762 -> 16246).")).toEqual({
      kind: "result",
      preTokens: 15762,
      postTokens: 16246,
    });
    expect(parseQwenCompactionText("Context compressed (12000 -> 12000).")).toEqual({
      kind: "result",
      preTokens: 12000,
      postTokens: 12000,
    });
  });
});

describe("parseQwenCompactionText — thousands separators", () => {
  it("accepts comma, space and NBSP groupings", () => {
    expect(parseQwenCompactionText("Context compressed (152,340 -> 18,211).")).toEqual({
      kind: "result",
      preTokens: 152340,
      postTokens: 18211,
    });
    expect(parseQwenCompactionText("Context compressed (152 340 -> 18 211).")).toEqual({
      kind: "result",
      preTokens: 152340,
      postTokens: 18211,
    });
    expect(parseQwenCompactionText("Context compressed (152 340 -> 18 211).")).toEqual({
      kind: "result",
      preTokens: 152340,
      postTokens: 18211,
    });
  });

  it("does NOT treat a full stop as a separator, and drops a decimal whole", () => {
    // "0.211" must contribute NEITHER 0 nor 211 — qwen never localizes these
    // numbers, so a dot here is a decimal point or a version, never a grouping,
    // and half a decimal is not a token count.
    expect(parseQwenCompactionText("Context compressed at 0.211 ratio (1000 -> 400).")).toEqual({
      kind: "result",
      preTokens: 1000,
      postTokens: 400,
    });
  });

  it("still reads a count that merely ends the sentence", () => {
    expect(parseQwenCompactionText("Context compressed from 1000 to 400.")).toEqual({
      kind: "result",
      preTokens: 1000,
      postTokens: 400,
    });
  });
});

describe("isQwenSlashCommandFrame", () => {
  it("is true only for _meta.source === slash_command", () => {
    expect(isQwenSlashCommandFrame(frame({ source: "slash_command" }))).toBe(true);
    expect(isQwenSlashCommandFrame(frame({ source: "slash_command", timestamp: 1 }))).toBe(true);
  });

  it("is false for every other source, for no _meta, and for junk", () => {
    expect(isQwenSlashCommandFrame(frame({ source: "background_notification" }))).toBe(false);
    expect(isQwenSlashCommandFrame(frame({ usage: { inputTokens: 1 } }))).toBe(false);
    expect(isQwenSlashCommandFrame(frame())).toBe(false);
    expect(isQwenSlashCommandFrame({ sessionId: "s" })).toBe(false);
    expect(isQwenSlashCommandFrame(null)).toBe(false);
    expect(isQwenSlashCommandFrame("nope")).toBe(false);
  });
});

describe("isQwenBareAgentFrame", () => {
  it("is true for a chunk with no _meta at all — qwen's diagnostic channel", () => {
    expect(isQwenBareAgentFrame(frame())).toBe(true);
    expect(isQwenBareAgentFrame(frame({}))).toBe(true);
  });

  it("is false for ANY stamped chunk, not merely for a stamped source", () => {
    expect(isQwenBareAgentFrame(frame({ source: "slash_command" }))).toBe(false);
    expect(isQwenBareAgentFrame(frame({ parentToolCallId: "call-1" }))).toBe(false);
    expect(isQwenBareAgentFrame(frame({ usage: { inputTokens: 5 } }))).toBe(false);
  });

  it("is false when there is no update at all", () => {
    expect(isQwenBareAgentFrame({ sessionId: "s" })).toBe(false);
    expect(isQwenBareAgentFrame(undefined)).toBe(false);
  });
});

describe("hasQwenDiagnosticHead", () => {
  // The second admission path for a BARE chunk. It is what identifies a
  // CONTINUATION send's compaction, where "the turn's opening agent message"
  // cannot: qwen runs the compaction check before EVERY send of the turn loop
  // (Session.ts:3602 → :3655) and emits from whichever send compacted (:4437-4441).
  it("matches the auto-compaction notice qwen builds", () => {
    // Session.ts:4388-4391
    expect(
      hasQwenDiagnosticHead(
        "IMPORTANT: This conversation approached the input token limit for qwen3-coder-plus. " +
          "A compressed context will be sent for future messages (compressed from: 190000 to 12345 tokens).",
      ),
    ).toBe(true);
    // The image-overflow clause swaps only the MIDDLE, so the head still holds.
    expect(
      hasQwenDiagnosticHead(
        "IMPORTANT: This conversation accumulated enough tool screenshots to trigger " +
          "compaction for m. A compressed context will be sent for future messages " +
          "(compressed from: 88000 to 9100 tokens).",
      ),
    ).toBe(true);
  });

  it("matches the session-cap notice qwen builds", () => {
    // Session.ts:4428-4429
    expect(
      hasQwenDiagnosticHead(
        "Session token limit exceeded: 1008 tokens > 500 limit. Please start a new session " +
          "or increase the sessionTokenLimit in your settings.json.",
      ),
    ).toBe(true);
  });

  it("FAILS CLOSED on model prose, including prose that parses as a result", () => {
    // The whole safety argument for the loose parser mid-turn. Pinned by the
    // adapter-level spec named in the parser case above.
    expect(hasQwenDiagnosticHead("I compressed 200 files into 3 archives.")).toBe(false);
    expect(hasQwenDiagnosticHead("Context compressed (1000 -> 400).")).toBe(false);
    expect(hasQwenDiagnosticHead("")).toBe(false);
    // A head must OPEN the text — quoting it mid-sentence is the model talking.
    expect(hasQwenDiagnosticHead(`Note: ${QWEN_AUTO_COMPACTION_HEAD}is a qwen notice.`)).toBe(
      false,
    );
    expect(hasQwenDiagnosticHead(`see "${QWEN_SESSION_LIMIT_HEAD}" in the docs`)).toBe(false);
  });

  it("the heads are the emitter's literal prefixes, with nothing before them", () => {
    // If qwen ever interpolates ahead of these, the head match must break
    // loudly rather than silently widen.
    expect(QWEN_AUTO_COMPACTION_HEAD).toBe("IMPORTANT: This conversation ");
    expect(QWEN_SESSION_LIMIT_HEAD).toBe("Session token limit exceeded: ");
  });
});
