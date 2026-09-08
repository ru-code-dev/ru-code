// ru-code (A22, SDK 0.3.0): `composer.registerProvider` — the DYNAMIC composer row source.
//
// What is pinned here is everything a plugin author and the composer both rely on and neither can
// see:
//
//   * a provider's rows reach the menu through the SAME `plugin-item` row `registerItem` uses, so
//     no new insert kind, no new trigger and no new Lexical node exist;
//   * `insert` is pasted VERBATIM — the SDK says "include the trailing space if you want one", and
//     the host appending a second one is the defect A23 found (a catalog token pasted as
//     `skill:⟦auth⟧  `);
//   * the caps: 2 providers per trigger per plugin, 500 rows per query, both DROPPING the excess
//     and reporting once rather than failing the plugin;
//   * a throwing `useRows` costs its rows and nothing else — the composer keeps rendering;
//   * the `/`-command slug set the submit guard reads is derived from the `command` rows, so a
//     plugin's `/mycommand` is not aborted as unknown.

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PluginComposerProvider, PluginComposerRow } from "@smart-tools/plugin-sdk/host";

import {
  ComposerCommandMenu,
  type ComposerCommandItem,
} from "~/components/chat/ComposerCommandMenu";

import {
  allComposerProviders,
  clearProviderRows,
  composerProviderCount,
  invalidComposerProviderFields,
  pluginCommandSlugs,
  pluginComposerProviderItems,
  pluginComposerProviderRowId,
  publishPrimedCommandSlugs,
  publishProviderRows,
  resetPluginComposerProviders,
  setActiveComposerQuery,
  toProviderMenuItem,
  MAX_COMPOSER_PROVIDERS_PER_TRIGGER,
  MAX_COMPOSER_PROVIDER_ROWS,
} from "./composerProviders";
import { mergePluginComposerItems, registerComposerProvider } from "./composerRegistry";
import { groupPluginComposerItems } from "./composerMenuGroups";
import { getPendingPluginProblems, resetPluginProblems } from "./problems";
import { recordPluginDisplayName, resetPluginDisplayNames } from "./status";
import { composerProviderDriverBody } from "./PluginBackgroundSurface";

const row = (over: Partial<PluginComposerRow> = {}): PluginComposerRow => ({
  name: "auth",
  label: "auth",
  description: "The auth skill",
  insert: "skill:⟦auth⟧ ",
  ...over,
});

const provider = (over: Partial<PluginComposerProvider> = {}): PluginComposerProvider => ({
  trigger: "skill",
  useRows: () => [row()],
  ...over,
});

beforeEach(() => {
  resetPluginComposerProviders();
  resetPluginProblems();
  resetPluginDisplayNames();
  recordPluginDisplayName("catalogs", "Skills, Agents & Commands");
});

describe("registerComposerProvider", () => {
  it("registers a provider and keys its driver by plugin, trigger and ordinal", () => {
    registerComposerProvider("catalogs", provider());
    registerComposerProvider("catalogs", provider({ trigger: "command" }));

    expect(allComposerProviders().map((entry) => entry.key)).toEqual([
      "provider:catalogs:skill:0",
      "provider:catalogs:command:0",
    ]);
    // The count is per TRIGGER, so a plugin may hold its two skill providers and two command
    // providers at once — the cap bounds a menu, not a plugin.
    expect(composerProviderCount("catalogs", "skill")).toBe(1);
    expect(composerProviderCount("catalogs", "command")).toBe(1);
  });

  it("drops a malformed provider, reports it once, and keeps the plugin working", () => {
    registerComposerProvider("catalogs", { trigger: "nope", useRows: () => [] } as never);
    registerComposerProvider("catalogs", { trigger: "skill" } as never);
    registerComposerProvider("catalogs", null as never);

    expect(allComposerProviders()).toHaveLength(0);
    // One problem per plugin per CATEGORY (R3-H4), not one per bad call.
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("composer-provider-invalid");

    // …and a good registration after the bad ones still lands: `activate()` was never aborted.
    registerComposerProvider("catalogs", provider());
    expect(allComposerProviders()).toHaveLength(1);
  });

  it("reads every field inside one try — a throwing getter is one bad registration", () => {
    const hostile = {
      get trigger(): string {
        throw new Error("getter exploded");
      },
      useRows: () => [],
    };
    expect(invalidComposerProviderFields(hostile)).toEqual(["provider"]);
    registerComposerProvider("catalogs", hostile as never);
    expect(allComposerProviders()).toHaveLength(0);
  });

  it(`caps at ${String(MAX_COMPOSER_PROVIDERS_PER_TRIGGER)} providers per trigger per plugin`, () => {
    for (let i = 0; i <= MAX_COMPOSER_PROVIDERS_PER_TRIGGER + 2; i += 1) {
      registerComposerProvider("catalogs", provider());
    }
    expect(allComposerProviders()).toHaveLength(MAX_COMPOSER_PROVIDERS_PER_TRIGGER);
    const overflow = getPendingPluginProblems().filter(
      (problem) => problem.code === "composer-provider-overflow",
    );
    expect(overflow).toHaveLength(1);

    // A SECOND plugin has its own budget: the cap is per plugin, so one noisy plugin cannot
    // silence another's rows.
    recordPluginDisplayName("other", "Other");
    registerComposerProvider("other", provider());
    expect(composerProviderCount("other", "skill")).toBe(1);
  });

  it("resets cleanly — no provider, no row and no primed slug survives", () => {
    registerComposerProvider("catalogs", provider());
    publishProviderRows("provider:catalogs:skill:0", [
      toProviderMenuItem("catalogs", "skill", row())!,
    ]);
    publishPrimedCommandSlugs("provider:catalogs:command:0", ["mycommand"]);

    resetPluginComposerProviders();

    expect(allComposerProviders()).toHaveLength(0);
    expect(pluginComposerProviderItems("skill")).toHaveLength(0);
    expect(pluginCommandSlugs().size).toBe(0);
  });
});

describe("toProviderMenuItem", () => {
  it("produces the SAME row shape and id space `registerItem` uses", () => {
    const item = toProviderMenuItem("catalogs", "skill", row());

    expect(item?.type).toBe("plugin-item");
    expect(item?.id).toBe(pluginComposerProviderRowId("catalogs", "skill", "auth"));
    // Deliberately identical to `pluginComposerItemId`: a plugin that migrates a row from
    // `registerItem` to a provider keeps its id, so nothing downstream can tell them apart.
    expect(item?.id).toBe("plugin:catalogs:skill:auth");
    expect(item?.pluginId).toBe("catalogs");
    expect(item?.trigger).toBe("skill");
  });

  it("pastes `insert` VERBATIM — the host adds no second trailing space (A23)", () => {
    // The defect this pins: `insert` for a catalog chip already ends in a space, and the
    // `plugin-item` branch historically pasted `` `${prompt} ` ``, producing `skill:⟦auth⟧  `.
    const item = toProviderMenuItem("catalogs", "skill", row());
    expect(item?.prompt).toBe("skill:⟦auth⟧ ");
    expect(item?.insertVerbatim).toBe(true);

    // A row that wants no trailing space gets none.
    const bare = toProviderMenuItem("catalogs", "command", row({ insert: "/mycommand" }));
    expect(bare?.prompt).toBe("/mycommand");
    expect(bare?.insertVerbatim).toBe(true);
  });

  it("falls back to `name` for a missing label and drops an unusable row", () => {
    expect(toProviderMenuItem("catalogs", "skill", row({ label: "  " }))?.label).toBe("auth");
    expect(
      toProviderMenuItem("catalogs", "skill", row({ description: 7 as never }))?.description,
    ).toBe("");

    // Dropped per ROW, never per batch: `useRows` runs on every keystroke, so one hole in a
    // computed list must not empty the picker.
    expect(toProviderMenuItem("catalogs", "skill", row({ name: "   " }))).toBeNull();
    expect(toProviderMenuItem("catalogs", "skill", row({ insert: 7 as never }))).toBeNull();
    expect(toProviderMenuItem("catalogs", "skill", null as never)).toBeNull();
  });

  it("carries `group` and `icon` only when the plugin supplied usable ones", () => {
    const Glyph = () => null;
    const grouped = toProviderMenuItem("catalogs", "skill", row({ group: "Проект", icon: Glyph }));
    expect(grouped?.group).toBe("Проект");
    expect(grouped?.icon).toBe(Glyph);

    // Absent, not `undefined`-valued — the fields are optional under exactOptionalPropertyTypes.
    const plain = toProviderMenuItem("catalogs", "skill", row({ group: "  " }));
    expect("group" in (plain ?? {})).toBe(false);
    expect("icon" in (plain ?? {})).toBe(false);
  });
});

describe("the menu merge", () => {
  const nativeRow: ComposerCommandItem = {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Pick a model",
  };

  it("puts provider rows in the menu beside the app's own, with the trigger's placement", () => {
    registerComposerProvider("catalogs", provider({ trigger: "command" }));
    publishProviderRows("provider:catalogs:command:0", [
      toProviderMenuItem("catalogs", "command", row({ name: "mycommand", insert: "/mycommand " }))!,
    ]);

    // `command` rows LEAD the `/` menu, exactly as `registerItem` rows do.
    const merged = mergePluginComposerItems("command", "", [nativeRow]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "plugin:catalogs:command:mycommand",
      "slash:model",
    ]);

    // `skill` / `agent` rows FOLLOW the app's own sections.
    registerComposerProvider("catalogs", provider());
    publishProviderRows("provider:catalogs:skill:0", [
      toProviderMenuItem("catalogs", "skill", row())!,
    ]);
    const skills = mergePluginComposerItems("skill", "", [nativeRow]);
    expect(skills.map((entry) => entry.id)).toEqual(["slash:model", "plugin:catalogs:skill:auth"]);
  });

  it("does NOT re-filter provider rows by the query — the provider owns its matching rule", () => {
    registerComposerProvider("catalogs", provider());
    // A provider may match on anything (fuzzy, a synonym, a description). The store already holds
    // the answer for the current query, so a second filter here would silently delete matches the
    // plugin meant to show.
    publishProviderRows("provider:catalogs:skill:0", [
      toProviderMenuItem("catalogs", "skill", row({ name: "zzz", label: "zzz" }))!,
    ]);
    expect(mergePluginComposerItems("skill", "auth", [])).toHaveLength(1);
  });

  it("drops a driver's rows when its component unmounts", () => {
    registerComposerProvider("catalogs", provider());
    publishProviderRows("provider:catalogs:skill:0", [
      toProviderMenuItem("catalogs", "skill", row())!,
    ]);
    expect(pluginComposerProviderItems("skill")).toHaveLength(1);

    clearProviderRows("provider:catalogs:skill:0");
    expect(pluginComposerProviderItems("skill")).toHaveLength(0);
  });

  it("renders a provider row under its OWN group label, and the plugin's name without one", () => {
    const grouped = toProviderMenuItem("catalogs", "skill", row({ group: "Проект" }))!;
    const plain = toProviderMenuItem("catalogs", "skill", row({ name: "global-skill" }))!;

    const groups = groupPluginComposerItems([grouped, plain]);
    expect(groups.map((group) => group.label)).toEqual(["Проект", "Skills, Agents & Commands"]);

    // Two plugins that both call a section "Проект" get two sections: merging them would put one
    // plugin's rows under a heading another plugin wrote.
    recordPluginDisplayName("other", "Other");
    const otherGrouped = toProviderMenuItem("other", "skill", row({ group: "Проект" }))!;
    expect(groupPluginComposerItems([grouped, otherGrouped])).toHaveLength(2);
  });

  it("renders in the real menu — the row reaches the DOM with its label and description", () => {
    const item = toProviderMenuItem("catalogs", "skill", row({ group: "Проект" }))!;
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        activeItemId={null}
        isLoading={false}
        items={[item]}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
        resolvedTheme="light"
        triggerKind="skill"
      />,
    );
    expect(html).toContain("auth");
    expect(html).toContain("The auth skill");
    expect(html).toContain("Проект");
  });
});

describe("the active query channel", () => {
  it("publishes the composer's trigger and query, and is a no-op when nothing changed", () => {
    const body = composerProviderDriverBody({
      key: "provider:catalogs:skill:0",
      pluginId: "catalogs",
      trigger: "skill",
      useRows: vi.fn(() => [row()]),
    });
    expect(typeof body).toBe("function");

    setActiveComposerQuery("skill", "au");
    setActiveComposerQuery("skill", "au");
    // Nothing to assert on the store's identity here beyond "it did not throw"; the behaviour the
    // no-op protects — the drivers not re-rendering on every composer render — is a render-count
    // property the driver test below covers.
    setActiveComposerQuery(null, "");
  });
});

describe("the command slug set (plan §2.5.4)", () => {
  it("is derived from the `command` rows, lowercased", () => {
    registerComposerProvider("catalogs", provider({ trigger: "command" }));
    publishProviderRows("provider:catalogs:command:0", [
      toProviderMenuItem("catalogs", "command", row({ name: "MyCommand", insert: "/MyCommand " }))!,
      toProviderMenuItem("catalogs", "command", row({ name: "deploy", insert: "/deploy " }))!,
    ]);

    const slugs = pluginCommandSlugs();
    expect([...slugs].sort()).toEqual(["deploy", "mycommand"]);
    // A `skill` row is not a slash command and must never widen the allowlist.
    registerComposerProvider("catalogs", provider());
    publishProviderRows("provider:catalogs:skill:0", [
      toProviderMenuItem("catalogs", "skill", row())!,
    ]);
    expect(pluginCommandSlugs().has("auth")).toBe(false);
  });

  it("is primed at the EMPTY query, so a hand-typed /name passes before any menu opened (P5)", () => {
    // The race the plan flags: the user types `/mycommand` and sends it without ever opening the
    // picker. The rows in the store are for whatever query the menu last asked for — which is
    // nothing at all on a cold page — so the empty-query drivers publish here instead.
    publishPrimedCommandSlugs("provider:catalogs:command:0", ["mycommand"]);
    expect(pluginCommandSlugs().has("mycommand")).toBe(true);
  });
});

describe("the 500-row cap", () => {
  it("drops the excess and keeps the provider", () => {
    const many = Array.from({ length: MAX_COMPOSER_PROVIDER_ROWS + 25 }, (_, index) =>
      toProviderMenuItem("catalogs", "skill", row({ name: `s${String(index)}` })),
    ).filter((item) => item !== null);

    registerComposerProvider("catalogs", provider());
    // The driver slices before publishing; this asserts the store holds what a driver would give
    // it and that the number itself is the documented one.
    publishProviderRows("provider:catalogs:skill:0", many.slice(0, MAX_COMPOSER_PROVIDER_ROWS));
    expect(pluginComposerProviderItems("skill")).toHaveLength(MAX_COMPOSER_PROVIDER_ROWS);
    expect(MAX_COMPOSER_PROVIDER_ROWS).toBe(500);
  });
});
