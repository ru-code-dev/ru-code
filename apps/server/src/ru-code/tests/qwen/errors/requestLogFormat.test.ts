// ru-code: coverage of the `[cli-acp.request.failed]` log formatters
// (`requestLogFormat.ts`). Two pure exports:
//   - describeRequestFailure(cause): AcpRequestError → {code,message,details?};
//     anything else → {cause: <composed message, never a stack>}.
//   - describeRequestPayload(payload): summarizes each `prompt` block to a single
//     STRING ("text: …" truncated at 120 chars, "image: image/png", bare type),
//     leaving non-prompt payloads untouched (same reference).
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AcpRequestError } from "effect-acp/errors";

import {
  describeRequestFailure,
  describeRequestPayload,
} from "@ru-code/qwen/errors/requestLogFormat";

const acpError = (
  code: number,
  options?: { readonly details?: unknown; readonly message?: string },
) =>
  new AcpRequestError({
    code: code as never,
    errorMessage: options?.message ?? "rpc failed",
    ...(options !== undefined && "details" in options
      ? { data: { details: options.details } }
      : {}),
  });

describe("describeRequestFailure", () => {
  it("AcpRequestError with string details → code + message + details", () => {
    const cause = Cause.fail(acpError(-32603, { message: "model unloaded", details: "gpu OOM" }));
    expect(describeRequestFailure(cause)).toEqual({
      code: -32603,
      message: "model unloaded",
      details: "gpu OOM",
    });
  });

  it("AcpRequestError without details → code + message only (no details key)", () => {
    const result = describeRequestFailure(Cause.fail(acpError(429, { message: "rate limited" })));
    expect(result).toEqual({ code: 429, message: "rate limited" });
    expect(result).not.toHaveProperty("details");
  });

  it("AcpRequestError whose data.details is non-string → details omitted", () => {
    const result = describeRequestFailure(Cause.fail(acpError(-32000, { details: 12345 })));
    expect(result).toEqual({ code: -32000, message: "rpc failed" });
    expect(result).not.toHaveProperty("details");
  });

  it("non-Acp failure with a .message → { cause: <message> } (no stack)", () => {
    const result = describeRequestFailure(Cause.fail(new Error("transport died")));
    expect(result).toEqual({ cause: "transport died" });
  });

  it("non-Acp defect (Cause.die) → squashed and reduced to its message", () => {
    const result = describeRequestFailure(Cause.die(new Error("synchronous throw")));
    expect(result).toEqual({ cause: "synchronous throw" });
  });

  it("primitive string failure → String(error)", () => {
    const result = describeRequestFailure(Cause.fail("plain boom"));
    expect(result).toEqual({ cause: "plain boom" });
  });

  it("object failure with empty message → falls back to String(error)", () => {
    const result = describeRequestFailure(Cause.fail({ message: "" }));
    expect(result).toEqual({ cause: "[object Object]" });
  });
});

describe("describeRequestPayload", () => {
  it("non-object payload → passthrough (same value)", () => {
    expect(describeRequestPayload("hello")).toBe("hello");
    expect(describeRequestPayload(42)).toBe(42);
    expect(describeRequestPayload(null)).toBe(null);
  });

  it("object without a 'prompt' key → passthrough (same reference)", () => {
    const payload = { sessionId: "s1", method: "session/prompt" };
    expect(describeRequestPayload(payload)).toBe(payload);
  });

  it("prompt present but not an array → passthrough (same reference)", () => {
    const payload = { prompt: "not-an-array", sessionId: "s1" };
    expect(describeRequestPayload(payload)).toBe(payload);
  });

  it("summarizes each prompt block to a string and preserves sibling fields", () => {
    const longText = "x".repeat(200);
    const payload = {
      sessionId: "s1",
      prompt: [
        { type: "text", text: "hi there" },
        { type: "image", mimeType: "image/png", data: "AAAA-base64-blob" },
        { type: "audio" },
        "raw-string-part",
        { type: "text", text: longText },
        { type: "text", text: 123 },
      ],
    };

    const result = describeRequestPayload(payload) as { sessionId: string; prompt: unknown[] };
    expect(result).not.toBe(payload); // new object, not mutated in place
    expect(result.sessionId).toBe("s1");
    expect(result.prompt).toEqual([
      "text: hi there",
      "image: image/png",
      "audio",
      "raw-string-part",
      `text: ${"x".repeat(120)}…`,
      "text", // text field not a string → falls through to the bare type
    ]);
  });
});
