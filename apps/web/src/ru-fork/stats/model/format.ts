/**
 * ru-fork: Analytics — display formatters (tokens, counts, durations, dates).
 * Russian-locale, compact, single source so every widget formats identically.
 *
 * @module ru-fork/stats/model/format
 */

function roundToOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) return `${roundToOneDecimal(value / 1_000_000_000)} млрд`;
  if (magnitude >= 1_000_000) return `${roundToOneDecimal(value / 1_000_000)}M`;
  if (magnitude >= 1_000) return `${roundToOneDecimal(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatTokens(value: number): string {
  return formatCompact(value);
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

export function formatPct(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatSignedPct(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0%";
  const arrow = value > 0 ? "▲" : "▼";
  return `${arrow}${Math.abs(value).toFixed(0)}%`;
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}мс`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${roundToOneDecimal(seconds)}с`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return remainderSeconds ? `${minutes}м ${remainderSeconds}с` : `${minutes}м`;
}

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function monthShort(monthIndex: number): string {
  return MONTHS_SHORT.at(monthIndex) ?? "";
}

/** "17 июн" from an ISO date or yyyy-mm-dd key. */
export function formatDayLabel(isoString: string): string {
  const date = new Date(isoString.length <= 10 ? `${isoString}T00:00:00Z` : isoString);
  return `${date.getUTCDate()} ${monthShort(date.getUTCMonth())}`;
}

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  return `${date.getUTCDate()} ${monthShort(date.getUTCMonth())}, ${hours}:${minutes}`;
}

export const WEEKDAY_LABELS: readonly string[] = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function weekdayLabel(mondayBasedWeekday: number): string {
  return WEEKDAY_LABELS.at(mondayBasedWeekday) ?? "";
}

/** ISO weekday index with Monday = 0. */
export function isoWeekday(isoString: string): number {
  const sundayBasedDay = new Date(isoString).getUTCDay(); // 0=Sunday
  return (sundayBasedDay + 6) % 7;
}

export function dayKey(isoString: string): string {
  return isoString.slice(0, 10);
}
