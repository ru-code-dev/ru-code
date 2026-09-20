// ru-code v2 (S1 §7.5): the root-level attribution `main.tsx`'s `onCaughtError` hook uses.
//
// The claim is narrow on purpose. A throw from a plugin's `useEffect` CLEANUP is caught by React at
// the ROOT — no error boundary is alive for it — so the only evidence available is the stack, and
// the only honest rule is "a frame naming `/plugins/<id>/` is that plugin's code". Everything else
// is the APP's fault and must stay unattributed: blaming a plugin for an app error is worse than
// saying nothing, and it is the mistake v1 round 2 made by asking whether a panel was open.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";
import { pluginIdFromStack, reportPluginRootError } from "../../plugins/rootErrors";
import { recordPluginDisplayName, resetPluginDisplayNames } from "../../plugins/status";

/** A stack of the shape a browser really produces for a plugin's own module. */
const pluginStack = (id: string) =>
  [
    "Error: cleanup exploded",
    `    at Object.destroy (http://localhost:5173/plugins/${id}/web/index.mjs:12:9)`,
    "    at safelyCallDestroy (http://localhost:5173/assets/react-dom-abc.js:1:2)",
  ].join("\n");

beforeEach(() => {
  resetPluginProblems();
  resetPluginDisplayNames();
});

describe("pluginIdFromStack", () => {
  it("names the plugin whose module URL is in the stack", () => {
    expect(pluginIdFromStack(pluginStack("analytics"))).toBe("analytics");
  });

  it("answers null for an app-only stack, a missing stack and a non-string", () => {
    expect(
      pluginIdFromStack("Error: boom\n    at http://localhost:5173/assets/index-abc.js:1:2"),
    ).toBe(null);
    expect(pluginIdFromStack(undefined)).toBe(null);
    expect(pluginIdFromStack(42)).toBe(null);
  });

  it("ignores a `/plugins/` path segment that is not a legal plugin id", () => {
    // The host refuses a folder whose name is not a slug, so a frame like this cannot be a
    // plugin's code — and reporting it would invent a plugin the user cannot find.
    expect(pluginIdFromStack("at http://localhost:5173/plugins/Not A Slug/web/index.mjs:1:1")).toBe(
      null,
    );
  });

  it("reads the plugin PAGE route as well — it is the same `/plugins/<id>/` shape", () => {
    expect(pluginIdFromStack("at http://localhost:5173/plugins/demo/notes:1:1")).toBe("demo");
  });
});

describe("reportPluginRootError", () => {
  it("reports through the host's own record, under the plugin's display name", () => {
    recordPluginDisplayName("analytics", "Analytics");
    const error = new Error("cleanup exploded");
    error.stack = pluginStack("analytics");
    expect(reportPluginRootError(error)).toBe("analytics");
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    // No `kind` on a host record (V2-42): severity was the toast's field, and there is no toast.
    expect(problems[0]).toMatchObject({ pluginId: "analytics", code: "root" });
    expect(problems[0]?.title).toContain("Analytics");
    expect(problems[0]?.detail).toBe("cleanup exploded");
  });

  it("finds the frame in React's COMPONENT stack when the JS stack has none", () => {
    const error = new Error("render exploded");
    error.stack = "Error: render exploded\n    at unknown";
    expect(
      reportPluginRootError(error, "\n    at DemoPanel (http://x/plugins/demo/web/index.mjs:1:1)"),
    ).toBe("demo");
  });

  it("reports NOTHING for an app error", () => {
    const error = new Error("app exploded");
    error.stack = "Error: app exploded\n    at http://localhost:5173/assets/index-abc.js:1:2";
    expect(reportPluginRootError(error)).toBe(null);
    expect(getPendingPluginProblems()).toHaveLength(0);
  });

  it("reports ONCE per plugin however many times the same fault repeats", () => {
    // A cleanup that throws on every unmount would otherwise storm the toaster — the defect the
    // `code` gate in `problems.ts` exists for (R3-H4).
    const error = new Error("cleanup exploded");
    error.stack = pluginStack("demo");
    reportPluginRootError(error);
    reportPluginRootError(error);
    reportPluginRootError(error);
    expect(getPendingPluginProblems()).toHaveLength(1);
  });
});
