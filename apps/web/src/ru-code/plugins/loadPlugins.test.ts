// ru-code: the loader's FAILURE posture (mvp-plan guardrail 8) — the property the whole
// drop-in story rests on: nothing a plugin (or a missing/old server) does can stop the app
// from rendering. `loadPlugins()` runs AFTER `createRoot(...)` (A4 finding H2/M2), never
// rejects, and caps each plugin's import+activate with its own timeout, so a plugin that
// HANGS is disabled rather than fatal.
//
// The three collaborators are injected (`fetchManifests`, `importModule`, `appendStylesheet`)
// so the loop itself is testable without a server, a DOM, or a real dynamic import.

import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  findAppStylesheet,
  loadPlugins,
  PLUGIN_STYLESHEET_ATTRIBUTE,
  resolveActivate,
  resolveWebEntryPath,
} from "./loadPlugins";
import { getPendingPluginProblems, resetPluginProblems } from "./problems";
import {
  resetRegisteredOverlayPanels,
  overlayPanels,
} from "../skills-agents/rightGlobalPanel/registry";
import {
  getPluginStatuses,
  pluginDisplayName,
  resetPluginStatuses,
  resetPluginDisplayNames,
} from "./status";
import { resetPluginComposerItems } from "./composerRegistry";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const manifest = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  state: "loaded",
  hasWeb: true,
  hasServer: false,
  ...over,
});

beforeEach(() => {
  resetPluginStatuses();
  resetPluginProblems();
  resetRegisteredOverlayPanels();
  resetPluginDisplayNames();
  resetPluginComposerItems();
});

describe("resolveActivate", () => {
  it("accepts a definition object and a bare function, and refuses anything else", () => {
    const asObject = { activate: () => undefined };
    expect(resolveActivate(asObject)).toBeTypeOf("function");
    const asFunction = () => undefined;
    expect(resolveActivate(asFunction)).toBe(asFunction);
    expect(resolveActivate(undefined)).toBeNull();
    expect(resolveActivate(null)).toBeNull();
    expect(resolveActivate({ activate: 3 })).toBeNull();
    expect(resolveActivate("nope")).toBeNull();
  });

  it("keeps `this` bound to the definition object (the SDK's definePlugin shape)", async () => {
    const definition = {
      seen: false,
      activate() {
        this.seen = true;
      },
    };
    const activate = resolveActivate(definition);
    expect(activate).not.toBeNull();
    await activate?.({} as never);
    expect(definition.seen).toBe(true);
  });
});

describe("the manifests fetch", () => {
  it("a 404 loads zero plugins and does not throw", async () => {
    await expect(
      loadPlugins({ fetchManifests: async () => new Response("", { status: 404 }) }),
    ).resolves.toBeUndefined();
    expect(getPluginStatuses()).toHaveLength(0);
  });

  it("a network error loads zero plugins and does not throw", async () => {
    await expect(
      loadPlugins({
        fetchManifests: () => Promise.reject(new TypeError("Failed to fetch")),
      }),
    ).resolves.toBeUndefined();
    expect(getPluginStatuses()).toHaveLength(0);
  });

  it("a payload that is not a WebManifestList loads zero plugins and does not throw", async () => {
    await expect(
      loadPlugins({ fetchManifests: async () => jsonResponse({ nope: true }) }),
    ).resolves.toBeUndefined();
    expect(getPluginStatuses()).toHaveLength(0);
  });
});

describe("per-plugin isolation", () => {
  it("a plugin whose activate throws is recorded failed, and the NEXT plugin still loads", async () => {
    const imported: string[] = [];
    await loadPlugins({
      fetchManifests: async () =>
        jsonResponse([
          manifest({ id: "broken", name: "Broken" }),
          manifest({ id: "good", name: "Good" }),
        ]),
      importModule: async (url) => {
        imported.push(url);
        return url.includes("broken")
          ? {
              default: {
                activate: () => {
                  throw new Error("boom");
                },
              },
            }
          : { default: { activate: () => undefined } };
      },
      appendStylesheet: () => undefined,
    });

    expect(imported).toEqual(["/plugins/broken/web/index.mjs", "/plugins/good/web/index.mjs"]);
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["broken", "failed"],
      ["good", "loaded"],
    ]);
    expect(getPluginStatuses()[0]?.error).toContain("boom");
  });

  it("surfaces the failure as one queued toast, addressed to the plugin that failed", async () => {
    await loadPlugins({
      fetchManifests: async () => jsonResponse([manifest({ id: "broken", name: "Broken" })]),
      importModule: async () => ({
        default: { activate: () => Promise.reject(new Error("nope")) },
      }),
      appendStylesheet: () => undefined,
    });
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("error");
    expect(problems[0]?.pluginId).toBe("broken");
    expect(problems[0]?.detail).toContain("nope");
  });

  it("a module with no usable default is a failure, not a crash", async () => {
    await loadPlugins({
      fetchManifests: async () => jsonResponse([manifest()]),
      importModule: async () => ({ notDefault: 1 }),
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses()[0]?.state).toBe("failed");
    expect(getPluginStatuses()[0]?.error).toContain("activate");
  });

  it("skips a plugin the server did not load, and one with no web half", async () => {
    await loadPlugins({
      fetchManifests: async () =>
        jsonResponse([
          manifest({ id: "server-failed", state: "failed", error: "bad json" }),
          manifest({ id: "server-only", hasWeb: false }),
        ]),
      importModule: async () => {
        throw new Error("must not be imported");
      },
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["server-failed", "failed"],
      ["server-only", "skipped"],
    ]);
  });

  // A9 finding MEDIUM-1: a SERVER-side failure used to be silent in the UI — the whole class
  // of "bad migration / throwing server activate" produced no toast and no console line, so a
  // user saw an app that simply ignored their plugin.
  it("toasts a server-side failure once, without importing anything, and leaves a healthy plugin alone", async () => {
    const imported: string[] = [];
    await loadPlugins({
      fetchManifests: async () =>
        jsonResponse([
          manifest({
            id: "server-failed",
            name: "Server Failed",
            state: "failed",
            error: "activate() failed: boom",
          }),
          manifest({ id: "good", name: "Good" }),
        ]),
      importModule: async (url) => {
        imported.push(url);
        return { default: { activate: () => undefined } };
      },
      appendStylesheet: () => undefined,
    });

    // Only the healthy plugin was fetched; the failed one is never imported.
    expect(imported).toEqual(["/plugins/good/web/index.mjs"]);
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("error");
    expect(problems[0]?.pluginId).toBe("server-failed");
    // The plugin's DISPLAY name, not its id, and the server's own reason as the detail.
    expect(problems[0]?.title).toContain("Server Failed");
    expect(problems[0]?.detail).toBe("activate() failed: boom");
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["server-failed", "failed"],
      ["good", "loaded"],
    ]);
  });

  it("toasts a skipped plugin once too (a manifest the server refused)", async () => {
    await loadPlugins({
      fetchManifests: async () =>
        jsonResponse([
          manifest({
            id: "malformed",
            name: "malformed",
            state: "skipped",
            hasWeb: false,
            error: "plugin.json did not decode",
          }),
        ]),
      importModule: async () => {
        throw new Error("must not be imported");
      },
      appendStylesheet: () => undefined,
    });
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.pluginId).toBe("malformed");
    expect(problems[0]?.detail).toBe("plugin.json did not decode");
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["malformed", "skipped"],
    ]);
  });

  it("stays silent for a server-only plugin the server DID load", async () => {
    await loadPlugins({
      fetchManifests: async () => jsonResponse([manifest({ id: "server-only", hasWeb: false })]),
      importModule: async () => {
        throw new Error("must not be imported");
      },
      appendStylesheet: () => undefined,
    });
    expect(getPendingPluginProblems()).toHaveLength(0);
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["server-only", "skipped"],
    ]);
  });
});

describe("styles", () => {
  it("appends the stylesheet once per plugin, under the plugin's own route", async () => {
    const hrefs: string[] = [];
    await loadPlugins({
      fetchManifests: async () =>
        jsonResponse([
          manifest({ id: "a", styles: "web/styles.css" }),
          manifest({ id: "b", styles: "web/styles.css" }),
          manifest({ id: "c" }),
        ]),
      importModule: async () => ({ default: { activate: () => undefined } }),
      appendStylesheet: (href) => hrefs.push(href),
    });
    expect(hrefs).toEqual(["/plugins/a/web/styles.css", "/plugins/b/web/styles.css"]);
  });
});

// ru-code (A18 finding H2). The loader used to `document.head.appendChild(link)` the plugin's
// stylesheet, i.e. AFTER the app's own. A plugin sheet is a global `<link>` in the app's document,
// not something scoped to the plugin's markup, so the analytics plugin's Tailwind
// `.hidden{display:none}` and the app's `@media(width>=48rem){.md\:block{display:block}}` became a
// same-specificity fight decided by source order — and the plugin won every one of them. Measured
// in a real browser: `[data-slot="sidebar"]` computed `display:none`, the whole footer nav went
// away, and with it the button that opens the plugin's own panel.
//
// The rule is therefore "before the first sheet the APP emitted", and this is that rule.
describe("where a plugin stylesheet is inserted", () => {
  const el = (tagName: string, attributes: Record<string, string> = {}) => ({
    tagName,
    id: attributes["id"] ?? "",
    getAttribute: (name: string): string | null => attributes[name] ?? null,
  });

  it("anchors on the app's built <link rel=stylesheet>", () => {
    const head = [
      el("META", { charset: "utf-8" }),
      el("TITLE"),
      el("SCRIPT", { type: "importmap" }),
      el("LINK", { rel: "preload", id: "preload" }),
      el("LINK", { rel: "stylesheet", id: "app-css" }),
      el("SCRIPT", { type: "module" }),
    ];
    expect(findAppStylesheet(head)?.id).toBe("app-css");
  });

  it("anchors on a <style> when the app is served by the dev server, which emits no <link>", () => {
    const head = [el("META"), el("STYLE", { id: "vite-injected" }), el("SCRIPT")];
    expect(findAppStylesheet(head)?.id).toBe("vite-injected");
  });

  // Plugin sheets must not anchor on each other, or the second plugin would land BEFORE the first
  // and the two would silently swap precedence between reloads.
  it("skips the plugin sheets it already inserted, so plugins keep their load order", () => {
    const head = [
      el("LINK", { rel: "stylesheet", id: "plugin-a", [PLUGIN_STYLESHEET_ATTRIBUTE]: "" }),
      el("LINK", { rel: "stylesheet", id: "plugin-b", [PLUGIN_STYLESHEET_ATTRIBUTE]: "" }),
      el("LINK", { rel: "stylesheet", id: "app-css" }),
    ];
    expect(findAppStylesheet(head)?.id).toBe("app-css");
  });

  // Nothing to go before — the caller appends, which is the old behaviour and is correct here.
  it("returns null when the app has emitted no stylesheet at all", () => {
    expect(findAppStylesheet([el("META"), el("SCRIPT", { type: "module" })])).toBeNull();
    expect(findAppStylesheet([])).toBeNull();
    expect(
      findAppStylesheet([el("LINK", { rel: "icon" }), el("LINK", { rel: "manifest" })]),
    ).toBeNull();
  });
});

describe("the panel a plugin registers", () => {
  it("reaches the shared registry under a namespaced id", async () => {
    await loadPlugins({
      fetchManifests: async () => jsonResponse([manifest({ id: "demo" })]),
      importModule: async () => ({
        default: {
          activate: (host: {
            registerPanel: (panel: { label: string; icon: () => null; render: () => null }) => void;
          }) => {
            host.registerPanel({ label: "Probe", icon: () => null, render: () => null });
          },
        },
      }),
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses()[0]?.state).toBe("loaded");
    expect(overlayPanels().map((panel) => panel.id)).toContain("plugin:demo");
  });
});

describe("the web entry path (A4 finding M3)", () => {
  it("reads `status.web`, and falls back to the fixed layout when there is none", () => {
    // A7 finding L5: `PluginStatus.web` is the ONLY source — the raw-payload fallback that
    // sat between these two only served a server built before the SDK carried the field.
    expect(resolveWebEntryPath({ web: "dist/app.mjs" })).toBe("dist/app.mjs");
    expect(resolveWebEntryPath({})).toBe("web/index.mjs");
  });

  it("refuses a path that would leave the plugin's own folder", () => {
    expect(resolveWebEntryPath({ web: "../../etc/passwd" })).toBe("web/index.mjs");
    expect(resolveWebEntryPath({ web: "/etc/passwd" })).toBe("etc/passwd");
    expect(resolveWebEntryPath({ web: "web/./index.mjs" })).toBe("web/index.mjs");
    expect(resolveWebEntryPath({ web: "web/\u0000.mjs" })).toBe("web/index.mjs");
    expect(resolveWebEntryPath({ web: "" })).toBe("web/index.mjs");
    expect(resolveWebEntryPath({ web: 7 })).toBe("web/index.mjs");
  });

  it("imports the manifest's own entry rather than the hard-coded one", async () => {
    const imported: string[] = [];
    await loadPlugins({
      fetchManifests: async () => jsonResponse([manifest({ id: "demo", web: "dist/entry.mjs" })]),
      importModule: async (url) => {
        imported.push(url);
        return { default: { activate: () => undefined } };
      },
      appendStylesheet: () => undefined,
    });
    expect(imported).toEqual(["/plugins/demo/dist/entry.mjs"]);
    expect(getPluginStatuses()[0]?.state).toBe("loaded");
  });
});

describe("a plugin that never settles (A4 finding H2)", () => {
  it("is recorded failed after the budget instead of hanging the loader", async () => {
    const before = Date.now();
    await loadPlugins({
      timeoutMs: 25,
      fetchManifests: async () => jsonResponse([manifest({ id: "hang", name: "Hang" })]),
      importModule: async () => ({ default: { activate: () => new Promise<void>(() => {}) } }),
      appendStylesheet: () => undefined,
    });
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(getPluginStatuses()[0]?.state).toBe("failed");
    expect(getPluginStatuses()[0]?.error).toContain("timed out");
    expect(getPendingPluginProblems()).toHaveLength(1);
  });

  it("bounds an `import()` that never resolves, too", async () => {
    await loadPlugins({
      timeoutMs: 25,
      fetchManifests: async () => jsonResponse([manifest({ id: "hang" })]),
      importModule: () => new Promise<unknown>(() => {}),
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses()[0]?.state).toBe("failed");
    expect(getPluginStatuses()[0]?.error).toContain("timed out");
  });

  it("does not delay the plugins beside it — they load CONCURRENTLY", async () => {
    let goodLoadedAt = 0;
    await loadPlugins({
      timeoutMs: 200,
      fetchManifests: async () =>
        jsonResponse([
          manifest({ id: "hang", name: "Hang" }),
          manifest({ id: "good", name: "Good" }),
        ]),
      importModule: async (url) =>
        url.includes("hang")
          ? { default: { activate: () => new Promise<void>(() => {}) } }
          : {
              default: {
                activate: () => {
                  goodLoadedAt = Date.now();
                },
              },
            },
      appendStylesheet: () => undefined,
    });
    const settledAt = Date.now();
    // The healthy plugin activated long before the hanging one's budget expired.
    expect(settledAt - goodLoadedAt).toBeGreaterThanOrEqual(150);
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["hang", "failed"],
      ["good", "loaded"],
    ]);
  });

  it("does not hide the healthy plugins' statuses for the whole budget (A7 finding L2)", async () => {
    // The status list is what a human — and the Plugins settings page — reads to find out
    // why a panel is missing. Recording it only after `Promise.all` meant an empty list for
    // the whole of the hanging plugin's budget: exactly the window someone is looking.
    const pending = loadPlugins({
      timeoutMs: 500,
      fetchManifests: async () =>
        jsonResponse([
          manifest({ id: "hang", name: "Hang" }),
          manifest({ id: "good", name: "Good" }),
        ]),
      importModule: async (url) =>
        url.includes("hang")
          ? { default: { activate: () => new Promise<void>(() => {}) } }
          : { default: { activate: () => undefined } },
      appendStylesheet: () => undefined,
    });
    for (let tick = 0; tick < 40 && getPluginStatuses().length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The healthy plugin is visible while the hanging one is still inside its 500 ms budget.
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["good", "loaded"],
    ]);
    await expect(pending).resolves.toBeUndefined();
    // …and the settled list is still in MANIFEST order, not completion order.
    expect(getPluginStatuses().map((status) => [status.id, status.state])).toEqual([
      ["hang", "failed"],
      ["good", "loaded"],
    ]);
  });

  it("labels a timed-out plugin with its NAME, not its raw id (A7 finding L3)", async () => {
    // `makeWebPluginHost` records the display name, and it used to run INSIDE the race — so a
    // plugin that timed out during `import()` left anything it had registered labelled `hang`.
    await loadPlugins({
      timeoutMs: 25,
      fetchManifests: async () => jsonResponse([manifest({ id: "hang", name: "Hang" })]),
      importModule: () => new Promise<unknown>(() => {}),
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses()[0]?.state).toBe("failed");
    expect(pluginDisplayName("hang")).toBe("Hang");
  });

  it("does not hold a timer open for a plugin that loaded fast", async () => {
    // A 30 s budget with a plugin that resolves immediately must still settle at once — the
    // race's timer is cleared on settle, so the test would time out if it were not.
    await loadPlugins({
      timeoutMs: 30_000,
      fetchManifests: async () => jsonResponse([manifest()]),
      importModule: async () => ({ default: { activate: () => undefined } }),
      appendStylesheet: () => undefined,
    });
    expect(getPluginStatuses()[0]?.state).toBe("loaded");
  });
});

describe("the app renders before plugins finish (A4 findings H2 + M2)", () => {
  it("`loadPlugins()` is not awaited by the caller: the boot continues immediately", async () => {
    // main.tsx does `createRoot(...).render(...)` and only THEN `void loadPlugins()`. This
    // models the property that makes that safe: the call returns a promise and nothing about
    // the surrounding synchronous work waits on it, even when the only plugin hangs forever.
    const rendered: string[] = [];
    const pending = loadPlugins({
      timeoutMs: 25,
      fetchManifests: async () => jsonResponse([manifest({ id: "hang" })]),
      importModule: () => new Promise<unknown>(() => {}),
      appendStylesheet: () => undefined,
    });
    rendered.push("first paint");
    expect(rendered).toEqual(["first paint"]);
    expect(getPluginStatuses()).toHaveLength(0);
    await expect(pending).resolves.toBeUndefined();
    expect(getPluginStatuses()[0]?.state).toBe("failed");
  });
});
