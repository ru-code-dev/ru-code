// ru-fork: every `AcpError` class in `packages/effect-acp/src/errors.ts`
// must produce a non-empty `.message`. This guards against side-bug 1
// regressions (see `ru-fork-instrumental/changes/server-errors-handaling.md`)
// — a future maintainer removing a `message` getter would cause
// `mapAcpToAdapterError` to build `ProviderAdapterRequestError({ detail: "" })`,
// which silently breaks the UI failure path (see the tripwire in
// `ProviderCommandReactor.ts`).

import { describe, expect, it } from "vitest";

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
    const err = new AcpProtocolParseError({ detail: "bad JSON" });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("bad JSON");
  });

  it("AcpTransportError — getter must exist and compose detail", () => {
    // This is the side-bug 1 case. A previous version of this class
    // shipped without an `override get message()`, so `error.message`
    // was the empty string; downstream `ProviderAdapterRequestError`
    // got `detail: ""` and the UI broke silently. This test catches
    // a regression of that getter.
    const err = new AcpTransportError({
      detail: "broken pipe",
      cause: new Error("EPIPE"),
    });
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("broken pipe");
  });

  it("AcpRequestError — message is errorMessage", () => {
    const err = new AcpRequestError({
      code: -32603,
      errorMessage: "Internal error",
    });
    expect(err.message).toBe("Internal error");
  });

  it("AcpRequestError.fromProtocolError preserves wire shape", () => {
    const err = AcpRequestError.fromProtocolError({
      code: -32603,
      message: "Internal error",
      data: { details: "Model stream ended ..." },
    });
    expect(err.code).toBe(-32603);
    expect(err.message).toBe("Internal error");
    expect(err.data).toEqual({ details: "Model stream ended ..." });
  });
});
