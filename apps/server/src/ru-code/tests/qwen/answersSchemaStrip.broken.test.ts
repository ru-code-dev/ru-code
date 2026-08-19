// ru-code: BUG-PROOF (intentionally FAILING in port). Root-cause proof for the
// "answer never reaches the agent" defect. qwen reads structured ask_user_question
// answers from a top-level `answers` sibling field on the request_permission
// RESPONSE (keyed by stringified question index; confirmed in cli-code
// Session.ts:1513-1517 and documented in the OLD worktree's manual schema
// extension at packages/effect-acp/src/_generated/schema.gen.ts:7760-7797).
//
// The port's generated schema is MISSING that field (grep `answers` in
// packages/effect-acp/src/_generated/schema.gen.ts → 0 hits; struct at 7768).
// effect Schema.Struct drops undeclared properties on encode, so the adapter's
// `{ outcome, answers }` return (QwenAdapter.ts:929-939) loses `answers` when the
// effect-acp client encodes the RequestPermissionResponse before writing it to the
// wire (rpc.ts:91-95 binds `success: RequestPermissionResponse`).
//
// This test asserts the CORRECT behavior (answers survive the encode) so it FAILS
// today and will PASS once the manual schema field is restored. Do NOT "fix" it by
// weakening the assertion — the fix is to re-add the field to the schema.
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

describe("BUG: RequestPermissionResponse schema strips ask_user_question answers", () => {
  it("keeps the sibling `answers` field on the encoded wire response", () => {
    const encodeResponse = Schema.encodeSync(AcpSchema.RequestPermissionResponse);

    // The exact shape the QwenAdapter returns for an answered ask_user_question:
    // a `selected` outcome plus the index-keyed `answers` map qwen expects.
    const wire = encodeResponse({
      outcome: { outcome: "selected", optionId: "submit" },
      answers: { "0": "Fruity" },
      // `answers` is not in the port's (broken) schema type; cast to feed the runtime encoder.
    } as any) as Record<string, unknown>;

    // The outcome always survives (it is declared). The bug is that `answers` does
    // not: the port schema never declared it, so encode strips it and qwen sees no
    // answer → "selection not captured". FAILS until the schema field is restored.
    assert.deepStrictEqual(wire["outcome"], { outcome: "selected", optionId: "submit" });
    assert.deepStrictEqual(
      wire["answers"],
      { "0": "Fruity" },
      "qwen reads answers from this top-level field; the port schema drops it on encode",
    );
  });
});
