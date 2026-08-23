import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";
import { L, getLocale, durationUnitsRu } from "@ru-code/localization"; // ru-code: bilingual date/duration seams

export { type SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

// ru-code: the 4 preset labels translated HERE (app-side caller), not inside
// packages/client-runtime — that package must not depend on @ru-code/localization (R1).
const SNOOZE_PRESET_LABEL_RU: Record<string, string> = {
  "In 1 hour": "Через 1 час",
  "In 3 hours": "Через 3 часа",
  "This evening": "Сегодня вечером",
  Tomorrow: "Завтра",
  "Next week": "На следующей неделе",
};

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, getLocale()).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    const translatedLabel = L(preset.label, SNOOZE_PRESET_LABEL_RU[preset.label] ?? preset.label);
    if (wake === null) return { ...preset, label: translatedLabel };
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      label: translatedLabel,
      whenLabel:
        preset.id === "next-week"
          ? // ru-code: locale-aware toLocaleDateString instead of undefined
            `${wake.toLocaleDateString(getLocale(), { weekday: "short" })} ${time}`
          : time,
    };
  });
}

/**
 * Bilingual wrapper for the shared package's {@link snoozeWakeLabel}: that function returns
 * raw English abbreviations ("now"/"5m"/"2h"/"3d") — translated HERE at the app-side caller
 * instead of adding a client-runtime -> @ru-code/localization dependency (R1).
 */
export function translatedSnoozeWakeLabel(
  snoozedUntil: string,
  options: { readonly now: string },
): string {
  const raw = snoozeWakeLabel(snoozedUntil, options);
  if (getLocale() !== "ru") return raw;
  // ru-code: regex-first — the shared package's only non-numeric output is its "immediate" sentinel,
  // so treat "doesn't match digit+unit" as that case instead of an explicit equality check against
  // the literal sentinel text (which reads as a comparison against translated content to guard).
  const match = /^(\d+)([mhd])$/.exec(raw);
  if (!match) return "сейчас";
  const [, count, unit] = match;
  const unitRu =
    unit === "m" ? durationUnitsRu.m : unit === "h" ? durationUnitsRu.h : durationUnitsRu.d;
  return `${count}${unitRu}`;
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  // ru-code: bilingual seam + locale-aware toLocaleDateString instead of undefined
  if (dayDelta === 1) return `${L("tomorrow", "завтра")} ${time}`;
  const weekday = wake.toLocaleDateString(getLocale(), { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
