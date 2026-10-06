// ru-code v2: the seam collectors.
//
// The claim under test is the one the whole model rests on: the host asks every plugin for a
// surface, ISOLATES each call, validates what comes back against one set of caps, and a plugin
// that gets it wrong loses that surface and nothing else — not the other plugins', not the app's.
//
// The collectors are pure functions for exactly this reason: `apps/web`'s unit project runs in the
// NODE environment (there is no jsdom or happy-dom in this repo), so a rule that lives only inside
// a hook is a rule only the e2e suite can check. What the HOOKS add is `useSyncExternalStore` and a
// `useMemo`, and the browser proof of the whole path is `ru-code/e2e/tests-plugins/`.
import type { WebCtx, WebPlugin } from "@smart-tools/plugin-sdk/host";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_COMPOSER_ROWS_PER_PLUGIN,
  MAX_PAGES_PER_PLUGIN,
  MAX_PANELS_PER_PLUGIN,
  drawnDescription,
} from "@smart-tools/plugin-sdk/host-rules";
import { pluginCommandSlugs, toComposerCommandItem } from "../../plugins/composerRows";
import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";
import { resetLoadedPlugins, type LoadedPlugin } from "../../plugins/registry";
import {
  collectPluginBackground,
  collectPluginComposerRows,
  collectPluginPages,
  collectPluginPanelsPass,
  memoizedByPlugin,
  memoizedComposerRows,
  sameComposerRows,
  type SeamMemo,
} from "../../plugins/seams";
import { resetPluginDisplayNames } from "../../plugins/status";

const fakeCtx = (pluginId: string): WebCtx =>
  ({
    pluginId,
    invoke: async () => null,
    locale: { get: () => "en", subscribe: () => () => {} },
    theme: { get: () => "light", subscribe: () => () => {} },
    connection: { get: () => "ready", subscribe: () => () => {} },
    activeProject: { get: () => null, subscribe: () => () => {} },
    projects: { get: () => [], subscribe: () => () => {} },
    provider: { get: () => null, subscribe: () => () => {} },
    toast: () => {},
    closePanel: () => {},
    invalidate: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    assetUrl: (rel: string) => `/plugins/${pluginId}/${rel}`,
    pickFolder: async () => null,
    // V2-58: the state seam. Inert here — `state.test.ts` is where it is pinned.
    state: () => ({ get: () => undefined, subscribe: () => () => {} }),
    // V2-59: the query seam. Inert here — `query.test.ts` (and the SDK's) is where it is pinned.
    query: () => ({
      get: () => ({ phase: "loading" }),
      subscribe: () => () => {},
      refresh: () => new Promise(() => {}),
    }),
    // V2-48: the composer seam. Inert here — these cases are about the four contribution
    // runners, and `composerAttach.test.ts` is where the seam itself is pinned.
    composer: {
      target: { get: () => null, subscribe: () => () => {} },
      attach: () => {},
      detach: () => {},
      attached: () => null,
      subscribe: () => () => {},
    },
  }) as WebCtx;

let nextOrder = 0;
/** `order` is the manifest index; here it is simply the order the fixtures are declared in. */
const plugin = (id: string, web: WebPlugin): LoadedPlugin => ({
  id,
  name: id.toUpperCase(),
  order: nextOrder++,
  plugin: web,
  ctx: fakeCtx(id),
});

const Nothing = () => null;
const page = (id: string) => ({ id, title: `Page ${id}`, render: Nothing });

beforeEach(() => {
  resetLoadedPlugins();
  resetPluginProblems();
  resetPluginDisplayNames();
});

describe("collectPluginPages", () => {
  it("collects every plugin's pages in manifest order, keyed uniquely", () => {
    const entries = collectPluginPages([
      plugin("alpha", { pages: () => [page("one"), page("two")] }),
      plugin("beta", { pages: () => [page("one")] }),
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "plugin:alpha:one",
      "plugin:alpha:two",
      "plugin:beta:one",
    ]);
  });

  // ru-code S40 F2 (REVIEW): a plugin that returns the SAME entry id twice.
  //
  // `PluginContribution.key` is documented as "unique across plugins, stable across renders"
  // (`seams.tsx`) and IS the React key the app renders these entries under — the sidebar footer
  // (`SidebarChrome.tsx`), the launcher cards and the "+" menu (`RightPanelTabs.tsx`), the composer
  // menu. Two entries of one plugin sharing an id pass every other gate the runner has (slug,
  // title, render, cap), so the app is handed two children with one key and React keeps only the
  // first — the plugin silently loses a nav button, a card and a menu row it declared.
  //
  // Every other author mistake at this seam costs the ENTRY and tells the author once; this one
  // costs an entry silently, inside the app's own render tree.
  it("S40 F2: an entry id a plugin repeated does not collide in the key the app renders under", () => {
    const entries = collectPluginPages([
      plugin("alpha", { pages: () => [page("one"), page("one")] }),
    ]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);

    const panels = collectPluginPanelsPass([
      plugin("beta", {
        panels: () => [
          { id: "board", title: "Board", render: Nothing, mount: "tab" },
          { id: "board", title: "Board again", render: Nothing, mount: "tab" },
        ],
      }),
    ]);
    expect(new Set(panels.entries.map((entry) => entry.key)).size).toBe(panels.entries.length);
  });

  // S41 item 4: the rest of the rule the S40 spec above only half-states — the repeat is dropped
  // the way every other unusable entry is (keep the FIRST, manifest order untouched, the plugin
  // told once through the seam's own `seam:<name>` code), and the dedupe runs BEFORE the cap, so
  // a duplicate cannot cost the author a distinct page the cap would otherwise have allowed.
  it("keeps the FIRST of a repeated id, reports it once, and the cap still counts distinct entries", () => {
    const entries = collectPluginPages([
      plugin("alpha", {
        pages: () => [
          { ...page("one"), title: "First one" },
          { ...page("two"), title: "Two" },
          { ...page("one"), title: "Second one" },
        ],
      }),
    ]);
    // Manifest order, first occurrence kept, the repeat gone.
    expect(entries.map((entry) => [entry.key, entry.value.title])).toEqual([
      ["plugin:alpha:one", "First one"],
      ["plugin:alpha:two", "Two"],
    ]);
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("seam:pages");
    expect(problems[0]?.pluginId).toBe("alpha");
    expect(problems[0]?.detail).toContain('"one"');
    expect(problems[0]?.detail).toContain("unique within a plugin");
  });

  it("caps DISTINCT entries: a duplicate does not eat a slot the cap would have allowed", () => {
    const entries = collectPluginPages([
      plugin("alpha", {
        pages: () => [
          page("dup"),
          page("dup"),
          ...Array.from({ length: MAX_PAGES_PER_PLUGIN - 1 }, (_value, index) =>
            page(`p${String(index)}`),
          ),
        ],
      }),
    ]);
    expect(entries).toHaveLength(MAX_PAGES_PER_PLUGIN);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(MAX_PAGES_PER_PLUGIN);
  });

  it("hands each entry the ctx of the plugin it came from", () => {
    const entries = collectPluginPages([plugin("alpha", { pages: () => [page("one")] })]);
    expect(entries[0]?.ctx.pluginId).toBe("alpha");
  });

  it("ignores a plugin that exports no `pages` seam, silently", () => {
    expect(collectPluginPages([plugin("quiet", {})])).toEqual([]);
    expect(getPendingPluginProblems()).toEqual([]);
  });

  it("a seam that THROWS costs that plugin its pages and nobody else theirs", () => {
    const entries = collectPluginPages([
      plugin("boom", {
        pages: () => {
          throw new Error("pages exploded");
        },
      }),
      plugin("fine", { pages: () => [page("ok")] }),
    ]);
    expect(entries.map((entry) => entry.pluginId)).toEqual(["fine"]);
    expect(getPendingPluginProblems()[0]?.detail).toContain("pages exploded");
  });

  it("refuses a seam that returns something that is not an array", () => {
    expect(collectPluginPages([plugin("wrong", { pages: (() => "nope") as never })])).toEqual([]);
    expect(getPendingPluginProblems()[0]?.detail).toContain("must return an array");
  });

  it("drops an entry the host cannot render, and keeps the plugin's good ones", () => {
    const entries = collectPluginPages([
      plugin("mixed", {
        pages: () =>
          [
            page("good"),
            { id: "Bad Slug", title: "x", render: Nothing },
            { id: "no-render", title: "x" },
            { id: "no-title", render: Nothing },
            null,
          ] as never,
      }),
    ]);
    expect(entries.map((entry) => entry.value.id)).toEqual(["good"]);
    expect(getPendingPluginProblems()[0]?.detail).toContain("4 entries dropped");
  });

  // S111 #2: a title is drawn in host chrome that truncates it (page header, sidebar button, tab
  // strip — `truncate` at every draw site, S110 R05). What guards a crash is that it is a STRING:
  // a non-string React child there is outside every plugin boundary.
  it("S111 #2: keeps a page and a panel whose title is 100 chars, multi-line or bidi; drops a non-string one", () => {
    const long = "T".repeat(100);
    const pages = collectPluginPages([
      plugin("titled", {
        pages: () =>
          [
            { ...page("long"), title: long },
            { ...page("lines"), title: "two\nlines" },
            { ...page("blank"), title: "  " },
            { ...page("object"), title: { toString: () => "x" } },
          ] as never,
      }),
    ]);
    expect(pages.map((entry) => entry.value.id)).toEqual(["long", "lines", "blank"]);
    const panels = collectPluginPanelsPass([
      plugin("titled", { panels: () => [{ ...page("side"), title: long }] }),
    ]);
    expect(panels.entries.map((entry) => entry.value.title)).toEqual([long]);
  });

  it("caps the pages one plugin can contribute and says so once", () => {
    const entries = collectPluginPages([
      plugin("flood", {
        pages: () =>
          Array.from({ length: MAX_PAGES_PER_PLUGIN + 5 }, (_, i) => page(`p${String(i)}`)),
      }),
    ]);
    expect(entries).toHaveLength(MAX_PAGES_PER_PLUGIN);
    expect(
      getPendingPluginProblems().filter((problem) => problem.code === "cap:pages"),
    ).toHaveLength(1);
  });

  it("accepts a `memo`/`lazy` component, which is an object and not a function", () => {
    const exotic = { $$typeof: Symbol.for("react.memo"), type: Nothing } as never;
    const entries = collectPluginPages([
      plugin("exotic", { pages: () => [{ id: "m", title: "M", render: exotic }] }),
    ]);
    expect(entries).toHaveLength(1);
  });
});

// S15 N5: through `collectPluginPanelsPass`, which is what `usePluginPanelsPass` calls — the
// entries-only wrapper existed for these two cases and nothing else, so it is gone.
describe("collectPluginPanelsPass", () => {
  it("caps panels per plugin", () => {
    const { entries } = collectPluginPanelsPass([
      plugin("many", {
        panels: () =>
          Array.from({ length: MAX_PANELS_PER_PLUGIN + 2 }, (_, i) => page(`x${String(i)}`)),
      }),
    ]);
    expect(entries).toHaveLength(MAX_PANELS_PER_PLUGIN);
  });

  it("keeps `width` and `nav` through the collection untouched", () => {
    const { entries } = collectPluginPanelsPass([
      plugin("p", {
        panels: () => [{ ...page("a"), width: 700, nav: { label: "Notes", icon: "Puzzle" } }],
      }),
    ]);
    expect(entries[0]?.value.width).toBe(700);
    expect(entries[0]?.value.nav?.label).toBe("Notes");
  });

  // S26 A1: `""` is what the host itself mints for "no description" (`tabSurfaces.tsx`) and what
  // `L(en, ru)` yields when one locale's entry is empty — so an empty or whitespace description is
  // ABSENT, never a reason to drop the panel (and with it the user's persisted tab).
  it("keeps a panel whose `description` is empty or whitespace — that is 'none', not 'invalid'", () => {
    const { entries } = collectPluginPanelsPass([
      plugin("blank", {
        panels: () => [
          { ...page("empty"), description: "" },
          { ...page("spaces"), description: "   " },
          { ...page("none") },
          { ...page("given"), description: "One line under the card" },
        ],
      }),
    ]);
    expect(entries.map((entry) => entry.value.id)).toEqual(["empty", "spaces", "none", "given"]);
    expect(getPendingPluginProblems()).toEqual([]);
  });

  // MOVED at S41 item 2 (owner's ruling on S40 F5). This spec used to pin the other half of the
  // S33 A3 rule — a description the host "cannot draw" is shown as NONE and the plugin is told
  // once. The host no longer inspects a description at all: a newline is a typographic accident,
  // not a broken contribution, and the same judgement one seam over was dropping whole composer
  // rows and with them a `/` row's slug in the submit allowlist. So the line is DRAWN AS GIVEN,
  // clamped where it is drawn, and there is nothing to report.
  it("draws a multi-line or oversized panel `description` as given, clamped, and says nothing", () => {
    const { entries } = collectPluginPanelsPass([
      plugin("bad", {
        panels: () => [
          { ...page("control"), description: "Skills of this project\nand the profile" },
          { ...page("long"), description: "x".repeat(1001) },
          { ...page("fine"), description: "One line" },
        ],
      }),
    ]);
    expect(entries.map((entry) => entry.value.id)).toEqual(["control", "long", "fine"]);
    expect(entries.map((entry) => drawnDescription(entry.value.description))).toEqual([
      "Skills of this project\nand the profile",
      "x".repeat(1000),
      "One line",
    ]);
    expect(getPendingPluginProblems()).toEqual([]);
  });

  // MOVED at S41 item 2: a CLAMP, not a validator. The only two things the host does to a
  // description are "not a string is nothing" and "trim, then cap at MAX_DESCRIPTION_LENGTH".
  it("`drawnDescription` is a CLAMP, never a drop: trimmed, capped, everything else as given", () => {
    expect(drawnDescription(undefined)).toBe("");
    expect(drawnDescription(42)).toBe("");
    expect(drawnDescription("")).toBe("");
    // Blank and whitespace read the same — "the author said nothing" (S26 A1, unchanged).
    expect(drawnDescription("  \t")).toBe("");
    expect(drawnDescription("  One line under the card  ")).toBe("One line under the card");
    // A control character is DRAWN, not dropped: the slot that draws it collapses the newline.
    expect(drawnDescription("line\u0007bell")).toBe("line\u0007bell");
    expect(drawnDescription("one\ntwo")).toBe("one\ntwo");
    expect(drawnDescription("x".repeat(1000))).toBe("x".repeat(1000));
    expect(drawnDescription("x".repeat(1001))).toBe("x".repeat(1000));
  });

  // A2's rule, at the collector: the two ways a seam can say nothing are told apart here and
  // nowhere else, and the right panel's reconcile deletes a user's tab on the difference.
  it("separates a plugin that contributed NOTHING from one whose seam FAULTED", () => {
    const pass = collectPluginPanelsPass([
      plugin("quiet", { panels: () => [] }),
      plugin("boom", {
        panels: () => {
          throw new Error("nope");
        },
      }),
      plugin("wrong", { panels: () => "not an array" as unknown as [] }),
      plugin("fine", { panels: () => [page("a")] }),
    ]);
    expect(pass.entries.map((entry) => entry.pluginId)).toEqual(["fine"]);
    expect([...pass.faultedPluginIds].sort()).toEqual(["boom", "wrong"]);
  });
});

describe("collectPluginBackground", () => {
  it("keys each component uniquely even though they have no ids", () => {
    const entries = collectPluginBackground([
      plugin("bg", { background: () => [Nothing, Nothing] }),
    ]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
  });

  it("caps background components hardest of all — they run inside app chrome", () => {
    const entries = collectPluginBackground([
      plugin("bg", { background: () => [Nothing, Nothing, Nothing, Nothing] }),
    ]);
    expect(entries).toHaveLength(2);
  });
  // S33 A4 (the answer to S28 §4.3): the key is the React key of the mounted component, so it
  // must not move when an UNRELATED plugin arrives. The registry is filled in completion order
  // and re-sorted on every write; here the late-sorting plugin loads FIRST, the way the S28
  // evidence fixture (`demo-early`, sorted after `catalogs` and `demo`) did.
  it("keys a background component per plugin, stable as other plugins arrive out of order", () => {
    const Early = () => null;
    const Catalogs = () => null;
    const Demo = () => null;
    const catalogs = plugin("catalogs", { background: () => [Catalogs] });
    const demo = plugin("demo", { background: () => [Demo, Demo] });
    const early = plugin("demo-early", { background: () => [Early] });
    const keysOf = (loaded: ReadonlyArray<LoadedPlugin>) =>
      collectPluginBackground([...loaded].sort((a, b) => a.order - b.order)).map((e) => e.key);
    // Boot: `demo-early` first, then `catalogs`, then `demo` — three passes of the seam.
    const pass1 = keysOf([early]);
    const pass2 = keysOf([early, catalogs]);
    const pass3 = keysOf([early, catalogs, demo]);
    expect(pass1).toEqual(["plugin:demo-early:background:0"]);
    expect(pass2).toEqual(["plugin:catalogs:background:0", "plugin:demo-early:background:0"]);
    expect(pass3).toEqual([
      "plugin:catalogs:background:0",
      "plugin:demo:background:0",
      "plugin:demo:background:1",
      "plugin:demo-early:background:0",
    ]);
    // The one thing that matters: a plugin's key on pass N is its key on pass N+1 — one mount.
    for (const key of pass1) expect(pass2, "demo-early survives catalogs arriving").toContain(key);
    for (const key of pass2) expect(pass3, "both survive demo arriving").toContain(key);
  });
});

describe("collectPluginComposerRows", () => {
  const row = (id: string) => ({ id, label: id, insert: `/${id} ` });

  // ru-code S43 F1 (REVIEW): the one seam S41 item 4's dedupe did not reach.
  //
  // The dedupe lived inside `contributionsOf`, which runs pages, panels and background. The
  // composer seam did NOT run through it: `items` is async, so `collectPluginComposerRows`
  // (`seams.tsx`) built its own pipeline — validate, then cap — with nothing between them. Since
  // S111 both pipelines call the SDK's `judgeSeam` (validate → dedupe → cap).
  //
  // The key it builds is `plugin:<pluginId>:<trigger>:<rowId>`, and `toComposerCommandItem`
  // (`composerRows.ts`) hands that key to the menu AS THE ITEM'S `id`, where the app uses it three
  // ways: `key={item.id}`, `isActive={activeItemId === item.id}` and the cmdk `value={item.id}`
  // (`components/chat/ComposerCommandMenu.tsx`). Two rows of one plugin sharing an `id` therefore
  // reproduce S40 F2 exactly — React keeps the first child with a key, so the SECOND row vanishes
  // from the menu with no reason given anywhere, and the highlight resolves by a colliding id.
  //
  // It is not a gap anyone can read from the outside: `api.md` states the rule for EVERY seam
  // ("An `id` must be unique within your plugin, per seam … `host-rules · judgeSeamEntries`", and the
  // `ComposerRow` paragraph sits under it), and the playground mirror dedupes composer rows
  // (`plugin-dev/src/playground/client/seams.ts` passes `(entry) => entry.id` to `applyHostRules`
  // for `useComposerRows`). So the row an author sees dropped-and-reported in the playground is
  // the row that silently disappears in the product.
  it("S43 F1: a row id a plugin repeated does not collide in the key the menu renders under", async () => {
    const rows = await collectPluginComposerRows(
      [plugin("alpha", { composer: { items: () => [row("one"), row("two"), row("one")] } })],
      "/",
      "",
    );
    // The FIRST occurrence keeps its place, manifest order untouched, the repeat gone — the same
    // rule `judgeSeam` applies at every other seam.
    expect(rows.map((entry) => entry.key)).toEqual(["plugin:alpha:/:one", "plugin:alpha:/:two"]);
    // …and the author is told once, through this seam's own `seam:<name>` code, exactly as a
    // malformed row and an over-cap list already are.
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("seam:composer.items");
    expect(problems[0]?.pluginId).toBe("alpha");
    expect(problems[0]?.detail).toContain("unique within a plugin");
  });

  it("asks every plugin for the open trigger and merges in manifest order", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("alpha", { composer: { items: (trigger) => [row(`a-${trigger}`)] } }),
        plugin("beta", { composer: { items: () => Promise.resolve([row("b")]) } }),
      ],
      "/",
      "",
    );
    expect(rows.map((entry) => entry.value.id)).toEqual(["a-/", "b"]);
  });

  it("treats a static array and a promise as the SAME seam", async () => {
    const sync = await collectPluginComposerRows(
      [plugin("s", { composer: { items: () => [row("x")] } })],
      "$",
      "",
    );
    const async_ = await collectPluginComposerRows(
      [plugin("a", { composer: { items: () => Promise.resolve([row("x")]) } })],
      "$",
      "",
    );
    expect(sync[0]?.value).toEqual(async_[0]?.value);
  });

  it("passes the live trigger and query through", async () => {
    let seen: { trigger: string; query: string } | null = null;
    await collectPluginComposerRows(
      [
        plugin("alpha", {
          composer: {
            items: (trigger, query) => {
              seen = { trigger, query };
              return [];
            },
          },
        }),
      ],
      "#",
      "rev",
    );
    expect(seen).toEqual({ trigger: "#", query: "rev" });
  });

  it("a rejecting seam costs that plugin's rows only", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("boom", { composer: { items: () => Promise.reject(new Error("rows exploded")) } }),
        plugin("fine", { composer: { items: () => [row("ok")] } }),
      ],
      "#",
      "",
    );
    expect(rows.map((entry) => entry.value.id)).toEqual(["ok"]);
    expect(
      getPendingPluginProblems().some((problem) => problem.detail?.includes("rows exploded")),
    ).toBe(true);
  });

  it("a synchronously THROWING seam is caught too", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("boom", {
          composer: {
            items: () => {
              throw new Error("sync exploded");
            },
          },
        }),
      ],
      "/",
      "",
    );
    expect(rows).toEqual([]);
  });

  // SUPERSEDED PIN (S111 #6): this case pinned `rows.length === MAX_COMPOSER_ROWS_PER_PLUGIN` —
  // the cap SLICED the answer, so a `/` row past the 100th left the submit allowlist too and the
  // user's own typed command was refused (S110 R20). Shape (b): the cap bounds what the menu DRAWS;
  // the collector keeps every valid row, marking the first 100 per plugin `drawn`.
  it("drops a malformed row and caps what the menu DRAWS, keeping every valid row", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("flood", {
          composer: {
            items: () => [
              ...Array.from({ length: MAX_COMPOSER_ROWS_PER_PLUGIN + 3 }, (_, i) =>
                row(`r${String(i)}`),
              ),
              { id: "no-insert", label: "x" } as never,
            ],
          },
        }),
      ],
      "/",
      "",
    );
    expect(rows).toHaveLength(MAX_COMPOSER_ROWS_PER_PLUGIN + 3);
    expect(rows.filter((entry) => entry.drawn)).toHaveLength(MAX_COMPOSER_ROWS_PER_PLUGIN);
    expect(rows.slice(MAX_COMPOSER_ROWS_PER_PLUGIN).every((entry) => !entry.drawn)).toBe(true);
  });

  // ru-code S40 F5 — THE RULE UNDER TEST (comment rewritten at S41 item 17; the assertions below
  // have not moved since the fix).
  //
  // A ROW SURVIVES ANY `description`, because the host does not judge one. `isValidComposerRow`
  // gates `id`, `label`, `insert` and `group` and says nothing about `description`
  // (`@smart-tools/plugin-sdk/host-rules`); the field is drawn as given and clamped where it is
  // drawn, by `drawnDescription` (the same module), which every draw site calls — `tabSurfaces.tsx` for a panel's line and
  // `composerRows.ts` `toComposerCommandItem` for a row's. So `""`, whitespace and a two-line
  // string are all "no second line, keep the row", exactly as they are one seam over.
  //
  // WHY IT MATTERS THAT THE ROW SURVIVES: `description: item.summary ?? ""` is the way an author
  // writes an optional line, and for a `/` row a drop is not cosmetic — a dropped row takes its
  // slug out of the submit allowlist (`pluginCommandSlugs`), so the command the menu no longer
  // offers is also refused at submit. That was the defect; this spec is what keeps it fixed.
  it("S40 F5: a description the host will not draw costs the LINE, not the row", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("probe", {
          composer: {
            items: () => [
              { id: "blank", label: "Blank", insert: "/blank ", description: "" },
              { id: "two-line", label: "Two", insert: "/two ", description: "one\ntwo" },
              { id: "none", label: "None", insert: "/none " },
            ],
          },
        }),
      ],
      "/",
      "",
    );
    expect(rows.map((entry) => entry.value.id)).toEqual(["blank", "two-line", "none"]);
  });

  // ── S111: catalogs' real rows (S110 R15, R20) ─────────────────────────────────────────────
  //
  // Catalogs builds a `/` row as `label: "/<name>"`, `insert: "/<name> "` (`plugin-catalogs
  // src/web/composer.ts` ROW_STYLE.command) from command names the scan accepts up to 120 chars,
  // and a `$` row's label from a skill's front-matter name with no length check at scan. The
  // 64-char display-string rule dropped both rows — and for `/` the slug left the submit
  // allowlist, so the user's own typed command was stripped or the send aborted.
  const commandRow = (name: string, index: number) => ({
    id: `cmd-${String(index)}`,
    label: `/${name}`,
    insert: `/${name} `,
    description: "Command",
    icon: "Bot",
  });
  const allowlist = (rows: Awaited<ReturnType<typeof collectPluginComposerRows>>) =>
    pluginCommandSlugs(rows.map((entry) => toComposerCommandItem(entry, "/")));

  it("S111 #4: a 70-char `/command` is in the menu AND in the submit allowlist", async () => {
    const name = "deploy-".repeat(10);
    const rows = await collectPluginComposerRows(
      [plugin("catalogs", { composer: { items: () => [commandRow(name, 0)] } })],
      "/",
      "",
    );
    expect(rows.filter((entry) => entry.drawn).map((entry) => entry.value.label)).toEqual([
      `/${name}`,
    ]);
    expect(allowlist(rows).has(name)).toBe(true);
  });

  // S111 #6 — the COLLECTOR's half of shape (b), stated with literal expectations: it keeps all 101
  // valid rows and marks exactly the 101st not drawn. Which rows the submit guard READS (every
  // contributed row, `qwenCommandSlugs.ts` → `useContributedComposerRows`) is a hook, which this
  // NODE project cannot render; its guard is `ru-code/e2e/tests-plugins/slashGuard.e2e.test.ts`
  // "S111 #6: past the 100 the menu draws…" (S111 review F2: the earlier version computed its
  // allowlist from these same rows, so it could not see which hook the guard used).
  it("S111 #6: the collector keeps all 101 valid `/` rows and marks only the 101st not drawn", async () => {
    const rows = await collectPluginComposerRows(
      [
        plugin("catalogs", {
          composer: {
            items: () =>
              Array.from({ length: 101 }, (_, index) =>
                commandRow(`command-${String(index)}`, index),
              ),
          },
        }),
      ],
      "/",
      "",
    );
    expect(rows).toHaveLength(101);
    expect(rows.slice(98).map((entry) => [entry.key, entry.drawn])).toEqual([
      ["plugin:catalogs:/:cmd-98", true],
      ["plugin:catalogs:/:cmd-99", true],
      ["plugin:catalogs:/:cmd-100", false],
    ]);
  });

  it("S111 #4: a `$` skill whose name is 65 chars is in the menu", async () => {
    const name = "Очень подробный навык для проверки длинных имён в меню композера ".slice(0, 65);
    expect(name).toHaveLength(65);
    const rows = await collectPluginComposerRows(
      [
        plugin("catalogs", {
          composer: {
            items: () => [
              { id: "skill-1", label: name, insert: `skill:⟦${name}⟧ `, icon: "Package" },
            ],
          },
        }),
      ],
      "$",
      "",
    );
    expect(rows.filter((entry) => entry.drawn).map((entry) => entry.value.label)).toEqual([name]);
  });

  it("S111 #3–#5: a row's id needs a non-empty string, its label and group a string — nothing more", async () => {
    const good = { id: "x".repeat(70), label: "", insert: "/a ", group: "g".repeat(200) };
    const rows = await collectPluginComposerRows(
      [
        plugin("rules", {
          composer: {
            items: () =>
              [
                good,
                { ...good, id: "tab\there", label: "bidi\u202Elabel" },
                { ...good, id: "" },
                { ...good, id: 7 },
                { ...good, id: "nl", label: { toString: () => "x" } },
                { ...good, id: "grp", group: 7 },
                { ...good, id: "nogroup", group: undefined },
              ] as never,
          },
        }),
      ],
      "/",
      "",
    );
    expect(rows.map((entry) => entry.value.id)).toEqual(["x".repeat(70), "tab\there", "nogroup"]);
  });

  it("ignores a plugin with no composer seam", async () => {
    expect(await collectPluginComposerRows([plugin("quiet", {})], "/", "")).toEqual([]);
  });
});

// V2-25. `usePluginComposerRows` keeps the array it already published when the answer did not
// change — the composer memoises its menu on that identity, and the submit guard derives its
// allowlist from it. So "did not change" has to mean what the user would see, not just the keys: a
// catalog row's key comes from the item's stable uuid, so a command RENAMED on disk comes back with
// the same key and a different `insert`, and a key-only comparison threw the recompute away.
describe("sameComposerRows", () => {
  // The SAME plugin id every time: a contribution's key is `plugin:<id>:<trigger>:<rowId>`, so two
  // answers from two different fixtures would differ in their keys for a reason the comparison is
  // not about.
  const shown = async (rows: ReadonlyArray<{ id: string; label: string; insert: string }>) =>
    await collectPluginComposerRows([plugin("rows", { composer: { items: () => rows } })], "/", "");

  it("is true for the same rows — the array keeps its identity and nothing re-renders", async () => {
    const a = await shown([{ id: "one", label: "One", insert: "/one " }]);
    const b = await shown([{ id: "one", label: "One", insert: "/one " }]);
    expect(sameComposerRows(a, b)).toBe(true);
  });

  it("sees a row appear and a row vanish", async () => {
    const none = await shown([]);
    const one = await shown([{ id: "one", label: "One", insert: "/one " }]);
    expect(sameComposerRows(none, one)).toBe(false);
    expect(sameComposerRows(one, none)).toBe(false);
  });

  it("sees the INSERT change under an unchanged id — the renamed-command case", async () => {
    const before = await shown([{ id: "one", label: "/old", insert: "/old " }]);
    const after = await shown([{ id: "one", label: "/new", insert: "/new " }]);
    expect(before[0]?.key).toBe(after[0]?.key);
    expect(sameComposerRows(before, after)).toBe(false);
  });
});

// ru-code S38 (V2-40) — THE RUNNERS ASK THE PLUGIN WHOSE VERSION MOVED, AND NOBODY ELSE.
//
// The SDK says `ctx.invalidate(seam)` makes the host "recompute that seam for YOUR plugin only"
// (`plugin-sdk/src/host/index.ts:156`). Until S38 the runners keyed on a cross-plugin SUM, so one
// plugin's invalidation re-asked everybody — measured as ten `context.build` wire frames from the
// demo plugin on one reload (`WORKFLOW/logs/S38/1-e2e-boot-red.log`).
//
// These two functions are the rule, extracted from the hooks for the reason every collector here is
// (the unit project runs in NODE, so a rule inside a hook is a rule only the e2e suite can check).
// The browser proof is `ru-code/e2e/tests-plugins/perPluginInvalidate.e2e.test.ts`.
describe("memoizedByPlugin (V2-40)", () => {
  const empty: ReadonlyMap<string, SeamMemo<string>> = new Map();

  it("asks every plugin the first time, in manifest order", () => {
    const asked: string[] = [];
    const plugins = [plugin("alpha", {}), plugin("beta", {})];
    const first = memoizedByPlugin(empty, plugins, {}, (entry) => {
      asked.push(entry.id);
      return `${entry.id}:1`;
    });
    expect(asked).toEqual(["alpha", "beta"]);
    expect(first.values).toEqual(["alpha:1", "beta:1"]);
  });

  it("asks NOBODY again when no version moved", () => {
    const asked: string[] = [];
    const plugins = [plugin("alpha", {}), plugin("beta", {})];
    const of = (entry: LoadedPlugin) => {
      asked.push(entry.id);
      return entry.id;
    };
    const first = memoizedByPlugin(empty, plugins, {}, of);
    const second = memoizedByPlugin(first.memo, plugins, {}, of);
    expect(asked).toEqual(["alpha", "beta"]);
    expect(second.values).toEqual(first.values);
  });

  it("THE RULE: bump ONE plugin and only that plugin's seam function runs again", () => {
    const asked: string[] = [];
    const plugins = [plugin("alpha", {}), plugin("beta", {})];
    let generation = 1;
    const of = (entry: LoadedPlugin): { readonly id: string; readonly generation: number } => {
      asked.push(entry.id);
      return { id: entry.id, generation };
    };
    const first = memoizedByPlugin<{ readonly id: string; readonly generation: number }>(
      new Map(),
      plugins,
      {},
      of,
    );
    asked.length = 0;
    generation = 2;
    const second = memoizedByPlugin(first.memo, plugins, { alpha: 1 }, of);
    expect(asked).toEqual(["alpha"]);
    // The re-asked plugin has the NEW answer; the other keeps the very object it gave before.
    expect(second.values[0]).toEqual({ id: "alpha", generation: 2 });
    expect(second.values[1]).toBe(first.values[1]);
  });

  it("a plugin that is no longer loaded leaves its memo with it", () => {
    const plugins = [plugin("alpha", {}), plugin("beta", {})];
    const first = memoizedByPlugin(empty, plugins, {}, (entry) => entry.id);
    const second = memoizedByPlugin(first.memo, [plugins[0]!], {}, (entry) => entry.id);
    expect([...second.memo.keys()]).toEqual(["alpha"]);
  });

  it("a plugin RELOADED under the same id is a different plugin, and is asked again", () => {
    const asked: string[] = [];
    const of = (entry: LoadedPlugin) => {
      asked.push(entry.id);
      return entry.id;
    };
    const first = memoizedByPlugin(empty, [plugin("alpha", {})], {}, of);
    asked.length = 0;
    memoizedByPlugin(first.memo, [plugin("alpha", {})], {}, of);
    expect(asked).toEqual(["alpha"]);
  });
});

describe("memoizedComposerRows (V2-40)", () => {
  const counting = (id: string, calls: string[]) =>
    plugin(id, {
      composer: {
        items: (_trigger, query) => {
          calls.push(`${id}:${query}`);
          return [{ id: "row", label: id, insert: `/${id} ` }];
        },
      },
    });

  const settled = async (entries: ReadonlyArray<{ readonly rows: Promise<unknown> }>) =>
    await Promise.all(entries.map((entry) => entry.rows));

  it("bumping ONE plugin re-asks that plugin's `items` and nobody else's", async () => {
    const calls: string[] = [];
    const plugins = [counting("alpha", calls), counting("beta", calls)];
    const memo = new Map();
    await settled(memoizedComposerRows(memo, plugins, {}, "/", ""));
    expect(calls).toEqual(["alpha:", "beta:"]);
    calls.length = 0;
    const second = memoizedComposerRows(memo, plugins, { alpha: 1 }, "/", "");
    const rows = await settled(second);
    expect(calls).toEqual(["alpha:"]);
    expect(rows.flat().map((row) => (row as { pluginId: string }).pluginId)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("a keystroke re-asks EVERYBODY — the query is an argument of the seam, not a plugin's state", async () => {
    const calls: string[] = [];
    const plugins = [counting("alpha", calls), counting("beta", calls)];
    const memo = new Map();
    await settled(memoizedComposerRows(memo, plugins, {}, "/", ""));
    calls.length = 0;
    await settled(memoizedComposerRows(memo, plugins, {}, "/", "a"));
    expect(calls).toEqual(["alpha:a", "beta:a"]);
  });

  // THE BOOT RACE, which is why the memo holds the CALL and not the answer: a second pass that
  // starts while the first one is still awaiting must JOIN it, not start a second wire call.
  it("a pass that starts mid-flight joins the call in flight instead of making a second one", async () => {
    let calls = 0;
    const gate: { release: (() => void) | null } = { release: null };
    const slow = plugin("slow", {
      composer: {
        items: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return [{ id: "row", label: "Slow", insert: "/slow " }];
        },
      },
    });
    const memo = new Map();
    const first = memoizedComposerRows(memo, [slow], {}, "/", "");
    // Another plugin invalidated the composer while this one is still out; the runner re-runs.
    const second = memoizedComposerRows(memo, [slow], {}, "/", "");
    expect(calls, "one call, two passes").toBe(1);
    gate.release?.();
    const [a, b] = await Promise.all([settled(first), settled(second)]);
    expect(a).toEqual(b);
  });

  it("a plugin that FAULTED is not re-asked until its own version moves", async () => {
    let thrown = 0;
    const plugins = [
      plugin("boom", {
        composer: {
          items: () => {
            thrown += 1;
            throw new Error("items exploded");
          },
        },
      }),
    ];
    const memo = new Map();
    const first = memoizedComposerRows(memo, plugins, {}, "/", "");
    expect(await first[0]?.rows).toEqual([]);
    expect(thrown).toBe(1);
    await settled(memoizedComposerRows(memo, plugins, {}, "/", ""));
    expect(thrown, "a fault is an ANSWER for this version, not a reason to keep calling").toBe(1);
    await settled(memoizedComposerRows(memo, plugins, { boom: 1 }, "/", ""));
    expect(thrown).toBe(2);
  });

  it("a plugin that is no longer loaded leaves its call with it", async () => {
    const calls: string[] = [];
    const plugins = [counting("alpha", calls), counting("beta", calls)];
    const memo = new Map();
    await settled(memoizedComposerRows(memo, plugins, {}, "/", ""));
    memoizedComposerRows(memo, [plugins[0]!], {}, "/", "");
    expect([...memo.keys()]).toEqual(["alpha"]);
  });
});
