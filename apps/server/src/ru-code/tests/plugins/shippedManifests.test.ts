// @effect-diagnostics nodeBuiltinImport:off -- this suite reads the SHIPPED LIST off disk
// ru-code: plugins — what every SHIPPED plugin's manifest owes the user (S49 item 10).
//
// `plugin.json`'s `name` and `description` are the ONLY strings the host draws before any plugin
// code runs, and the one surface that draws them is Settings ▸ Расширения — which, by its own
// header, is "the only place" a user finds out what a plugin is and whether it is working. The app
// ships in two languages, which is why the SDK gives the manifest an `{ en, ru }` pair.
//
// WHY HERE AND NOT FIVE TIMES OVER. Exactly one plugin asserted this —
// `plugin-auto-coder/tests/manifest.test.ts`, written after S40 F3 found that plugin shipping an
// English-only name and no description at all. Its own header states the rule as a CROSS-plugin
// one ("The four plugins beside it in that list all carry both arms and a description, and all four
// are 1.0.0"), so copying it into five packages would be the wrong fix twice over: five copies to
// drift, and still nothing covering a SIXTH plugin somebody adds to the list tomorrow.
//
// The list is the subject. `ru-code/packaging/shipped-plugins.json` IS what a release carries
// (V2-20), so walking it covers whatever is on it, today and later, and a new entry is covered the
// moment it is added rather than when somebody remembers to write a test.
//
// The manifest SOURCE is read (`src/plugin.json`), not `dist/` — so this holds with or without a
// build, exactly as the per-plugin test it replaces did. A listed path whose package is not checked
// out is SKIPPED, not failed: the shipped list may name a plugin this clone does not have, which is
// the same posture `stageShippedPlugins` takes (a missing path is logged and skipped, never fatal).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/** Repo root: this file is `apps/server/src/ru-code/tests/plugins/`. */
const APP_ROOT = NodePath.resolve(import.meta.dirname, "../../../../../..");
const LIST = NodePath.join(APP_ROOT, "ru-code/packaging/shipped-plugins.json");

/** A `dist` folder path from the list → the package's manifest SOURCE, if it is checked out. */
const manifestSourceOf = (entry: string): string | null => {
  const folder = NodePath.isAbsolute(entry) ? entry : NodePath.join(APP_ROOT, entry);
  // Every entry is `<package>/dist`; the source manifest is `<package>/src/plugin.json`.
  const source = NodePath.join(NodePath.dirname(folder), "src/plugin.json");
  return NodeFS.existsSync(source) ? source : null;
};

const listed = (): ReadonlyArray<string> => {
  const parsed = JSON.parse(NodeFS.readFileSync(LIST, "utf8")) as {
    plugins?: ReadonlyArray<string>;
  };
  return parsed.plugins ?? [];
};

/** The `{ en, ru }` pair the host draws, or `null` for anything that is not one. */
const bothArms = (value: unknown): { readonly en: string; readonly ru: string } | null => {
  if (typeof value !== "object" || value === null) return null;
  const { en, ru } = value as { en?: unknown; ru?: unknown };
  return typeof en === "string" && typeof ru === "string" ? { en, ru } : null;
};

describe("every plugin on the shipped list (V2-20)", () => {
  it("the list is not empty — a vacuous walk would assert nothing", () => {
    expect(listed().length).toBeGreaterThan(0);
  });

  it("names and describes itself in BOTH languages, and is 1.0.0", () => {
    const checked: Array<string> = [];
    const problems: Array<string> = [];

    for (const entry of listed()) {
      const source = manifestSourceOf(entry);
      // Not checked out in this clone — the same posture `stageShippedPlugins` takes.
      if (source === null) continue;
      const manifest = JSON.parse(NodeFS.readFileSync(source, "utf8")) as {
        id?: unknown;
        version?: unknown;
        name?: unknown;
        description?: unknown;
      };
      const id = typeof manifest.id === "string" ? manifest.id : entry;
      checked.push(id);

      // A PLAIN STRING name is the defect S40 F3 found: the Russian app then draws the English
      // string, which is what a user of that build actually sees.
      const name = bothArms(manifest.name);
      if (name === null) problems.push(`${id}: name is not an { en, ru } pair`);
      else if (name.en.trim() === "" || name.ru.trim() === "")
        problems.push(`${id}: name has an empty arm`);

      // Absent means the Settings row has no second line at all.
      const description = bothArms(manifest.description);
      if (description === null) problems.push(`${id}: description is not an { en, ru } pair`);
      else if (description.en.trim() === "" || description.ru.trim() === "")
        problems.push(`${id}: description has an empty arm`);

      // V2-31's posture: nothing is published, so nothing is pre-1.
      if (manifest.version !== "1.0.0")
        problems.push(`${id}: version is ${String(manifest.version)}`);
    }

    // Report every offender at once — a list walk that dies on the first one hides the rest.
    expect(problems).toEqual([]);
    // …and prove the walk actually reached the packages, so a broken path resolver cannot make
    // this pass by checking nothing.
    expect(checked.length).toBeGreaterThan(0);
  });
});
