// ru-code: guards the regression where qwen's JSON-RPC error `Die`s collapsed to
// opaque defects (E) instead of typed protocol errors, defeating the A-bucket
// recognizers (A1-A7). If this coercion is ever dropped again, these fail.
import { describe, expect, it } from "vite-plus/test";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

import {
  coerceProtocolErrorDefects,
  isProtocolErrorDefect,
} from "../../protocol/coerceProtocolErrorDefects.ts";

// Minimal encoded-Exit builders. The coercion only reads exit._tag + exit.cause[]
// and rewrites Die→Fail, so a structural literal is a faithful input.
const failure = (cause: ReadonlyArray<Record<string, unknown>>): RpcMessage.ResponseExitEncoded =>
  ({
    _tag: "Exit",
    requestId: "1",
    exit: { _tag: "Failure", cause },
  }) as unknown as RpcMessage.ResponseExitEncoded;

const dieProtocol = (code: number, message: string, data?: unknown) => ({
  _tag: "Die" as const,
  defect: { code, message, ...(data !== undefined ? { data } : {}) },
});

describe("isProtocolErrorDefect", () => {
  it("accepts a numeric code + string message object", () => {
    expect(isProtocolErrorDefect({ code: -32000, message: "auth" })).toBe(true);
  });
  it("rejects a plain Error (no numeric code)", () => {
    expect(isProtocolErrorDefect(new Error("boom"))).toBe(false);
  });
  it("rejects non-objects and a string code", () => {
    expect(isProtocolErrorDefect("nope")).toBe(false);
    expect(isProtocolErrorDefect({ code: "-32000", message: "auth" })).toBe(false);
    expect(isProtocolErrorDefect(null)).toBe(false);
  });
});

describe("coerceProtocolErrorDefects", () => {
  it("rewrites a protocol-shaped Die into a Fail, preserving code + data", () => {
    const defect = { code: -32000, message: "auth required", data: { details: "no key" } };
    const result = coerceProtocolErrorDefects(failure([{ _tag: "Die", defect }]));

    const entry = (result.exit as { cause: ReadonlyArray<Record<string, unknown>> }).cause[0]!;
    expect(entry._tag).toBe("Fail");
    expect(entry.error).toEqual(defect);
  });

  it("leaves a non-protocol Die (plain Error) untouched — returns the same reference", () => {
    const input = failure([{ _tag: "Die", defect: new Error("synchronous throw") }]);
    expect(coerceProtocolErrorDefects(input)).toBe(input);
  });

  it("leaves an already-typed Fail entry untouched", () => {
    const input = failure([{ _tag: "Fail", error: { code: -32000, message: "auth" } }]);
    expect(coerceProtocolErrorDefects(input)).toBe(input);
  });

  it("leaves a Success exit untouched", () => {
    const input = {
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: {} },
    } as unknown as RpcMessage.ResponseExitEncoded;
    expect(coerceProtocolErrorDefects(input)).toBe(input);
  });

  it("rewrites only the protocol Die in a mixed cause, keeping the others", () => {
    const plainDie = { _tag: "Die" as const, defect: new Error("boom") };
    const existingFail = { _tag: "Fail" as const, error: { code: -32001, message: "x" } };
    const result = coerceProtocolErrorDefects(
      failure([dieProtocol(429, "rate limit"), plainDie, existingFail]),
    );

    const cause = (result.exit as { cause: ReadonlyArray<Record<string, unknown>> }).cause;
    expect(cause[0]!._tag).toBe("Fail");
    expect(cause[0]!.error).toEqual({ code: 429, message: "rate limit" });
    expect(cause[1]).toBe(plainDie); // plain Die entry preserved by identity
    expect(cause[2]).toBe(existingFail); // existing Fail entry preserved by identity
  });
});
