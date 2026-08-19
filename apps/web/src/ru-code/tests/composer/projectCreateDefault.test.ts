// ru-code: coverage for client-runtime `buildProjectCreateCommand` — a freshly created project
// must not persist any product-specific model slug (or instance id): the live first-served
// resolver owns the default, resolved from whatever is actually installed and enabled.
import { describe, expect, it } from "vite-plus/test";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import { CommandId, ProjectId } from "@t3tools/contracts";

describe("buildProjectCreateCommand — default model selection", () => {
  it("stores no product-specific model default at project creation", () => {
    const cmd = buildProjectCreateCommand({
      commandId: CommandId.make("c1"),
      projectId: ProjectId.make("p1"),
      workspaceRoot: "/tmp/x",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(cmd.defaultModelSelection).toBeNull();
  });
});
