// ru-code (A13) — A10 finding P1: a plugin problem must never be handed to a toast manager that
// has no subscriber.
//
// The bug, exactly: `main.tsx` runs `void flushPluginProblems(); void loadPlugins();` right after
// `createRoot(...).render(...)`. `render()` is asynchronous, so React had not committed and base-ui's
// `<Toast.Provider>` had not subscribed — but `flushPluginProblems()` set `viewportReady = true`
// itself, so the SERVER-side failure `loadPlugins()` reports milliseconds later took the "show now"
// path into a manager with an empty listener set and vanished. A10 measured it three times: the
// hanging plugin's toast (~10.9 s in) rendered, the throwing plugin's never did.
//
// The property under test is therefore an ORDERING one and needs no DOM: after
// `flushPluginProblems()` has been called, a problem reported before the TOASTER says it is mounted
// must still be QUEUED. On the old implementation the first assertion below reads 0.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  flushPluginProblems,
  getPendingPluginProblems,
  getPluginProblemRepeats,
  markPluginToastViewportReady,
  MAX_PLUGIN_TOASTS,
  reportPluginProblem,
  resetPluginProblems,
} from "../../plugins/problems";
import { getPluginProblems } from "../../plugins/status";

const problem = (title: string) => ({ kind: "info" as const, pluginId: "demo", title });

beforeEach(() => {
  resetPluginProblems();
});

describe("flushPluginProblems does not forge readiness", () => {
  it("keeps a problem reported AFTER flush() queued until the toaster mounts", async () => {
    // main.tsx's order, verbatim.
    const flushed = flushPluginProblems();
    // …and then the loader reports a failed server-side plugin, a few ms later.
    reportPluginProblem(problem("Плагин «Demo (broken)» не загрузился"));

    // BEFORE: `flushPluginProblems()` had already set the flag, so this was 0 — the message went
    // into `toastManager.add()` with nothing listening and was lost.
    expect(getPendingPluginProblems()).toHaveLength(1);

    // Nothing drains until the toaster says so.
    const raced = await Promise.race([
      flushed.then(() => "flushed" as const),
      Promise.resolve("still-waiting" as const),
    ]);
    expect(raced).toBe("still-waiting");

    markPluginToastViewportReady();
    await flushed;
    expect(getPendingPluginProblems()).toHaveLength(0);
  });

  it("queues everything reported before the mount and drains it in order", async () => {
    reportPluginProblem(problem("first"));
    reportPluginProblem(problem("second"));
    expect(getPendingPluginProblems().map((entry) => entry.title)).toEqual(["first", "second"]);

    const flushed = flushPluginProblems();
    markPluginToastViewportReady();
    await flushed;
    expect(getPendingPluginProblems()).toHaveLength(0);
  });

  it("is idempotent — a remount does not re-drain or re-queue", async () => {
    markPluginToastViewportReady();
    markPluginToastViewportReady();
    reportPluginProblem(problem("after mount"));
    await flushPluginProblems();
    expect(getPendingPluginProblems()).toHaveLength(0);
  });
});

/**
 * ru-code (A13 round 3) — A12 finding R3-H4: the report storm.
 *
 * Round 2 reported every malformed registration, so 300 of them produced 600 toasts and the tab
 * stopped answering `page.evaluate("1+1")` altogether — where a THOUSAND well-formed registrations
 * were capped and booted in 1865 ms. The de-duplication belongs here, under every caller.
 */
describe("de-duplication by (pluginId, code) (R3-H4)", () => {
  it("records one row per plugin per category and counts the rest — and NEVER a toast (V2-42)", () => {
    for (let index = 0; index < 300; index += 1) {
      reportPluginProblem({
        kind: "error",
        pluginId: "badflood",
        code: "panel-invalid",
        title: "Panel was skipped",
        detail: `invalid panel fields: label (${String(index)})`,
      });
    }
    // BEFORE V2-42: one TOAST. Now: no toast at all, one status row, and the count behind it.
    expect(
      getPendingPluginProblems(),
      "the user is told nothing about a plugin's mistakes",
    ).toEqual([]);
    expect(getPluginProblems()).toHaveLength(1);
    expect(getPluginProblems()[0]?.count).toBe(300);
    expect(getPluginProblemRepeats().get("badflood:panel-invalid")).toBe(300);
  });

  it("keeps categories, and plugins, apart", () => {
    reportPluginProblem({ kind: "error", pluginId: "a", code: "panel-invalid", title: "one" });
    reportPluginProblem({ kind: "error", pluginId: "a", code: "composer-invalid", title: "two" });
    reportPluginProblem({ kind: "error", pluginId: "b", code: "panel-invalid", title: "three" });
    expect(getPluginProblems().map((problem) => problem.title)).toEqual(["one", "two", "three"]);
    expect(getPluginProblems().map((problem) => problem.pluginId)).toEqual(["a", "a", "b"]);
    expect(getPendingPluginProblems()).toEqual([]);
  });

  it("does NOT de-duplicate a plugin's own toasts, which have no code", () => {
    // `kind` is the SEVERITY, not a category: de-duplicating on it would show the demo plugin's
    // first «Заметка добавлена» and swallow every note it added afterwards.
    reportPluginProblem({ kind: "success", pluginId: "demo", title: "Note added" });
    reportPluginProblem({ kind: "success", pluginId: "demo", title: "Note added" });
    expect(getPendingPluginProblems()).toHaveLength(2);
  });

  it("still bounds a plugin that loops host.toast, and says so once — in the record", () => {
    for (let index = 0; index < MAX_PLUGIN_TOASTS + 50; index += 1) {
      reportPluginProblem({ kind: "info", pluginId: "shouty", title: `hello ${String(index)}` });
    }
    expect(
      getPendingPluginProblems().filter((problem) => problem.title.startsWith("hello")),
    ).toHaveLength(MAX_PLUGIN_TOASTS);
    // The ceiling is the HOST talking about the plugin, so it is a status row, not a 51st toast.
    expect(getPluginProblems().map((problem) => problem.code)).toEqual(["toast-ceiling"]);
  });
});

// ru-code S38 (V2-42): the two channels, stated as one table.
describe("the host never toasts the user about a plugin (V2-42)", () => {
  it("a CODED problem is a console line and a status row, and nothing else", () => {
    reportPluginProblem({
      kind: "error",
      pluginId: "catalogs",
      code: "seam:panels",
      title: 'Plugin "Catalogs" contributed nothing to panels',
      detail: "panels(ctx) must return an array",
    });
    expect(getPendingPluginProblems(), "no toast is queued").toEqual([]);
    expect(getPluginProblems()).toEqual([
      {
        pluginId: "catalogs",
        code: "seam:panels",
        title: 'Plugin "Catalogs" contributed nothing to panels',
        detail: "panels(ctx) must return an array",
        count: 1,
      },
    ]);
  });

  it("an UN-CODED message is the plugin's own `ctx.toast`, and still reaches the user", () => {
    reportPluginProblem({ kind: "success", pluginId: "demo", title: "Заметка добавлена" });
    expect(getPendingPluginProblems().map((problem) => problem.title)).toEqual([
      "Заметка добавлена",
    ]);
    expect(getPluginProblems(), "and it is not a host finding").toEqual([]);
  });
});
