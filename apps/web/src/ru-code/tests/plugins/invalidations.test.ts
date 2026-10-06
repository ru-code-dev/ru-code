// ru-code v2 (V2-25): the contribution-changed counters — the input every seam runner gained.
//
// WHAT THIS FILE CAN PROVE. `apps/web`'s unit project runs in the NODE environment (there is no
// jsdom or happy-dom in this repo), so the HOOK that puts `useSeamVersions(seam)` in a runner's
// dependency list is not mountable here. What is mountable is the whole of the mechanism under it,
// and it is where every rule lives: a bump moves the map a runner watches, a bump for one seam
// moves no other, and a bump by one plugin moves no other plugin's version.
//
// V2-40 made the last of those load-bearing rather than informational: the runners key on the
// per-plugin number now, not on a cross-plugin sum, so "this plugin's version moved and that one's
// did not" is what decides who is re-asked. `seams.test.ts` holds the other half (the memo that
// acts on it).
//
// The runner-level claim — "the composer seam is asked AGAIN, with the same (trigger, query), and
// the app's submit guard sees the new rows" — is pinned in a real browser by
// `ru-code/e2e/tests-plugins/slashGuard.e2e.test.ts`.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { INVALIDATE_SEAMS, isInvalidateSeam } from "@smart-tools/plugin-sdk/host-rules";
import {
  invalidatePluginSeam,
  pluginSeamVersion,
  resetPluginInvalidations,
  seamVersions,
} from "../../plugins/invalidations";

beforeEach(() => {
  resetPluginInvalidations();
});

describe("isInvalidateSeam", () => {
  it("accepts exactly the four seams a plugin may re-ask (V2-25)", () => {
    expect([...INVALIDATE_SEAMS]).toEqual(["composer", "panels", "pages", "background"]);
    for (const seam of INVALIDATE_SEAMS) expect(isInvalidateSeam(seam)).toBe(true);
  });

  it.each(["panel", "Composer", "", "rows", 1, null, undefined, {}])(
    "refuses %o — a plugin's `web/index.mjs` ships without its types",
    (value) => {
      expect(isInvalidateSeam(value)).toBe(false);
    },
  );
});

describe("invalidatePluginSeam", () => {
  it("starts at zero: nothing has been invalidated on a fresh page", () => {
    for (const seam of INVALIDATE_SEAMS) expect(seamVersions(seam)).toEqual({});
    expect(pluginSeamVersion("catalogs", "composer")).toBe(0);
  });

  it("a bump moves the number the runner keys THAT PLUGIN on", () => {
    invalidatePluginSeam("catalogs", "composer");
    expect(seamVersions("composer")).toEqual({ catalogs: 1 });
    invalidatePluginSeam("catalogs", "composer");
    expect(seamVersions("composer")).toEqual({ catalogs: 2 });
  });

  it("no bump, no change — a runner that re-renders for another reason recomputes nothing", () => {
    invalidatePluginSeam("catalogs", "composer");
    const before = seamVersions("composer");
    // IDENTITY, not just value: the map is a `useSyncExternalStore` snapshot and a `useMemo`
    // dependency, so a fresh object per read would recompute every runner on every render.
    expect(seamVersions("composer")).toBe(before);
    expect(seamVersions("composer")).toBe(before);
  });

  it("is PER SEAM: invalidating the composer leaves panels, pages and background alone", () => {
    const panels = seamVersions("panels");
    invalidatePluginSeam("catalogs", "composer");
    expect(seamVersions("panels")).toEqual({});
    expect(seamVersions("pages")).toEqual({});
    expect(seamVersions("background")).toEqual({});
    // …and their snapshots did not even change identity, so those runners do not re-render.
    expect(seamVersions("panels")).toBe(panels);
  });

  it("is PER PLUGIN: one plugin's version is its own", () => {
    invalidatePluginSeam("catalogs", "composer");
    invalidatePluginSeam("catalogs", "composer");
    invalidatePluginSeam("demo", "composer");
    expect(pluginSeamVersion("catalogs", "composer")).toBe(2);
    expect(pluginSeamVersion("demo", "composer")).toBe(1);
    expect(pluginSeamVersion("analytics", "composer")).toBe(0);
  });

  it("V2-40: one plugin's bump leaves every OTHER plugin's number where it was", () => {
    invalidatePluginSeam("catalogs", "panels");
    invalidatePluginSeam("demo", "panels");
    const before = seamVersions("panels");
    invalidatePluginSeam("catalogs", "panels");
    const after = seamVersions("panels");
    expect(after.catalogs).toBe(2);
    expect(after.demo).toBe(before.demo);
    // The MAP moved (the seam changed for somebody, so the runner re-renders) while the entry the
    // demo plugin's contribution is memoized under did not — which is what stops it being re-asked.
    expect(after).not.toBe(before);
  });

  it("cannot be spelled into another plugin's counter", () => {
    // The key joins the two with a separator no plugin id can carry (the `host-rules` slug rule), so
    // `"a demo"` invalidating `composer` is not `"a"` invalidating `"demo composer"`.
    invalidatePluginSeam("a demo", "composer");
    expect(pluginSeamVersion("a", "composer")).toBe(0);
    expect(pluginSeamVersion("a demo", "composer")).toBe(1);
  });
});
