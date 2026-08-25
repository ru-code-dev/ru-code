// ru-code: drift guard for the analytics category classifier. The package matches a
// transcript's first user message against SERVICE_SIGNATURES markers; the actual
// instructions the server sends live in @ru-code/qwen/textgen/instructions. Every marker
// must stay a substring of its instruction — rewording a prompt past its marker fails
// HERE instead of silently misclassifying those sessions as "service".

import { assert, describe, it } from "@effect/vitest";

import { analyticsRpcs } from "@smart-tools/qwen-cli-analytics/contracts";
import { SERVICE_SIGNATURES } from "@smart-tools/qwen-cli-analytics/server";

import { ANALYTICS_RPC_SCOPES } from "../../analytics/analyticsRpcHandlers.ts";
import {
  BRANCH_NAME_INSTRUCTION,
  COMMIT_MESSAGE_INSTRUCTION,
  PR_CONTENT_INSTRUCTION,
  THREAD_TITLE_INSTRUCTION,
} from "@ru-code/qwen/textgen/instructions";

const INSTRUCTION_BY_CATEGORY: Record<string, string> = {
  title: THREAD_TITLE_INSTRUCTION,
  branch: BRANCH_NAME_INSTRUCTION,
  commit: COMMIT_MESSAGE_INSTRUCTION,
  pr: PR_CONTENT_INSTRUCTION,
};

describe("analytics service-signature drift guard", () => {
  it("covers exactly the four one-shot text-generation categories", () => {
    assert.deepStrictEqual(SERVICE_SIGNATURES.map((signature) => signature.category).toSorted(), [
      "branch",
      "commit",
      "pr",
      "title",
    ]);
  });

  it("every marker is a substring of the instruction the server actually sends", () => {
    for (const signature of SERVICE_SIGNATURES) {
      const instruction = INSTRUCTION_BY_CATEGORY[signature.category];
      assert.isDefined(instruction, `no host instruction for category ${signature.category}`);
      assert.include(
        instruction!,
        signature.marker,
        `marker "${signature.marker}" is not a substring of the ${signature.category} instruction`,
      );
    }
  });
});

// ru-code: on this base the scope map DOES have compile-time exhaustiveness — it is spread
// into auth/RpcAuthorization.ts's RPC_REQUIRED_SCOPES, which is `satisfies
// Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>` (RpcAuthorization.ts:142), so a missing
// entry for a minted method is a compile error, not the runtime throw the original comment
// described. Kept anyway: it still pins that our object names exactly the two requests the
// package mints, and it fails fast with a readable message rather than a type error buried in
// the shared table.
describe("analytics RPC scope coverage", () => {
  it("ANALYTICS_RPC_SCOPES covers exactly the minted analytics RPCs", () => {
    const mintedTags = analyticsRpcs.map((rpc) => rpc._tag).toSorted();
    const scopedTags = Object.keys(ANALYTICS_RPC_SCOPES).toSorted();
    assert.deepStrictEqual(scopedTags, mintedTags);
  });
});
