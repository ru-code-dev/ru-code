// ru-code S38 (V2-43, step 11): what the Settings ▸ Plugins section SAYS and SHOWS.
//
// The page itself is layout borrowed whole from the provider instance item; every sentence and
// every state-to-colour decision it draws is a pure function here, for the reason every rule in
// this zone is pure — `apps/web`'s unit project runs in the NODE environment, so a rule that lives
// only inside a component is a rule only the e2e suite can check. The browser proof is
// `ru-code/e2e/tests-plugins/pluginsSettings.e2e.test.ts`.
import type { PluginSettingsRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MAX_MANIFEST_TEXT_LENGTH } from "@smart-tools/plugin-sdk/contracts";

import {
  dataKeptLine,
  detailsLabel,
  mergeRows,
  orderedRows,
  pendingPluginNames,
  restartLine,
  restartNeeded,
  rootLabel,
  rowDescription,
  rowDotClass,
  rowName,
  switchLabel,
} from "../../plugins/settings/pluginsSettingsModel";

const row = (overrides: Partial<PluginSettingsRow> = {}): PluginSettingsRow => ({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  root: "user",
  dir: "/base/plugins/demo",
  state: "loaded",
  enabledSaved: true,
  enabledRunning: true,
  ...overrides,
});

describe("restartNeeded (V2-43)", () => {
  it("is false while every plugin's saved switch matches what is running", () => {
    expect(
      restartNeeded([row(), row({ id: "b", enabledSaved: false, enabledRunning: false })]),
    ).toBe(false);
  });

  it("is true the moment one switch is saved but not yet acted on", () => {
    expect(restartNeeded([row({ enabledSaved: false, enabledRunning: true })])).toBe(true);
  });

  it("goes back to false when the user flips it back — nothing is latched", () => {
    const flipped = row({ enabledSaved: false });
    expect(restartNeeded([flipped])).toBe(true);
    expect(restartNeeded([{ ...flipped, enabledSaved: true }])).toBe(false);
  });

  it("names the plugins the notice is about", () => {
    expect(
      pendingPluginNames([row(), row({ id: "b", name: "Beta", enabledSaved: false })]),
    ).toEqual(["Beta"]);
  });

  it("the callout carries ONE sentence, or nothing at all", () => {
    expect(restartLine([row()])).toBe("");
    const line = restartLine([row({ enabledSaved: false })]);
    expect(line).toMatch(
      /Перезапустите приложение, чтобы применить изменения|Restart the app to apply the changes/,
    );
    // One sentence: no second one glued on.
    expect(line.split(".").filter((part) => part.trim() !== "")).toHaveLength(1);
  });
});

// ru-code S38 step 11: the manifest may say a name and a description in two languages.
describe("the localized pair on a row", () => {
  it("takes a plain-string name, as every manifest written before this did", () => {
    expect(rowName(row({ name: "Demo" }))).toBe("Demo");
  });

  it("takes the arm of an { en, ru } pair the app is running in", () => {
    expect(rowName(row({ name: { en: "Demo", ru: "Демо" } }))).toMatch(/^(Demo|Демо)$/);
  });

  it("falls back to the plugin ID when the author said nothing usable", () => {
    expect(rowName(row({ id: "catalogs", name: "" }))).toBe("catalogs");
    expect(rowName(row({ id: "catalogs", name: "  " }))).toBe("catalogs");
  });

  // ru-code S40 gap 2 (REVIEW): the rule-35 OVERSIZED answer for the two strings S38 step 11 added
  // to this row — the cap AND the clamp, on the surface that draws them.
  //
  // `plugin.json` is data on disk that nothing validated before it landed, so a 500-character name
  // is a manifest a person really writes. The SDK clamps at `MAX_MANIFEST_TEXT_LENGTH` rather than
  // dropping (a long name is still that plugin's name); what this pins is that the clamp reaches
  // the ROW — the name is bounded, is NOT emptied, and does NOT fall back to the id, and the
  // description gets the same treatment one line down.
  it("gap 2: an oversized name and description are CLAMPED in the row, never dropped", () => {
    const long = "Каталог".repeat(100);
    const named = rowName(row({ id: "catalogs", name: { en: long, ru: long } }));
    expect(named.length).toBe(MAX_MANIFEST_TEXT_LENGTH);
    expect(named).toBe(long.slice(0, MAX_MANIFEST_TEXT_LENGTH));
    expect(named).not.toBe("catalogs");

    const described = rowDescription(row({ description: { en: long, ru: long } }));
    expect(described.length).toBe(MAX_MANIFEST_TEXT_LENGTH);
  });

  it("an ABSENT description is empty — the row simply draws no second line", () => {
    expect(rowDescription(row())).toBe("");
  });

  it("a present description is resolved like the name", () => {
    expect(rowDescription(row({ description: { en: "Notes.", ru: "Заметки." } }))).toMatch(
      /^(Notes\.|Заметки\.)$/,
    );
  });
});

describe("the status dot", () => {
  it("is GREEN while the plugin is running", () => {
    expect(rowDotClass(row({ state: "loaded" }))).toBe("bg-success");
  });

  it("is RED when it tried and broke", () => {
    expect(rowDotClass(row({ state: "failed" }))).toBe("bg-destructive");
  });

  it("is GREY when nothing ran and nothing is wrong", () => {
    expect(rowDotClass(row({ state: "skipped" }))).toBe("bg-muted-foreground/40");
    expect(rowDotClass(row({ state: "skipped", enabledSaved: false }))).toBe(
      "bg-muted-foreground/40",
    );
  });
});

describe("what the collapsible body says", () => {
  it("a SHIPPED plugin says so — it is the one the user cannot delete", () => {
    expect(rootLabel("shipped")).toMatch(/поставляется с приложением|bundled with the app/);
  });

  it("a user plugin says so too", () => {
    expect(rootLabel("user")).toMatch(/установлен вами|installed by you/);
  });

  it("says once, under the list, that switching off is not uninstalling", () => {
    expect(dataKeptLine()).toMatch(/данные|data/);
  });
});

describe("the two accessible names", () => {
  it("the switch names the plugin AND what pressing it does", () => {
    expect(switchLabel(row())).toMatch(/Выключить Demo|Disable Demo/);
    expect(switchLabel(row({ enabledSaved: false }))).toMatch(/Включить Demo|Enable Demo/);
  });

  it("the expander names the plugin whose details it opens", () => {
    expect(detailsLabel(row())).toMatch(/Demo/);
  });
});

describe("orderedRows", () => {
  it("puts what is NOT working where the user is already looking, keeping scan order inside", () => {
    const ordered = orderedRows([
      row({ id: "a", state: "loaded" }),
      row({ id: "b", state: "failed" }),
      row({ id: "c", state: "loaded" }),
      row({ id: "d", state: "skipped" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("an empty list is an empty list", () => {
    expect(orderedRows([])).toEqual([]);
  });

  it("a TOGGLE does not reorder the list: the order is keyed on `state`, which a switch does not move", () => {
    const before = [row({ id: "a" }), row({ id: "b" })];
    const after = orderedRows([{ ...before[0]!, enabledSaved: false }, before[1]!]);
    expect(after.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

// ru-code S38 step 11 — the flicker the owner saw.
describe("mergeRows", () => {
  it("keeps the OBJECT of every row the answer did not change", () => {
    const current = [row({ id: "a" }), row({ id: "b" })];
    const merged = mergeRows(current, [row({ id: "a" }), row({ id: "b" })]);
    expect(merged[0]).toBe(current[0]);
    expect(merged[1]).toBe(current[1]);
  });

  it("swaps ONLY the row that changed", () => {
    const current = [row({ id: "a" }), row({ id: "b" })];
    const merged = mergeRows(current, [{ ...current[0]!, enabledSaved: false }, row({ id: "b" })]);
    expect(merged[0]).not.toBe(current[0]);
    expect(merged[0]?.enabledSaved).toBe(false);
    expect(merged[1], "the untouched row is the very object it was").toBe(current[1]);
  });

  it("takes a row the answer added, and drops one it no longer lists", () => {
    const merged = mergeRows([row({ id: "a" })], [row({ id: "a" }), row({ id: "c" })]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(mergeRows([row({ id: "a" }), row({ id: "c" })], [row({ id: "a" })])).toHaveLength(1);
  });

  it("sees a localized name change", () => {
    const current = [row({ id: "a", name: { en: "A", ru: "А" } })];
    const merged = mergeRows(current, [row({ id: "a", name: { en: "A!", ru: "А" } })]);
    expect(merged[0]).not.toBe(current[0]);
  });
});
