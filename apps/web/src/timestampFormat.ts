import { type TimestampFormat } from "@t3tools/contracts/settings";

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

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, false).format(new Date(isoDate));
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
export function formatRelativeTime(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0) return { value: "только что", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { value: "только что", suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}м`, suffix: "назад" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}ч`, suffix: "назад" };
  const days = Math.floor(hours / 24);
  return { value: `${days}д`, suffix: "назад" };
}

export function formatRelativeTimeLabel(isoDate: string) {
  const relative = formatRelativeTime(isoDate);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = nowMs - new Date(isoDate).getTime();
  if (diffMs <= 0) return "только что";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "только что";
  if (seconds < 60) return `${seconds}с`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч`;

  const days = Math.floor(hours / 24);
  return `${days}д`;
}

/**
 * Relative time until an ISO instant (e.g. expiry). Mirrors {@link formatRelativeTime} but for future times.
 */
export function formatRelativeTimeUntil(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return { value: "Истёк", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: "Скоро", suffix: null };
  if (seconds < 60) return { value: `${seconds}с`, suffix: "осталось" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}м`, suffix: "осталось" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}ч`, suffix: "осталось" };
  const days = Math.floor(hours / 24);
  return { value: `${days}д`, suffix: "осталось" };
}

export function formatRelativeTimeUntilLabel(isoDate: string): string {
  const relative = formatRelativeTimeUntil(isoDate);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = new Date(isoDate).getTime() - nowMs;
  if (diffMs <= 0) return "Истёк";

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 5) return "Истекает через мгновение";
  if (totalSeconds < 60) return `Истекает через ${totalSeconds}с`;

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `Истекает через ${minutes}м` : `Истекает через ${minutes}м ${seconds}с`;
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const parts = [`${hours}ч`];
    if (minutes > 0) parts.push(`${minutes}м`);
    if (seconds > 0) parts.push(`${seconds}с`);
    return `Истекает через ${parts.join(" ")}`;
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return `Истекает через ${days}д`;
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  const tail: string[] = [];
  if (hours > 0) tail.push(`${hours}ч`);
  if (minutes > 0) tail.push(`${minutes}м`);
  if (seconds > 0) tail.push(`${seconds}с`);
  return tail.length > 0 ? `Истекает через ${days}д ${tail.join(" ")}` : `Истекает через ${days}д`;
}
