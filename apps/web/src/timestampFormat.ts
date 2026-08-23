import { type TimestampFormat } from "@t3tools/contracts/settings";
import { L, getLocale, durationUnitsRu, localeDateFormat } from "@ru-code/localization"; // ru-code: bilingual duration/date seams

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

/**
 * Pick the locale to format wall-clock times in, given the locale the host
 * reports. Hosts that report nothing fall back to `undefined`, which is the
 * runtime default and the right answer in a browser.
 *
 * A host reports a locale only when it knows better than the runtime does —
 * see `getSystemLocale` on the desktop bridge for why desktop does.
 */
export function resolveTimestampLocale(
  systemLocale: string | null | undefined,
): string | undefined {
  const tag = systemLocale?.trim();
  if (!tag) return undefined;

  try {
    // Every timestamp in the UI runs through this formatter, so a tag the host
    // could not normalize falls back rather than throwing. Throws on a
    // structurally invalid tag; a well-formed tag ICU has no data for resolves
    // here and is left to ICU's own fallback.
    Intl.DateTimeFormat.supportedLocalesOf([tag]);
    return tag;
  } catch {
    return undefined;
  }
}

function readHostSystemLocale(): string | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.getSystemLocale?.() ?? null;
}

const timestampLocale = resolveTimestampLocale(readHostSystemLocale());

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  // ru-code: cache key includes the locale so a locale switch doesn't serve a stale formatter
  const locale = getLocale();
  const cacheKey = `${locale}:${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  // ru-code: the app's language wins when it is Russian (I08 — a Russian UI must not print an
  // American clock); otherwise defer verbatim to the host tag t3 resolves (#6190/#7081), so an
  // en-GB desktop keeps 15:44 and the numeric date below stays in the same locale.
  const formatter =
    locale === "ru"
      ? localeDateFormat("ru", getTimestampFormatOptions(timestampFormat, includeSeconds))
      : new Intl.DateTimeFormat(
          timestampLocale,
          getTimestampFormatOptions(timestampFormat, includeSeconds),
        );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, true).format(date);
}

// ru-code: was a module-level `const` frozen at load with an `undefined` locale — made
// lazy/per-locale so a runtime locale switch is reflected instead of frozen at import time.
const monthNameFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getMonthNameFormatter(): Intl.DateTimeFormat {
  const locale = getLocale();
  let formatter = monthNameFormatterCache.get(locale);
  if (!formatter) {
    formatter = localeDateFormat(locale, { month: "long" });
    monthNameFormatterCache.set(locale, formatter);
  }
  return formatter;
}

function ordinalSuffix(day: number): string {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Long-form tooltip label, e.g. `12:04, 4th June`.
 * Renders the wall-clock time without seconds followed by the ordinal day and month name.
 */
export function formatChatTimestampTooltip(
  isoDate: string,
  timestampFormat: TimestampFormat,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = formatShortTimestamp(isoDate, timestampFormat);
  if (getLocale() === "ru") {
    // ru-code: Russian long dates have no ordinal-suffix convention ("4th June" has no
    // Russian equivalent shape) — use the platform's own long-date formatting instead.
    const longDate = localeDateFormat(getLocale(), {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
    return `${time}, ${longDate}`;
  }
  const day = date.getDate();
  const month = getMonthNameFormatter().format(date);
  const year = date.getFullYear();
  return `${time}, ${day}${ordinalSuffix(day)} ${month} ${year}`;
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, false).format(date);
}

const numericDateFormatter = new Intl.DateTimeFormat(timestampLocale, {
  month: "numeric",
  day: "numeric",
});
const numericDateWithYearFormatter = new Intl.DateTimeFormat(timestampLocale, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older `8/13 12:34 PM`
 * (locale digit order), with the year included once the calendar year differs.
 * Boundaries are local calendar days, not 24-hour windows.
 */
export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false).format(date);

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const dateFormatter =
    date.getFullYear() === now.getFullYear() ? numericDateFormatter : numericDateWithYearFormatter;
  return `${dateFormatter.format(date)} ${time}`;
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
type RelativeTimeParts = { value: string; suffix: string | null };
export type RelativeTimeState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "relative"; value: string; suffix: string | null };

export function formatRelativeTime(isoDate: string): RelativeTimeParts | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  // ru-code: bilingual duration-unit seams (durationUnitsRu map)
  if (diffMs < 0) return { value: L("just now", durationUnitsRu.justNow), suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { value: L("just now", durationUnitsRu.justNow), suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return {
      value: `${minutes}${L("m", durationUnitsRu.m)}`,
      suffix: L("ago", durationUnitsRu.ago),
    };
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return { value: `${hours}${L("h", durationUnitsRu.h)}`, suffix: L("ago", durationUnitsRu.ago) };
  const days = Math.floor(hours / 24);
  return { value: `${days}${L("d", durationUnitsRu.d)}`, suffix: L("ago", durationUnitsRu.ago) };
}

export function formatRelativeTimeLabel(isoDate: string) {
  const relative = formatRelativeTime(isoDate);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

export function getRelativeTimeState(isoDate: string | null): RelativeTimeState {
  if (!isoDate) return { status: "missing" };
  const relative = formatRelativeTime(isoDate);
  if (!relative) return { status: "invalid" };
  return { status: "relative", ...relative };
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(isoDate: string, nowMs: number = Date.now()): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = nowMs - date.getTime();
  // ru-code: bilingual duration-unit seams (durationUnitsRu map)
  if (diffMs <= 0) return L("just now", durationUnitsRu.justNow);

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return L("just now", durationUnitsRu.justNow);
  if (seconds < 60) return `${seconds}${L("s", durationUnitsRu.s)}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${L("m", durationUnitsRu.m)}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${L("h", durationUnitsRu.h)}`;

  const days = Math.floor(hours / 24);
  return `${days}${L("d", durationUnitsRu.d)}`;
}

/**
 * Relative time until an ISO instant (e.g. expiry). Mirrors {@link formatRelativeTime} but for future times.
 */
export function formatRelativeTimeUntil(isoDate: string): RelativeTimeParts | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  // ru-code: bilingual duration-unit seams (durationUnitsRu map)
  if (diffMs <= 0) return { value: L("Expired", durationUnitsRu.expired), suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: L("Soon", durationUnitsRu.soon), suffix: null };
  if (seconds < 60)
    return {
      value: `${seconds}${L("s", durationUnitsRu.s)}`,
      suffix: L("left", durationUnitsRu.left),
    };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return {
      value: `${minutes}${L("m", durationUnitsRu.m)}`,
      suffix: L("left", durationUnitsRu.left),
    };
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return {
      value: `${hours}${L("h", durationUnitsRu.h)}`,
      suffix: L("left", durationUnitsRu.left),
    };
  const days = Math.floor(hours / 24);
  return { value: `${days}${L("d", durationUnitsRu.d)}`, suffix: L("left", durationUnitsRu.left) };
}

export function formatRelativeTimeUntilLabel(isoDate: string): string {
  const relative = formatRelativeTimeUntil(isoDate);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(isoDate: string, nowMs: number = Date.now()): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = date.getTime() - nowMs;
  // ru-code: bilingual duration-unit seams (durationUnitsRu map)
  if (diffMs <= 0) return L("Expired", durationUnitsRu.expired);

  const totalSeconds = Math.floor(diffMs / 1000);
  const expiresIn = L("Expires in", durationUnitsRu.expiresIn);
  const s = L("s", durationUnitsRu.s);
  const m = L("m", durationUnitsRu.m);
  const h = L("h", durationUnitsRu.h);
  const d = L("d", durationUnitsRu.d);
  if (totalSeconds < 5) return L("Expires in a moment", durationUnitsRu.expiresInAMoment);
  if (totalSeconds < 60) return `${expiresIn} ${totalSeconds}${s}`;

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0
      ? `${expiresIn} ${minutes}${m}`
      : `${expiresIn} ${minutes}${m} ${seconds}${s}`;
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const parts = [`${hours}${h}`];
    if (minutes > 0) parts.push(`${minutes}${m}`);
    if (seconds > 0) parts.push(`${seconds}${s}`);
    return `${expiresIn} ${parts.join(" ")}`;
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return `${expiresIn} ${days}${d}`;
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  const tail: string[] = [];
  if (hours > 0) tail.push(`${hours}${h}`);
  if (minutes > 0) tail.push(`${minutes}${m}`);
  if (seconds > 0) tail.push(`${seconds}${s}`);
  return tail.length > 0
    ? `${expiresIn} ${days}${d} ${tail.join(" ")}`
    : `${expiresIn} ${days}${d}`;
}
