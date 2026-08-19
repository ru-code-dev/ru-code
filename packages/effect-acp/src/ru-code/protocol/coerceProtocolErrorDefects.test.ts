// ru-code: validates the Die→Fail coercion directly (not "faithful extraction by
// assertion"). Proves the exact behavior the recognizer registry depends on: a
// protocol-shaped Die (numeric code + string message — the shape qwen's JSON-RPC
// error becomes, confirmed against @agentclientprotocol/sdk 0.14.1 acp.js:788-839:
// thrown Error → {code:-32603, message, data:{details}}) is rewritten into a Fail
// so the RpcClient decodes it via the method's error schema and preserves
// code/data.details for the classifier. Non-protocol defects, interrupts, and
// success exits pass through untouched (by identity).
import { assert, describe, it } from "@effect/vitest";
import { coerceProtocolErrorDefects, isProtocolErrorDefect } from "./coerceProtocolErrorDefects.ts";

// The real internalError shape the SDK produces for a thrown empty-stream Error.
const protocolDefect = {
  code: -32603,
  message: "Internal error",
  data: { details: "Model stream ended with empty response text." },
};

// Minimal ResponseExitEncoded — the function only reads exit._tag, exit.cause[].
const failureExit = (cause: ReadonlyArray<Record<string, unknown>>) =>
  ({ _tag: "Exit", requestId: "req-1", exit: { _tag: "Failure", cause } }) as never;

describe("isProtocolErrorDefect", () => {
  it("accepts a numeric-code + string-message object; rejects everything else", () => {
    assert.isTrue(isProtocolErrorDefect(protocolDefect));
    assert.isTrue(isProtocolErrorDefect({ code: 429, message: "Rate limit exceeded." }));
    assert.isFalse(isProtocolErrorDefect(new Error("boom"))); // no numeric code
    assert.isFalse(isProtocolErrorDefect({ message: "no code" }));
    assert.isFalse(isProtocolErrorDefect({ code: 1 })); // no string message
    assert.isFalse(isProtocolErrorDefect({ code: "x", message: "y" })); // code not number
    assert.isFalse(isProtocolErrorDefect(null));
    assert.isFalse(isProtocolErrorDefect("Internal error"));
  });
});

describe("coerceProtocolErrorDefects", () => {
  it("rewrites a protocol-shaped Die into a Fail carrying the raw code/data", () => {
    const result = coerceProtocolErrorDefects(
      failureExit([{ _tag: "Die", defect: protocolDefect }]),
    );
    const cause = (result as unknown as { exit: { cause: ReadonlyArray<Record<string, unknown>> } })
      .exit.cause;
    assert.deepStrictEqual(cause[0], { _tag: "Fail", error: protocolDefect });
  });

  it("leaves a non-protocol Die untouched (returns the message by identity)", () => {
    const message = failureExit([{ _tag: "Die", defect: new Error("genuine JS defect") }]);
    assert.strictEqual(coerceProtocolErrorDefects(message), message);
  });

  it("leaves an interrupt cause untouched", () => {
    const message = failureExit([{ _tag: "Interrupt", fiberId: 1 }]);
    assert.strictEqual(coerceProtocolErrorDefects(message), message);
  });

  it("returns a Success exit unchanged by identity", () => {
    const message = {
      _tag: "Exit",
      requestId: "req-1",
      exit: { _tag: "Success", value: 1 },
    } as never;
    assert.strictEqual(coerceProtocolErrorDefects(message), message);
  });

  it("rewrites only the protocol Die in a mixed cause, keeping the interrupt", () => {
    const result = coerceProtocolErrorDefects(
      failureExit([
        { _tag: "Die", defect: protocolDefect },
        { _tag: "Interrupt", fiberId: 2 },
      ]),
    );
    const cause = (result as unknown as { exit: { cause: ReadonlyArray<Record<string, unknown>> } })
      .exit.cause;
    assert.deepStrictEqual(cause[0], { _tag: "Fail", error: protocolDefect });
    assert.deepStrictEqual(cause[1], { _tag: "Interrupt", fiberId: 2 });
  });
});
