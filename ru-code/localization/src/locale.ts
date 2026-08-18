// Runtime locale switch for the Ru Code bilingual UI.
//
// Design: the build transform (see ../build) rewrites every human-translated
// display string into a call to `L`/`LT`/`Lp` below, inlining BOTH the English
// original and the Russian translation at the call site. There is no runtime
// dictionary and no per-string id — each site is self-contained, so duplicate
// English strings are never a problem.
//
// The key property is `L(en, ru) === en` when the locale is English: in that
// mode every helper is the identity of its English argument, so a transformed
// program is observationally identical to the original English source. Running
// the test suite in English locale therefore proves the transform changed no
// behavior; running it in Russian exercises the translations.

export type Locale = "ru" | "en";

// Default is Russian — a fresh install ships localized; English is opt-in.
//
// Under the test runner we default to ENGLISH: because L(en, ru) === en in English
// locale, the transformed program is observationally identical to the original English
// source, so the existing (English-asserting) suite proves the transform and seams
// changed no behavior. Tests that want Russian call setLocale("ru") explicitly.
function initialLocale(): Locale {
  // Avoid a hard `process` type dependency (this package is imported in the browser too).
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env && env.VITEST) return "en";
  return "ru";
}

let currentLocale: Locale = initialLocale();

// A hard override (e.g. the server `--language` flag / `T3CODE_LANG`). When set, it
// wins over later `setLocale(...)` calls (such as the persisted-settings sync), so an
// explicit CLI/env language beats the stored UI preference for that process.
let localeOverride: Locale | null = null;

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = localeOverride ?? locale;
}

// Force the process locale and pin it against subsequent setLocale calls.
export function setLocaleOverride(locale: Locale): void {
  localeOverride = locale;
  currentLocale = locale;
}

export function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "en";
}

/**
 * Plain display string. `L("Save", "Сохранить")` → English in EN locale,
 * Russian otherwise. `L(en, ru) === en` in EN locale (the identity property).
 */
export function L(en: string, ru: string): string {
  return currentLocale === "en" ? en : ru;
}

/**
 * Interpolated display string. `en`/`ru` are skeletons whose `{0}`, `{1}`, …
 * placeholders are filled from `exprs` by index (so Russian may reorder the
 * interpolations). Example:
 *   LT("Found {0} files", "Найдено {0} файлов", [count])
 * In EN locale the reconstruction equals the original template string.
 */
export function LT(en: string, ru: string, exprs: readonly unknown[]): string {
  const skeleton = currentLocale === "en" ? en : ru;
  return skeleton.replace(/\{(\d+)\}/g, (_match, index: string) => String(exprs[Number(index)]));
}

/**
 * Locale-aware plural word. English picks singular/plural by `count === 1`;
 * Russian uses the CLDR one/few/many rule via {@link pluralRu}. Used by the
 * hand-written `// ru-code:` plural seams (the sites the build transform cannot
 * synthesize because English has no three-form plural shape).
 *   Lp(count, ["file", "files"], ["файл", "файла", "файлов"])
 */
import { pluralRu } from "./pluralRu.ts";

export function Lp(
  count: number,
  en: readonly [string, string],
  ru: readonly [string, string, string],
): string {
  if (currentLocale === "en") return count === 1 ? en[0] : en[1];
  return pluralRu(count, ru);
}
