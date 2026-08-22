// ru-code: SW page kit — bilingual string pairs (#35).
//
// sw-kit is OUTSIDE the dict build transform (it emits plain strings from pure
// TS, there is no JSX for the L/LT transform to rewrite), so localization here
// is EXPLICIT {ru,en} pairs picked by the mirrored locale at emission time. The
// handful of strings the vanilla page script writes AFTER emission (probe label,
// copy feedback, elapsed counter) cannot be picked at emission — they travel in
// the `__RCU__.strings` map the page script reads (see pageScript.ts).

export type SwLocale = "ru" | "en";

/** Narrow an arbitrary mirror locale to the two the pages support (default ru). */
export function toSwLocale(raw: string | null | undefined): SwLocale {
  return raw === "en" ? "en" : "ru";
}

/** Pick the localized variant. `en` only when explicitly English; ru is the default. */
export function pick(locale: SwLocale, ru: string, en: string): string {
  return locale === "en" ? en : ru;
}

/** Strings the page script writes at runtime — emitted into `__RCU__.strings`. */
export interface RuntimeStrings {
  readonly probing: string;
  readonly probeAgain: string;
  readonly copy: string;
  readonly copied: string;
  readonly elapsedPre: string;
  readonly elapsedSuf: string;
}

export function runtimeStrings(locale: SwLocale): RuntimeStrings {
  return {
    probing: pick(locale, "Проверяю…", "Checking…"),
    probeAgain: pick(locale, "Проверить снова", "Check again"),
    copy: pick(locale, "Копировать", "Copy"),
    copied: pick(locale, "Скопировано", "Copied"),
    elapsedPre: pick(locale, "идёт ", "running "),
    elapsedSuf: pick(locale, " с", " s"),
  };
}
