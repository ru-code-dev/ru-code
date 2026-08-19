// ru-code: the composer-mode → qwen ACP ApprovalMode mapping. `plan` wins; full-access
// and auto-accept-edits map to "auto-edit" (NOT "yolo", which would bypass qwen's L4
// PermissionManager); everything else is "default". A regression here silently sends the
// wrong approval mode to the CLI, so it gets direct coverage.
// RuntimeMode literals (contracts/orchestration.ts): "approval-required" | "auto-accept-edits" | "full-access".
import { describe, expect, it } from "vite-plus/test";

import { resolveQwenMode } from "../../qwen/QwenAdapter.ts";

describe("resolveQwenMode", () => {
  it("plan interaction mode wins over runtimeMode", () => {
    expect(resolveQwenMode({ interactionMode: "plan", runtimeMode: "full-access" })).toBe("plan");
    expect(resolveQwenMode({ interactionMode: "plan", runtimeMode: "approval-required" })).toBe(
      "plan",
    );
    expect(resolveQwenMode({ interactionMode: "plan", runtimeMode: "auto-accept-edits" })).toBe(
      "plan",
    );
  });

  it("full-access and auto-accept-edits map to auto-edit (NOT yolo)", () => {
    expect(resolveQwenMode({ interactionMode: undefined, runtimeMode: "full-access" })).toBe(
      "auto-edit",
    );
    expect(resolveQwenMode({ interactionMode: undefined, runtimeMode: "auto-accept-edits" })).toBe(
      "auto-edit",
    );
    expect(resolveQwenMode({ interactionMode: "default", runtimeMode: "full-access" })).toBe(
      "auto-edit",
    );
  });

  it("approval-required maps to default", () => {
    expect(resolveQwenMode({ interactionMode: "default", runtimeMode: "approval-required" })).toBe(
      "default",
    );
    expect(resolveQwenMode({ interactionMode: undefined, runtimeMode: "approval-required" })).toBe(
      "default",
    );
  });
});
