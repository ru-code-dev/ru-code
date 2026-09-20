// ru-code S41 item 5 (S40 Q2): the host-owned plugin page route may not state a fact it has not
// checked.
//
// `/plugins/$pluginId/$pageId` resolves its params against the REACTIVE page list, which is empty
// twice over — before the loader ran, and when nothing is installed. Only the loader's pass tells
// the two apart (S15 A1, `registry.ts` `usePluginLoadPass`), and plugins are imported after the
// first paint with a 10 s per-plugin budget (`loadPlugins.ts`). So a bookmarked or footer-nav
// plugin page used to assert «Страница … не установлена.» about a plugin that was installed and
// still loading, then replace the sentence with the page.
//
// `tabSurfaces.tsx` and `slots.tsx` already gate their own "not contributed" reading on the same
// hook, for the same reason; this is the third consumer of the same rule. The decision is exported
// as a pure function because `apps/web`'s unit project runs in the NODE environment — a rule that
// lives only inside a component is a rule only the e2e suite can check.
import { describe, expect, it } from "vite-plus/test";

import { pluginPageState } from "../../plugins/PluginPage";

describe("pluginPageState", () => {
  it("says PENDING, never 'not installed', until the loader's pass is `read`", () => {
    // "pending": the loader has not announced anything yet — `main.tsx` has called `loadPlugins()`
    // and the imports are in flight.
    expect(pluginPageState(false, "pending")).toBe("pending");
  });

  it("says MISSING only once the host has actually asked", () => {
    expect(pluginPageState(false, "read")).toBe("missing");
  });

  // MOVED at S41 item 14 (S43 F2). This spec asserted `"pending"` on an `unreadable` pass, and in
  // doing so it PINNED THE DEFECT: it was right that "not installed" is a claim the host cannot
  // make on that pass, and wrong about the remedy. `"unreadable"` is TERMINAL and nothing re-runs
  // the loader, so answering it with the waiting state promised a resolution that never comes.
  // The claim stays honest a different way — a line about the HOST ("the plugin list could not be
  // read, so no plugins are loaded", true down all three `unreadable` paths) rather than a line
  // about the plugin. `tabSurfaces.tsx` and `slots.tsx` keep `pass !== "read"` because not
  // deleting state can safely last forever; a route has to draw something.
  it("says UNREADABLE on an `unreadable` pass — never 'missing', and never a wait", () => {
    expect(pluginPageState(false, "unreadable")).toBe("unreadable");
  });

  // ru-code S43 F2 (REVIEW): `"unreadable"` is a TERMINAL pass, and this route answers it by
  // waiting forever.
  //
  // `registry.ts` defines it as "it FINISHED without ever reading a plugin list", and
  // `loadPlugins.ts` returns it for the three answers a real install actually gives: a non-OK
  // `GET /plugins/manifests.json` — including the 404 the loader itself calls "the normal answer
  // on a deployment with no plugins dir" — an unreachable server, and a payload that did not
  // decode. Nothing ever re-runs the loader (`registry.ts`: "`main.tsx` calls `loadPlugins()` once
  // per page load and nothing re-runs it"), so on that pass this route renders
  // `PluginPagePending` — «Загрузка…», no timer, no retry, no way forward — for as long as the
  // page stays open. A reload on a plugin page while the server is still coming up is the ordinary
  // way to get there.
  //
  // The rule was borrowed from `tabSurfaces.tsx` and `slots.tsx`, and that is where the borrowing
  // breaks: for those two, sitting a pass out means NOT DELETING the user's persisted state, which
  // costs nothing and can safely last forever. A ROUTE has to draw something, and «Загрузка…» is
  // not a neutral silence — it is a promise that this resolves, made on a pass that says it never
  // will.
  //
  // THIS SPEC AND THE ONE ABOVE IT CONTRADICT EACH OTHER ON PURPOSE. "does NOT say missing on an
  // `unreadable` pass" (`pluginPage.test.ts`) pins the defect: it asserts
  // `pluginPageState(false, "unreadable")` is `"pending"`. It must move — `"pending"` is for a
  // pass that has not finished, and only `"pending"` is.
  it("S43 F2: an `unreadable` pass is an ANSWER, not a wait — the route may not load forever", () => {
    // The property, not the sentence: a terminal pass must leave the waiting state. Whether the
    // route then says «…не установлена.» or grows a third state that names the real cause is the
    // fix's choice; staying on «Загрузка…» is not.
    expect(pluginPageState(false, "unreadable")).not.toBe("pending");
  });

  it("says FOUND whatever the pass, when the page is already contributed", () => {
    // A plugin that loaded first contributes before the pass ends: the page renders at once.
    expect([
      pluginPageState(true, "pending"),
      pluginPageState(true, "read"),
      pluginPageState(true, "unreadable"),
    ]).toEqual(["found", "found", "found"]);
  });
});
