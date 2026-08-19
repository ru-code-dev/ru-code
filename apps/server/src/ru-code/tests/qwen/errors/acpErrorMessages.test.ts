// ru-code: every `AcpError` class in `packages/effect-acp/src/errors.ts`
// must produce a non-empty `.message`. This guards against side-bug 1
// regressions — a future maintainer removing a `message` getter would cause
// `mapAcpToAdapterError` to build `ProviderAdapterRequestError({ detail: "" })`,
// which silently breaks the UI failure path (see the tripwire in
// `ProviderCommandReactor.ts`).

import { describe, expect, it } from "vite-plus/test";

import {
  AcpProcessExitedError,
  AcpProtocolParseError,
  AcpRequestError,
  AcpSpawnError,
  AcpTransportError,
} from "effect-acp/errors";

describe("AcpError class .message getters", () => {
  it("AcpSpawnError without command", () => {
    const err = new AcpSpawnError({ cause: new Error("spawn ENOENT") });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("Failed to spawn");
  });

  it("AcpSpawnError with command", () => {
    const err = new AcpSpawnError({ command: "cli --acp", cause: new Error("x") });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("cli --acp");
  });

  it("AcpProcessExitedError without code", () => {
    const err = new AcpProcessExitedError({});
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("ACP process exited");
  });

  it("AcpProcessExitedError with code", () => {
    const err = new AcpProcessExitedError({ code: 42 });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("42");
  });

  it("AcpProtocolParseError", () => {
    // port adapt: upstream effect-acp's class takes `operation` (no `detail`
    // field) and its message names the operation rather than echoing detail.
    const err = new AcpProtocolParseError({
      operation: "decode-wire-message",
      cause: new Error("bad JSON"),
    });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("decode-wire-message");
  });

  it("AcpTransportError — getter must exist and be non-empty", () => {
    // an earlier variant's side-bug-1 guard asserted `.message` echoed `detail`. The port's
    // upstream effect-acp composes message from `operation`/`method` instead and
    // does NOT echo detail, so we assert the surviving invariant: the getter
    // exists and is non-empty (an empty message is what broke the UI failure
    // path). The qwen C4 recognizer matches this class by tag, not by message.
    const err = new AcpTransportError({
      operation: "call-rpc",
      detail: "broken pipe",
      cause: new Error("EPIPE"),
    });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("transport");
  });

  it("AcpRequestError — message is errorMessage", () => {
    const err = new AcpRequestError({
      code: -32603,
      errorMessage: "Internal error",
    });
    expect(err.message).toBe("Internal error");
  });

  it("AcpRequestError.fromProtocolError preserves wire shape", () => {
    // port adapt: upstream signature is fromProtocolError(error, context) where
    // context.method is required (an earlier variant took a single arg). The wire fields
    // (code / message / data) are still preserved verbatim.
    const err = AcpRequestError.fromProtocolError(
      {
        code: -32603,
        message: "Internal error",
        data: { details: "Model stream ended ..." },
      },
      { method: "session/prompt" },
    );
    expect(err.code).toBe(-32603);
    expect(err.message).toBe("Internal error");
    expect(err.data).toEqual({ details: "Model stream ended ..." });
  });
});
