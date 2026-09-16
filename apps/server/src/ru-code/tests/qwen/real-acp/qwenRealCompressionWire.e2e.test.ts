// ru-code (qwen-compression wave): THE REAL BINARY vs THE FAKE.
//
// Every compression assertion in `../fake-acp/` rests on the claim that
// `qwen021Frames.ts` reproduces what qwen 0.21.1 actually puts on the ACP wire.
// This suite is where that claim is checked against the binary itself: it drives
// the REAL bundle over a real ACP connection against a scripted
// OpenAI-compatible mock (@ru-code/qwen-real-harness), captures every
// `session/update`, and diffs the capture against the fake's own builders.
//
// WHEN THEY DISAGREE, THE FAKE IS WRONG. The builders are a transcription of
// qwen's emitters; the capture is qwen. Fix `qwen021Frames.ts` (and the DSL in
// `fakeAcpCore.ts` if the channel itself moved), re-run, and only then look at
// the app.
//
// GATED. Nothing here runs without a built bundle:
//
//   RU_CODE_QWEN_CLI_JS=<qwen build>/dist/cli.js pnpm --filter @t3tools/server test:real-qwen
//
// The build ritual (an isolated COPY of the qwen tree, never in place) is in
// ru-code/qwen-real-harness/README.md. Without the variable every case below is
// SKIPPED, so `vp run -r test` never needs a qwen binary.
import {
  INFLATED_PROMPT_TOKENS,
  captureScenario,
  isBareAgentMessageFrame,
  isSlashCommandFrame,
  isUsageFrame,
  metaKeysSeen,
  SESSION_TOKEN_LIMIT,
  readCapturedFrames,
  resolveQwenCliJs,
  usageInputTokens,
  type CaptureResult,
} from "@ru-code/qwen-real-harness";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { hasQwenDiagnosticHead } from "../../../qwen/compaction/compactionWire.ts";
import {
  QWEN_ACP_INTERNAL_ERROR_MESSAGE,
  QWEN_COMPRESS_PROGRESS_MESSAGE,
  qwenAutoCompressionDiagnostic,
  qwenCompressResultMessage,
  qwenEmitAgentDiagnosticMessage,
  qwenEmitSlashCommandOutput,
  qwenSessionTokenLimitDiagnostic,
  qwenSlashCommandHardLineBreaks,
} from "../fake-acp/qwen021Frames.ts";

const cliJs = resolveQwenCliJs();
const gated = describe.skipIf(cliJs === undefined);

/** One capture per scenario, shared by that scenario's cases. */
const captures = new Map<string, CaptureResult>();
const capture = async (scenario: string): Promise<CaptureResult> => {
  const existing = captures.get(scenario);
  if (existing) return existing;
  const result = await captureScenario(scenario, cliJs === undefined ? {} : { cliJs });
  captures.set(scenario, result);
  return result;
};

/** The `_meta` keys the fake's builders claim a compression frame can carry. */
const FAKE_SLASH_COMMAND_META_KEYS = Object.keys(
  (qwenEmitSlashCommandOutput("x") as unknown as { _meta: Record<string, unknown> })._meta,
).sort();

const textsOf = (frames: ReadonlyArray<{ readonly text: string | undefined }>): string[] =>
  frames.map((frame) => frame.text ?? "");

const describeCapture = (result: CaptureResult): string =>
  JSON.stringify(
    {
      turns: result.turns.map((turn) => ({
        prompt: turn.prompt,
        stopReason: turn.stopReason ?? null,
        error: turn.error ?? null,
        updates: turn.updates.length,
      })),
      frames: readCapturedFrames(result.allUpdates).map((frame) => ({
        sessionUpdate: frame.sessionUpdate,
        meta: frame.meta === undefined ? null : Object.keys(frame.meta),
        text: (frame.text ?? "").slice(0, 160),
      })),
      stderr: result.stderr.slice(-800),
    },
    null,
    2,
  );

gated("real qwen 0.21.1 — manual /compress", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("manual-compress");
  }, 180_000);

  it("reports the compression on session/update, never as an ext notification", () => {
    const frames = readCapturedFrames(result.allUpdates);
    const slash = frames.filter(isSlashCommandFrame);
    expect(
      slash.length,
      `no slash-command frames in the capture:\n${describeCapture(result)}`,
    ).toBeGreaterThanOrEqual(2);
    // The channel the retired reader listened on must not appear at all.
    expect(
      result.inboundRequests.map((request) => request.method),
      "qwen must send no /slash_command ext request",
    ).not.toContain("_qwencode/slash_command");
    expect(
      result.allUpdates.length,
      "every compression frame must be a session/update",
    ).toBeGreaterThan(0);
  });

  it("the frames are BYTE-IDENTICAL to what the fake's builders produce", () => {
    const slash = readCapturedFrames(result.allUpdates).filter(isSlashCommandFrame);
    const texts = textsOf(slash);
    // Chunk 1: the progress line, hard-line-break transform included.
    expect(texts).toContain(qwenSlashCommandHardLineBreaks(QWEN_COMPRESS_PROGRESS_MESSAGE));
    // Chunk 2: "Context compressed (<pre> -> <post>)." — the numbers are qwen's,
    // so the builder is checked by RE-BUILDING the observed pair and demanding
    // the exact same string back.
    const resultText = texts.find((text) => text.includes("Context compressed"));
    expect(resultText, `no result line among ${JSON.stringify(texts)}`).toBeDefined();
    const numbers = /\((\d+) -> (\d+)\)/.exec(resultText ?? "");
    expect(numbers, `unreadable result line ${JSON.stringify(resultText)}`).not.toBeNull();
    expect(resultText).toBe(
      qwenSlashCommandHardLineBreaks(
        qwenCompressResultMessage(Number(numbers?.[1]), Number(numbers?.[2])),
      ),
    );
    // And the whole envelope, not just the text.
    const rebuilt = qwenEmitSlashCommandOutput(resultText ?? "") as unknown;
    const observed = (result.allUpdates as ReadonlyArray<Record<string, unknown>>).find(
      (params) =>
        JSON.stringify((params["update"] as Record<string, unknown> | undefined)?.["content"]) ===
        JSON.stringify((rebuilt as Record<string, unknown>)["content"]),
    );
    expect(observed?.["update"]).toEqual(rebuilt);
  });

  it("carries no _meta key the fake does not model", () => {
    const slash = readCapturedFrames(result.allUpdates).filter(isSlashCommandFrame);
    expect(metaKeysSeen(slash)).toEqual(FAKE_SLASH_COMMAND_META_KEYS);
  });

  it("resolves the prompt end_turn and emits no usage frame for the compress turn", () => {
    const compressTurn = result.turns.at(-1);
    expect(compressTurn?.prompt).toBe("/compress");
    expect(compressTurn?.stopReason, describeCapture(result)).toBe("end_turn");
    // No model round happens, so no usage frame can (Session.ts:8498-8499).
    expect(readCapturedFrames(compressTurn?.updates ?? []).filter(isUsageFrame)).toEqual([]);
  });
});

gated("real qwen 0.21.1 — the turn after a compaction", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("manual-compress-then-turn");
  }, 180_000);

  it("answers on the SAME session, with no re-establishment", () => {
    expect(result.sessionIds.length, describeCapture(result)).toBe(1);
    const last = result.turns.at(-1);
    expect(last?.stopReason).toBe("end_turn");
    expect(
      textsOf(readCapturedFrames(last?.updates ?? [])).join(""),
      `the post-compaction turn never answered:\n${describeCapture(result)}`,
    ).toContain("AFTER");
  });
});

gated("real qwen 0.21.1 — its own auto-compaction", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("auto-compaction");
  }, 180_000);

  it("announces it on a BARE agent_message_chunk, byte-identical to the fake's", () => {
    const frames = readCapturedFrames(result.turns.at(-1)?.updates ?? []);
    const notice = frames
      .filter(isBareAgentMessageFrame)
      .find((frame) => (frame.text ?? "").startsWith("IMPORTANT: This conversation "));
    expect(
      notice,
      `no auto-compaction notice in the last turn:\n${describeCapture(result)}`,
    ).toBeDefined();
    const numbers = /compressed from: (\d+) to (\d+) tokens/.exec(notice?.text ?? "");
    expect(numbers, `unreadable notice ${JSON.stringify(notice?.text)}`).not.toBeNull();
    // The pre count is the inflated one we fed it, which is what makes this a
    // real trigger rather than a coincidence.
    expect(Number(numbers?.[1])).toBe(INFLATED_PROMPT_TOKENS);
    // Re-build the notice from the observed numbers and demand the same string.
    const model = /input token limit for (.+?)\. A compressed/.exec(notice?.text ?? "")?.[1];
    expect(model, `no model name in ${JSON.stringify(notice?.text)}`).toBeDefined();
    expect(notice?.text).toBe(
      qwenAutoCompressionDiagnostic({
        model: model ?? "",
        originalTokenCount: Number(numbers?.[1]),
        newTokenCount: Number(numbers?.[2]),
      }),
    );
    // And the envelope: no `_meta` at all, which is the whole hazard.
    const observed = (result.allUpdates as ReadonlyArray<unknown>).find((params) =>
      JSON.stringify(params).includes("IMPORTANT: This conversation "),
    ) as Record<string, unknown> | undefined;
    expect(observed?.["update"]).toEqual(qwenEmitAgentDiagnosticMessage(notice?.text ?? ""));
  });

  it("emits the notice BEFORE the turn's own output, and a usage frame after", () => {
    const frames = readCapturedFrames(result.turns.at(-1)?.updates ?? []);
    const noticeIndex = frames.findIndex((frame) =>
      (frame.text ?? "").startsWith("IMPORTANT: This conversation "),
    );
    expect(noticeIndex, describeCapture(result)).toBeGreaterThanOrEqual(0);
    const answerIndex = frames.findIndex((frame) => (frame.text ?? "").includes("CONTINUE"));
    expect(answerIndex).toBeGreaterThan(noticeIndex);
    const usageIndex = frames.findIndex(isUsageFrame);
    expect(usageIndex, "the turn must close with a usage frame").toBeGreaterThan(noticeIndex);
    expect(usageInputTokens(frames[usageIndex]!)).toBeTypeOf("number");
  });
});

gated("real qwen 0.21.1 — auto-compaction on a CONTINUATION send", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("auto-compaction-on-continuation");
  }, 180_000);

  it("emits the notice AFTER the turn has spoken and run a tool", () => {
    // THE POSITION CLAIM. qwen runs its compaction check before EVERY send of
    // the turn loop (Session.ts:3602 → :3655), so the notice can arrive from a
    // tool-result continuation — after the turn's own text and its tool frames.
    // A gate keyed on "the turn's opening agent message" cannot see it there.
    const frames = readCapturedFrames(result.turns.at(-1)?.updates ?? []);
    const firstTextIndex = frames.findIndex((frame) =>
      (frame.text ?? "").startsWith("Listing the directory"),
    );
    const toolIndex = frames.findIndex((frame) => frame.sessionUpdate === "tool_call");
    const noticeIndex = frames.findIndex((frame) =>
      (frame.text ?? "").startsWith("IMPORTANT: This conversation "),
    );
    expect(firstTextIndex, describeCapture(result)).toBeGreaterThanOrEqual(0);
    expect(toolIndex, describeCapture(result)).toBeGreaterThan(firstTextIndex);
    expect(
      noticeIndex,
      `the notice never arrived on the continuation:\n${describeCapture(result)}`,
    ).toBeGreaterThan(toolIndex);
    // Still the BARE channel — no marker of any kind to route on.
    expect(isBareAgentMessageFrame(frames[noticeIndex]!)).toBe(true);
    expect(result.turns.at(-1)?.stopReason).toBe("end_turn");
  });

  it("the continuation notice is byte-identical to the fake's builder", () => {
    const frames = readCapturedFrames(result.turns.at(-1)?.updates ?? []);
    const notice = frames.find((frame) =>
      (frame.text ?? "").startsWith("IMPORTANT: This conversation "),
    );
    const numbers = /compressed from: (\d+) to (\d+) tokens/.exec(notice?.text ?? "");
    expect(numbers, `unreadable notice ${JSON.stringify(notice?.text)}`).not.toBeNull();
    // The pre count is the inflated one the mock reported on the FIRST send,
    // which is what makes this a real continuation trigger.
    expect(Number(numbers?.[1])).toBe(INFLATED_PROMPT_TOKENS);
    const model = /input token limit for (.+?)\. A compressed/.exec(notice?.text ?? "")?.[1];
    expect(notice?.text).toBe(
      qwenAutoCompressionDiagnostic({
        model: model ?? "",
        originalTokenCount: Number(numbers?.[1]),
        newTokenCount: Number(numbers?.[2]),
      }),
    );
  });

  it("carries the head the adapter's gate admits it by", () => {
    // The gate's second admission path, checked against the binary rather than
    // against the emitter source alone.
    const notice = readCapturedFrames(result.turns.at(-1)?.updates ?? []).find((frame) =>
      (frame.text ?? "").startsWith("IMPORTANT: This conversation "),
    );
    expect(hasQwenDiagnosticHead(notice?.text ?? "")).toBe(true);
  });
});

gated("real qwen 0.21.1 — the session-cap notice", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("session-token-limit");
  }, 180_000);

  it("REPLACES the compaction notice: ONE bare frame, and max_tokens", () => {
    const turn = result.turns.at(-1);
    // The send is dropped, so no model round follows.
    expect(turn?.stopReason, describeCapture(result)).toBe("max_tokens");
    const frames = readCapturedFrames(turn?.updates ?? []);
    expect(
      frames.length,
      `the cap turn must carry exactly one frame:\n${describeCapture(result)}`,
    ).toBe(1);
    const cap = frames[0]!;
    expect(isBareAgentMessageFrame(cap)).toBe(true);
    expect(cap.text ?? "").toMatch(/^Session token limit exceeded: /);
    // The compaction DID happen (the count below is post-compaction) and its
    // notice was NOT emitted — the cap's early return at Session.ts:4432 comes
    // before the compaction emit at :4436-4440.
    expect(textsOf(frames).join("")).not.toContain("IMPORTANT: This conversation ");
  });

  it("the cap notice is byte-identical to what the fake's builder produces", () => {
    const cap = readCapturedFrames(result.turns.at(-1)?.updates ?? [])[0];
    const numbers = /exceeded: (\d+) tokens > (\d+) limit/.exec(cap?.text ?? "");
    expect(numbers, `unreadable cap notice ${JSON.stringify(cap?.text)}`).not.toBeNull();
    expect(Number(numbers?.[2])).toBe(SESSION_TOKEN_LIMIT);
    expect(cap?.text).toBe(
      qwenSessionTokenLimitDiagnostic({
        tokens: Number(numbers?.[1]),
        limit: Number(numbers?.[2]),
      }),
    );
    // Same BARE envelope as the compaction notice — no `_meta` at all.
    expect(cap?.meta).toBeUndefined();
  });

  it("never says compress — a word-based reading alone cannot see it", () => {
    const cap = readCapturedFrames(result.turns.at(-1)?.updates ?? [])[0];
    expect((cap?.text ?? "").toLowerCase()).not.toContain("compress");
  });
});

gated("real qwen 0.21.1 — a failed /compress", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("compress-failure");
  }, 180_000);

  it("REJECTS the prompt and emits no RESULT frame — exactly what the fake does", () => {
    const compressTurn = result.turns.at(-1);
    expect(compressTurn?.prompt).toBe("/compress");
    expect(
      compressTurn?.error,
      `the failed /compress resolved instead of rejecting:\n${describeCapture(result)}`,
    ).toBeDefined();
    expect(compressTurn?.stopReason).toBeUndefined();
    // The PROGRESS frame still goes out — `compressCommand` yields it before it
    // throws — and only the RESULT is missing. The fake models exactly this
    // sequence: `emitCompressProgress().emitCompressFailure(…)`.
    const texts = textsOf(readCapturedFrames(compressTurn?.updates ?? []));
    expect(texts).toContain(qwenSlashCommandHardLineBreaks(QWEN_COMPRESS_PROGRESS_MESSAGE));
    expect(texts.join("")).not.toContain("Context compressed");
  });

  it("carries the JSON-RPC shape the fake now emits: -32603 + the generic message", () => {
    const error = result.turns.at(-1)?.error;
    expect(error?.code).toBe(-32603);
    // The reason is NOT in `message` — it is demoted into `data.details`, which
    // is what `QWEN_ACP_INTERNAL_ERROR_MESSAGE` records and why the adapter
    // reads the details for its failed row.
    expect(error?.message).toBe(QWEN_ACP_INTERNAL_ERROR_MESSAGE);
  });

  it("carries qwen's OWN sentence in data.details — the field the adapter reads", () => {
    // THE field the failed-row fix depends on (`readAcpDetails`,
    // QwenAdapter.ts:5417) and the field the fake reproduces
    // (`qwenCompressFailureErrorData`). Asserted here so a qwen bump that moves
    // the sentence back into `message`, or renames `details`, fails loudly
    // instead of silently reverting the row to "Internal error".
    const error = result.turns.at(-1)?.error;
    const details = (error?.data as { readonly details?: unknown } | undefined)?.details;
    expect(typeof details, `no data.details on the rejected prompt: ${JSON.stringify(error)}`).toBe(
      "string",
    );
    expect(details as string).toMatch(/^Failed to compress chat history/);
    // The cause chain the mock's 500 produced is in there too, which is what
    // makes the row worth reading.
    expect(details as string).toContain("500");
  });
});

gated("real qwen 0.21.1 — two sessions on one agent", () => {
  let result: CaptureResult;
  beforeAll(async () => {
    result = await capture("two-sessions");
  }, 180_000);

  it("stamps every compression frame with its OWN sessionId", () => {
    expect(result.sessionIds.length, describeCapture(result)).toBe(2);
    const second = result.sessionIds[1];
    const compressTurn = result.turns.at(-1);
    expect(compressTurn?.sessionId).toBe(second);
    const slash = readCapturedFrames(compressTurn?.updates ?? []).filter(isSlashCommandFrame);
    expect(slash.length).toBeGreaterThanOrEqual(2);
    for (const frame of slash) {
      expect(frame.sessionId, "a compression frame must name its session").toBe(second);
    }
  });
});
