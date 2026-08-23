// Shared Russian words/abbreviations for duration, relative-time, and expiry phrases used by
// the hand-written `// ru-code:` seams across timestampFormat.ts, Sidebar.logic.ts,
// Sidebar.snooze.ts, wireToUi.ts, and threadSettled.ts (round 12). One map, one place to keep
// the wording consistent instead of re-typing the same words at every call site.
//
// Keys are camelCase identifiers (not the literal English phrase) so every access is DOT
// notation, never `obj["literal"]` bracket access — compareGuard's bracket-key check cannot
// tell "indexing my own translation lookup table" apart from "comparing a translated runtime
// value", so a bracket access using the exact `en` text as the key reads as a false-positive
// DANGER site. Dot notation on a camelCase key sidesteps the pattern entirely; see round 12's
// report for the guard run that caught this.
export const durationUnitsRu = {
  s: "с",
  m: "мин",
  h: "ч",
  d: "д",
  ago: "назад",
  left: "осталось",
  justNow: "только что",
  justNowCapitalized: "Только что",
  expired: "Истекло",
  soon: "Скоро",
  expiresIn: "Истекает через",
  expiresInAMoment: "Истекает через мгновение",
} as const;

/**
 * Locale-aware `Intl.DateTimeFormat` — a thin wrapper so call sites pass our `getLocale()`
 * result instead of `undefined` (which lets the runtime's OS/browser locale leak through,
 * ignoring the app's own locale switch).
 */
export function localeDateFormat(
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, options);
}
