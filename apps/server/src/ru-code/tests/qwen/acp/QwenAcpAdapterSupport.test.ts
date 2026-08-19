// ru-code: coverage for the qwen permission-decision mappers.
//   decisionToPermissionKind — stable UI-decision → ACP permission `kind` map.
//   findPermissionOptionIdByKind — echo back the agent's opaque optionId, never
//   fabricate; null when absent/blank so the caller cancels instead of guessing.
import { describe, expect, it } from "vite-plus/test";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  decisionToPermissionKind,
  findPermissionOptionIdByKind,
  mapAcpToAdapterError,
} from "../../../qwen/acp/QwenAcpAdapterSupport.ts";

const option = (
  kind: EffectAcpSchema.PermissionOption["kind"],
  optionId: string,
): EffectAcpSchema.PermissionOption => ({ kind, optionId, name: `${kind} label` });

describe("decisionToPermissionKind", () => {
  it("maps each decision to its protocol permission kind", () => {
    expect(decisionToPermissionKind("acceptForSession")).toBe("allow_always");
    expect(decisionToPermissionKind("accept")).toBe("allow_once");
    expect(decisionToPermissionKind("decline")).toBe("reject_once");
  });

  it("returns null for cancel (caller short-circuits to a cancelled outcome)", () => {
    expect(decisionToPermissionKind("cancel")).toBeNull();
  });

  it("returns null for an unrecognized decision (default branch)", () => {
    // Exercises the `default` arm without relying on the exhaustive literal type.
    expect(decisionToPermissionKind("nonsense" as ProviderApprovalDecision)).toBeNull();
  });
});

describe("findPermissionOptionIdByKind", () => {
  const options: ReadonlyArray<EffectAcpSchema.PermissionOption> = [
    option("allow_once", "opt-allow-once"),
    option("reject_once", "opt-reject-once"),
  ];

  it("returns the matching option's id", () => {
    expect(findPermissionOptionIdByKind(options, "reject_once")).toBe("opt-reject-once");
  });

  it("trims surrounding whitespace on the returned id", () => {
    expect(
      findPermissionOptionIdByKind([option("allow_always", "  keep-me  ")], "allow_always"),
    ).toBe("keep-me");
  });

  it("returns null when no option of that kind is present", () => {
    expect(findPermissionOptionIdByKind(options, "allow_always")).toBeNull();
  });

  it("returns null when the matched option's id is empty or blank", () => {
    expect(findPermissionOptionIdByKind([option("allow_once", "")], "allow_once")).toBeNull();
    expect(findPermissionOptionIdByKind([option("allow_once", "   ")], "allow_once")).toBeNull();
  });

  it("returns the first match when multiple options share a kind", () => {
    const dupes = [option("allow_once", "first"), option("allow_once", "second")];
    expect(findPermissionOptionIdByKind(dupes, "allow_once")).toBe("first");
  });

  it("returns null against an empty option list", () => {
    expect(findPermissionOptionIdByKind([], "allow_once")).toBeNull();
  });
});

describe("re-exports", () => {
  it("re-exports mapAcpToAdapterError from the shared AcpAdapterSupport", () => {
    expect(typeof mapAcpToAdapterError).toBe("function");
  });
});
