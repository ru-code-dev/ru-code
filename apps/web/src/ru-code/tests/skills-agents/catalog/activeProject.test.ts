import { describe, expect, it } from "vite-plus/test";

import { resolveActiveProjectId } from "../../../skills-agents/catalog/activeProject.ts";

// ru-code: the pure route→active-project-id decision the composer + panel depend on. Returning the
// current project's ProjectId (which the catalog now keys by) is what makes project skills appear in
// the composer; returning null (no route) keeps it to globals only.
describe("resolveActiveProjectId", () => {
  it("a server-thread route yields the thread's projectId", () => {
    expect(
      resolveActiveProjectId({
        routeKind: "server",
        threadProjectId: "proj-alpha",
        draftProjectId: null,
      }),
    ).toBe("proj-alpha");
  });

  it("a draft route yields the draft's projectId", () => {
    expect(
      resolveActiveProjectId({
        routeKind: "draft",
        threadProjectId: null,
        draftProjectId: "proj-draft",
      }),
    ).toBe("proj-draft");
  });

  it("no route (global surface) yields null → composer shows globals only", () => {
    expect(
      resolveActiveProjectId({ routeKind: null, threadProjectId: "x", draftProjectId: "y" }),
    ).toBeNull();
  });

  it("a server route whose thread has not loaded yet yields null (not the draft's id)", () => {
    expect(
      resolveActiveProjectId({
        routeKind: "server",
        threadProjectId: null,
        draftProjectId: "proj-draft",
      }),
    ).toBeNull();
  });
});
