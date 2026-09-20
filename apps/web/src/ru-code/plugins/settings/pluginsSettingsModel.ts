// ru-code S38 (V2-43, step 11): what the Plugins settings section SAYS and SHOWS, as pure functions.
//
// `apps/web`'s unit project runs in the NODE environment (there is no jsdom or happy-dom in this
// repo), so every rule that can live outside a component does — the same doctrine `seams.tsx` and
// `composerRows.ts` state. What is left in the page is layout, and the layout is the app's own
// (the provider instance item's Collapsible + Switch); nothing here invents a style.

import { localizedText } from "@smart-tools/plugin-sdk/contracts";
import { getLocale, L } from "@ru-code/localization";
import type { PluginSettingsRow } from "@t3tools/contracts";

export type { PluginSettingsRow };

/**
 * The plugin's NAME, in the app's language (S38 step 11).
 *
 * The wire carries what the author wrote — a string or `{ en, ru }` — because the server does not
 * know the app's language. Empty or undrawable falls back to the id: a row can never be nameless,
 * and the id is what the folder is called, which is what a person would go looking for.
 */
export const rowName = (row: PluginSettingsRow): string => {
  const resolved = localizedText(row.name, getLocale());
  return resolved === "" ? row.id : resolved;
};

/** The plugin's one line about itself, or `""` — the host never substitutes a placeholder. */
export const rowDescription = (row: PluginSettingsRow): string =>
  localizedText(row.description, getLocale());

/**
 * Which DOT the row's icon slot draws.
 *
 * Three states and three colours, and the colours are the app's own status tokens
 * (`components/settings/providerStatus.ts` uses the same two for ready and error):
 *  · `loaded` — green, it is running;
 *  · `failed` — red, it tried and broke, and the reason is in the body;
 *  · anything else (`skipped`, switched off) — grey, nothing ran and nothing is wrong.
 */
export const rowDotClass = (row: PluginSettingsRow): string =>
  row.state === "loaded"
    ? "bg-success"
    : row.state === "failed"
      ? "bg-destructive"
      : "bg-muted-foreground/40";

/** Where the folder came from, in the user's own words. */
export const rootLabel = (root: PluginSettingsRow["root"]): string =>
  root === "shipped"
    ? L("bundled with the app", "поставляется с приложением")
    : L("installed by you", "установлен вами");

/** The three field labels of the expanded row — the app's settings collapses label every field. */
export const sourceFieldLabel = (): string => L("Source", "Источник");
export const folderFieldLabel = (): string => L("Folder", "Папка");
export const errorFieldLabel = (): string => L("Why it failed", "Почему не загрузилось");

/**
 * Does the app have to restart before what the user just asked for is true?
 *
 * The one comparison the notice is made of: the SAVED answer (what the next boot will do) against
 * the RUNNING one (what this process did). Flipping a switch and flipping it back makes this false
 * again, which is why it is derived on every render and never latched.
 */
export const restartNeeded = (rows: ReadonlyArray<PluginSettingsRow>): boolean =>
  rows.some((row) => row.enabledSaved !== row.enabledRunning);

/** The plugins whose saved switch and running state disagree — what the notice is about. */
export const pendingPluginNames = (rows: ReadonlyArray<PluginSettingsRow>): ReadonlyArray<string> =>
  rows.filter((row) => row.enabledSaved !== row.enabledRunning).map((row) => rowName(row));

/** The ONE sentence the callout above the list carries. `""` when no restart is owed. */
export const restartLine = (rows: ReadonlyArray<PluginSettingsRow>): string =>
  restartNeeded(rows)
    ? L(
        "Restart the app to apply the changes",
        "Перезапустите приложение, чтобы применить изменения",
      )
    : "";

/**
 * Disabling is not uninstalling — the line that says so, once, under the whole list.
 *
 * It is load-bearing for a SHIPPED plugin: the user cannot delete its folder (it lives in the
 * release payload and comes back with the next update), so the switch is the only thing they have,
 * and it must be obvious that it does not throw their data away.
 */
export const dataKeptLine = (): string =>
  L(
    "Switching a plugin off leaves its data in place — switch it back on and everything is where it was.",
    "Выключенный плагин сохраняет свои данные — включите его снова, и всё останется на месте.",
  );

/** The switch's accessible name: one per plugin, and it names the plugin. */
export const switchLabel = (row: PluginSettingsRow): string =>
  row.enabledSaved
    ? L(`Disable ${rowName(row)}`, `Выключить ${rowName(row)}`)
    : L(`Enable ${rowName(row)}`, `Включить ${rowName(row)}`);

/** The expander's accessible name — the donor's wording (`Toggle <name> details`). */
export const detailsLabel = (row: PluginSettingsRow): string =>
  L(`Toggle ${rowName(row)} details`, `Показать подробности «${rowName(row)}»`);

/**
 * The rows, in the order the section draws them: running first, then everything else, each group in
 * the order the server scanned it (manifest order, which is the sorted plugins directory).
 *
 * A user opening this page after something went wrong is looking for the plugin that is NOT
 * working, and a list sorted by state puts it where they are already looking. It is derived from
 * `state`, which a switch does not change until the app restarts — so a toggle never reorders the
 * list under the user's finger.
 */
export const orderedRows = (
  rows: ReadonlyArray<PluginSettingsRow>,
): ReadonlyArray<PluginSettingsRow> => [
  ...rows.filter((row) => row.state === "loaded"),
  ...rows.filter((row) => row.state !== "loaded"),
];

/**
 * One plugin's row, updated IN PLACE from the server's answer (S38 step 11).
 *
 * The owner saw the list flicker on a toggle. `setEnabled` answers with every row, and replacing
 * the whole array made React re-render each item with a new object — so this keeps the objects
 * that did not change, by identity, and swaps only the ones that did. With the keys already stable
 * (the plugin id) the DOM element of a row survives its own toggle.
 */
export const mergeRows = (
  current: ReadonlyArray<PluginSettingsRow>,
  answered: ReadonlyArray<PluginSettingsRow>,
): ReadonlyArray<PluginSettingsRow> => {
  const byId = new Map(current.map((row) => [row.id, row]));
  return answered.map((row) => {
    const existing = byId.get(row.id);
    return existing !== undefined && sameRow(existing, row) ? existing : row;
  });
};

/** Field for field, over everything the row draws. */
const sameRow = (left: PluginSettingsRow, right: PluginSettingsRow): boolean =>
  left.id === right.id &&
  left.version === right.version &&
  left.root === right.root &&
  left.dir === right.dir &&
  left.state === right.state &&
  left.error === right.error &&
  left.enabledSaved === right.enabledSaved &&
  left.enabledRunning === right.enabledRunning &&
  JSON.stringify(left.name) === JSON.stringify(right.name) &&
  JSON.stringify(left.description) === JSON.stringify(right.description);
