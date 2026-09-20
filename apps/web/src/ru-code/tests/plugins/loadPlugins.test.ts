// ru-code v2: the loader's contract, which is entirely about FAILURE.
//
// Every claim here is one the app depends on for not breaking: the loader never rejects, a plugin
// that throws or hangs costs only itself, a plugin the SERVER refused is reported to the user
// rather than being silently absent, and — the v2 addition — a plugin that did not finish
// activating contributes NOTHING, because the registry is what every seam runner reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PLUGIN_STYLESHEET_ATTRIBUTE,
  findAppStylesheet,
  loadPlugins,
  resolveWebEntryPath,
  resolveWebPlugin,
} from "../../plugins/loadPlugins";
import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";
import { loadedPlugins, resetLoadedPlugins } from "../../plugins/registry";
import {
  getPluginStatuses,
  resetPluginDisplayNames,
  resetPluginStatuses,
} from "../../plugins/status";

type Manifest = {
  id: string;
  name: string;
  version: string;
  state: "loaded" | "failed" | "skipped";
  hasWeb: boolean;
  hasServer: boolean;
  web?: string | undefined;
  styles?: string | undefined;
  error?: string | undefined;
};

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  state: "loaded",
  hasWeb: true,
  hasServer: false,
  web: "web/index.mjs",
  ...over,
});

const manifestsResponse = (manifests: ReadonlyArray<Manifest>) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manifests) } as Response);

beforeEach(() => {
  resetLoadedPlugins();
  resetPluginProblems();
  resetPluginStatuses();
  resetPluginDisplayNames();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWebPlugin", () => {
  it("accepts any object — every seam is optional in v2", () => {
    expect(resolveWebPlugin({})).toEqual({});
    const plugin = { pages: () => [] };
    expect(resolveWebPlugin(plugin)).toBe(plugin);
  });

  it("rejects a default export that is not an object", () => {
    for (const value of [undefined, null, 42, "plugin", () => {}]) {
      expect(resolveWebPlugin(value)).toBeNull();
    }
  });
});

describe("resolveWebEntryPath", () => {
  it("uses the manifest's own path, and the fixed layout when it declares none", () => {
    expect(resolveWebEntryPath({ web: "dist/browser.mjs" })).toBe("dist/browser.mjs");
    expect(resolveWebEntryPath({})).toBe("web/index.mjs");
  });

  it.each(["../other/index.mjs", "web/../../etc/passwd", "", "a/./b"])(
    "refuses %o and falls back to the fixed layout",
    (path) => {
      expect(resolveWebEntryPath({ web: path })).toBe("web/index.mjs");
    },
  );

  it("strips a leading slash rather than aiming the URL at the site root", () => {
    expect(resolveWebEntryPath({ web: "/web/index.mjs" })).toBe("web/index.mjs");
  });
});

describe("loadPlugins", () => {
  it("imports each web entry and registers the default export", async () => {
    const plugin = { pages: () => [] };
    await loadPlugins({
      fetchManifests: () => manifestsResponse([manifest()]),
      importModule: () => Promise.resolve({ default: plugin }),
      appendStylesheet: () => {},
    });
    expect(loadedPlugins().map((entry) => entry.id)).toEqual(["demo"]);
    expect(loadedPlugins()[0]?.plugin).toBe(plugin);
    expect(getPluginStatuses()[0]?.state).toBe("loaded");
  });

  // S5, step 5 (S4-parity §2.2). The loader maps the manifests CONCURRENTLY, so the order plugins
  // finish activating in is whatever the network and each `activate` decide, and it varied between
  // two runs of the same install. It used to be the registry's order, and therefore the order of
  // every surface: composer sections, footer entries, `[data-plugin-root]` in the DOM. Here the
  // completion order is forced to be the EXACT REVERSE of the manifest order, and the registry
  // must still read back in manifest order.
  it("registers in MANIFEST order even when the plugins activate in reverse", async () => {
    const settle: Array<() => void> = [];
    const activateOf = (index: number) => () =>
      new Promise<void>((resolve) => {
        settle[index] = resolve;
      });
    const loading = loadPlugins({
      fetchManifests: () =>
        manifestsResponse([
          manifest({ id: "alpha", name: "Alpha" }),
          manifest({ id: "beta", name: "Beta" }),
          manifest({ id: "gamma", name: "Gamma" }),
        ]),
      importModule: (url) =>
        Promise.resolve({
          default: {
            activate: activateOf(url.includes("alpha") ? 0 : url.includes("beta") ? 1 : 2),
          },
        }),
      appendStylesheet: () => {},
    });
    // Let the three dynamic imports resolve and the three `activate` calls start.
    for (let tick = 0; tick < 8 && settle.filter(Boolean).length < 3; tick += 1) {
      await Promise.resolve();
    }
    expect(settle.filter(Boolean)).toHaveLength(3);
    // gamma, then beta, then alpha — the opposite of the manifest.
    settle[2]?.();
    await Promise.resolve();
    settle[1]?.();
    await Promise.resolve();
    settle[0]?.();
    await loading;

    expect(loadedPlugins().map((entry) => entry.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(loadedPlugins().map((entry) => entry.order)).toEqual([0, 1, 2]);
    // …and the status table, which already sorted, still agrees with it.
    expect(getPluginStatuses().map((entry) => entry.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps manifest order when a RELOAD replaces one plugin in place", async () => {
    const run = (marker: string) =>
      loadPlugins({
        fetchManifests: () =>
          manifestsResponse([
            manifest({ id: "alpha", name: "Alpha" }),
            manifest({ id: "beta", name: "Beta" }),
          ]),
        // beta resolves first this time; alpha is replaced, not appended.
        importModule: (url) =>
          Promise.resolve({ default: { pages: () => [], marker: `${marker}:${url}` } }),
        appendStylesheet: () => {},
      });
    await run("first");
    await run("second");
    expect(loadedPlugins().map((entry) => entry.id)).toEqual(["alpha", "beta"]);
  });

  it("hands the plugin a ctx bound to its own id", async () => {
    let seen = "";
    await loadPlugins({
      fetchManifests: () => manifestsResponse([manifest({ id: "notes", name: "Notes" })]),
      importModule: () =>
        Promise.resolve({
          default: {
            activate: (ctx: { pluginId: string }) => {
              seen = ctx.pluginId;
            },
          },
        }),
      appendStylesheet: () => {},
    });
    expect(seen).toBe("notes");
  });

  it("calls `activate` when a plugin exports one, and loads a plugin that does not", async () => {
    const activate = vi.fn();
    await loadPlugins({
      fetchManifests: () =>
        manifestsResponse([manifest({ id: "with-life" }), manifest({ id: "no-life" })]),
      importModule: (url) =>
        Promise.resolve({
          default: url.includes("with-life") ? { activate } : { panels: () => [] },
        }),
      appendStylesheet: () => {},
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(
      loadedPlugins()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["no-life", "with-life"]);
  });

  it("a plugin whose activate THROWS is failed and contributes nothing", async () => {
    await loadPlugins({
      fetchManifests: () => manifestsResponse([manifest({ id: "boom" }), manifest({ id: "fine" })]),
      importModule: (url) =>
        Promise.resolve({
          default: url.includes("boom")
            ? {
                pages: () => [],
                activate: () => {
                  throw new Error("activate exploded");
                },
              }
            : {},
        }),
      appendStylesheet: () => {},
    });
    // The registry is what every seam runner reads, so "failed" has to mean "absent from it".
    expect(loadedPlugins().map((entry) => entry.id)).toEqual(["fine"]);
    const boom = getPluginStatuses().find((status) => status.id === "boom");
    expect(boom?.state).toBe("failed");
    expect(boom?.error).toContain("activate exploded");
    expect(getPluginStatuses().find((status) => status.id === "fine")?.state).toBe("loaded");
  });

  it("a plugin that HANGS is failed at its budget and the others still load", async () => {
    await loadPlugins({
      timeoutMs: 20,
      fetchManifests: () => manifestsResponse([manifest({ id: "hang" }), manifest({ id: "fine" })]),
      importModule: (url) =>
        url.includes("hang") ? new Promise(() => {}) : Promise.resolve({ default: {} }),
      appendStylesheet: () => {},
    });
    expect(loadedPlugins().map((entry) => entry.id)).toEqual(["fine"]);
    expect(getPluginStatuses().find((status) => status.id === "hang")?.error).toContain(
      "timed out after 20ms",
    );
  });

  it("reports a plugin the SERVER refused, and stays silent for a server-only plugin", async () => {
    await loadPlugins({
      fetchManifests: () =>
        manifestsResponse([
          manifest({ id: "refused", state: "failed", error: "migration 001 failed" }),
          manifest({ id: "serveronly", hasWeb: false, hasServer: true, web: undefined }),
        ]),
      importModule: () => Promise.resolve({ default: {} }),
      appendStylesheet: () => {},
    });
    const problems = getPendingPluginProblems();
    expect(problems.map((problem) => problem.pluginId)).toEqual(["refused"]);
    expect(problems[0]?.detail).toBe("migration 001 failed");
    expect(getPluginStatuses().find((status) => status.id === "serveronly")?.state).toBe("skipped");
  });

  // S15 A1: every exit resolves, and WHAT it resolves to is the loader's answer to "is this empty
  // registry evidence?". `"unreadable"` is the exit that never saw a plugin list; only `"read"`
  // licenses a consumer to delete the user's state for a plugin that is not in it — the right
  // panel's tab reconcile is that consumer, and a dev server restarting under an open app is the
  // case that made the distinction necessary.
  it("never rejects when the manifest endpoint is missing or unreachable, and says so", async () => {
    await expect(
      loadPlugins({
        fetchManifests: () => Promise.resolve({ ok: false, status: 404 } as Response),
      }),
    ).resolves.toBe("unreadable");
    await expect(
      loadPlugins({ fetchManifests: () => Promise.reject(new Error("offline")) }),
    ).resolves.toBe("unreadable");
    expect(loadedPlugins()).toEqual([]);
  });

  it("never rejects when the payload does not decode, and says it read nothing", async () => {
    await expect(
      loadPlugins({
        fetchManifests: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ nope: 1 }),
          } as Response),
      }),
    ).resolves.toBe("unreadable");
    expect(loadedPlugins()).toEqual([]);
  });

  it("reports a pass it READ, even when the list is empty or every plugin in it failed", async () => {
    await expect(loadPlugins({ fetchManifests: () => manifestsResponse([]) })).resolves.toBe(
      "read",
    );
    await expect(
      loadPlugins({
        fetchManifests: () => manifestsResponse([manifest({ id: "boom" })]),
        importModule: () => Promise.reject(new Error("no such module")),
      }),
    ).resolves.toBe("read");
    // The distinction is not "are there plugins" — it is "did the host ask". Here it asked.
    expect(loadedPlugins()).toEqual([]);
  });

  it("adds the plugin's stylesheet under its own URL prefix", async () => {
    const hrefs: string[] = [];
    await loadPlugins({
      fetchManifests: () => manifestsResponse([manifest({ styles: "web/styles.css" })]),
      importModule: () => Promise.resolve({ default: {} }),
      appendStylesheet: (href) => hrefs.push(href),
    });
    expect(hrefs).toEqual(["/plugins/demo/web/styles.css"]);
  });
});

describe("findAppStylesheet", () => {
  const child = (tagName: string, attrs: Record<string, string>) => ({
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
  });

  it("finds the app's first sheet, skipping the ones this loader inserted", () => {
    // The rule the whole insertion order rests on: a plugin sheet goes BEFORE the app's first, and
    // after the plugin sheets already there — appending handed every same-layer fight to the plugin
    // and measurably deleted the app's sidebar.
    const children = [
      child("link", { rel: "stylesheet", [PLUGIN_STYLESHEET_ATTRIBUTE]: "" }),
      child("meta", {}),
      child("link", { rel: "stylesheet" }),
    ];
    expect(findAppStylesheet(children)).toBe(children[2]);
  });

  it("treats a dev-server <style> as the app's first sheet", () => {
    const children = [child("style", {})];
    expect(findAppStylesheet(children)).toBe(children[0]);
  });

  it("answers null when the app has painted nothing yet", () => {
    expect(findAppStylesheet([child("meta", {}), child("title", {})])).toBeNull();
  });
});
