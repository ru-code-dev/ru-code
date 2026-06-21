// ru-fork: pure reduction of one file's telemetry into a StatsSession. No I/O.
// Every field the dashboard reads is computed here from real events only.
import { IsoDateTime, type StatsCategory, type StatsSession } from "@t3tools/contracts";

import { isTempCwd, projectLabelFor } from "./paths.ts";
import { SERVICE_SIGNATURES } from "./serviceSignatures.ts";
import type { FileTelemetry, TelemetryEvent } from "./telemetry.ts";

const SIDE_QUERY_PREFIX = "side-query:";
const COMPRESS_PREFIX = "compress-";
/** Real interactive turns use "<sessionId>########<n>"; everything else is one-shot/auto. */
const REAL_TURN_MARKER = "########";

interface MutableDayBucket {
  input: number;
  output: number;
  thinking: number;
  cached: number;
  apiCalls: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;

// Day/hour are bucketed in the viewer's timezone (passed in — the machine-local zone in
// production, "UTC" in tests). `Intl` (not `new Date()`, which the server bans) does the
// zone conversion; formatters are memoized per zone. The web computes the same keys from
// its own local clock — same machine ⇒ same zone ⇒ keys line up.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const existing = dateFormatters.get(timeZone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  dateFormatters.set(timeZone, created);
  return created;
};
const hourFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const existing = hourFormatters.get(timeZone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" });
  hourFormatters.set(timeZone, created);
  return created;
};

/** Local calendar day of an ISO timestamp — "YYYY-MM-DD" (en-CA renders ISO order).
 *  Returns "" for an unparseable timestamp (caller skips it). */
const dayOf = (timestamp: string, timeZone: string): string => {
  const epochMs = Date.parse(timestamp);
  return Number.isNaN(epochMs) ? "" : dateFormatter(timeZone).format(epochMs);
};

/** Local hour 0..23 of an ISO timestamp (0 for an unparseable timestamp). */
const hourOf = (timestamp: string, timeZone: string): number => {
  const epochMs = Date.parse(timestamp);
  return Number.isNaN(epochMs) ? 0 : Number(hourFormatter(timeZone).format(epochMs));
};

/** Weekday (Monday=0) of a "YYYY-MM-DD" key (calendar weekday, TZ-independent;
 *  derived from epoch days, 1970-01-01 = Thursday, to avoid `new Date()`). */
const weekdayOfDayKey = (dayKey: string): number => {
  const daysSinceEpoch = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / MILLISECONDS_PER_DAY);
  const sundayBasedWeekday = (((daysSinceEpoch + 4) % 7) + 7) % 7;
  return (sundayBasedWeekday + 6) % 7;
};

/** Distinct real-turn ids — only the "########" interactive turns count. */
const countTurns = (events: ReadonlyArray<TelemetryEvent>): number => {
  const turnIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== "api_response") continue;
    const promptId = event.promptId;
    if (promptId === undefined || !promptId.includes(REAL_TURN_MARKER)) continue;
    turnIds.add(promptId);
  }
  return turnIds.size;
};

/** Classify the file: dialog (has a real turn) → else qwen-internal by prompt_id →
 *  else one of our service prompts by content → else "service" (unknown one-shot). */
const classifyCategory = (telemetry: FileTelemetry): StatsCategory => {
  const promptIds: string[] = [];
  for (const event of telemetry.events) {
    if (event.kind === "api_response" && event.promptId !== undefined) promptIds.push(event.promptId);
  }
  if (promptIds.some((promptId) => promptId.includes(REAL_TURN_MARKER))) return "dialog";
  if (promptIds.some((promptId) => promptId.startsWith(SIDE_QUERY_PREFIX))) return "memory";
  if (promptIds.some((promptId) => promptId.startsWith(COMPRESS_PREFIX))) return "compress";
  if (promptIds.some((promptId) => promptId.includes("#"))) return "subagent";
  const userText = telemetry.firstUserText ?? "";
  for (const signature of SERVICE_SIGNATURES) {
    if (userText.includes(signature.marker)) return signature.category;
  }
  return "service";
};

const dominant = (counts: ReadonlyMap<string, number>, fallback: string): string => {
  let best = fallback;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
};

export interface AggregateInput {
  readonly telemetry: FileTelemetry;
  /** Directory name under projects/ (the encoded cwd) — stable project key. */
  readonly projectDir: string;
  /** File's session id (filename stem) when telemetry carries none. */
  readonly fileSessionId: string;
  /** ISO stamp for this scan (lastSeenAt + when nothing else is available). */
  readonly nowIso: string;
  /** IANA zone for day/hour bucketing (machine-local in prod, "UTC" in tests). */
  readonly timeZone: string;
}

/** Build a present (on-disk) StatsSession from a file's telemetry. */
export const aggregateSession = (input: AggregateInput): StatsSession => {
  const { telemetry, projectDir, fileSessionId, nowIso, timeZone } = input;
  const cwd = telemetry.cwd ?? "";
  const apiResponses = telemetry.events.filter(
    (event): event is Extract<TelemetryEvent, { kind: "api_response" }> =>
      event.kind === "api_response",
  );

  // tokens + latency
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cachedTokens = 0;
  let latencySum = 0;
  let maxLatencyMs = 0;
  const modelCounts = new Map<string, number>();
  for (const response of apiResponses) {
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    thinkingTokens += response.thinkingTokens;
    cachedTokens += response.cachedTokens;
    latencySum += response.durationMs;
    if (response.durationMs > maxLatencyMs) maxLatencyMs = response.durationMs;
    if (response.model !== undefined) {
      modelCounts.set(response.model, (modelCounts.get(response.model) ?? 0) + 1);
    }
  }

  // tools + approvals
  const toolCounts: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};
  let autoAccepted = 0;
  let rejected = 0;
  for (const event of telemetry.events) {
    if (event.kind !== "tool_call") continue;
    toolCounts[event.functionName] = (toolCounts[event.functionName] ?? 0) + 1;
    if (!event.success) {
      toolFailures[event.functionName] = (toolFailures[event.functionName] ?? 0) + 1;
    }
    if (event.decision === "auto_accept") autoAccepted += 1;
    if (event.decision === "reject") rejected += 1;
  }

  // errors
  const errorTypes: Record<string, number> = {};
  for (const event of telemetry.events) {
    if (event.kind !== "api_error") continue;
    errorTypes[event.errorType] = (errorTypes[event.errorType] ?? 0) + 1;
  }

  // time-grain buckets: a day entry marks activity (any event); api_response events
  // add their tokens/calls to that day and to the weekday+hour heatmap slot.
  const tokensByDay: Record<string, MutableDayBucket> = {};
  const tokensByWeekdayHour: Record<string, number> = {};
  const ensureDay = (day: string): MutableDayBucket =>
    (tokensByDay[day] ??= { input: 0, output: 0, thinking: 0, cached: 0, apiCalls: 0 });
  for (const event of telemetry.events) {
    const day = dayOf(event.timestamp, timeZone);
    if (day === "") continue; // unparseable timestamp — can't attribute to a day
    const dayBucket = ensureDay(day);
    if (event.kind !== "api_response") continue;
    dayBucket.input += event.inputTokens;
    dayBucket.output += event.outputTokens;
    dayBucket.thinking += event.thinkingTokens;
    dayBucket.cached += event.cachedTokens;
    dayBucket.apiCalls += 1;
    const visibleTokens = event.inputTokens + event.outputTokens + event.thinkingTokens;
    const slot = `${weekdayOfDayKey(day)}:${hourOf(event.timestamp, timeZone)}`;
    tokensByWeekdayHour[slot] = (tokensByWeekdayHour[slot] ?? 0) + visibleTokens;
  }

  // time span
  const timestamps = telemetry.events.map((event) => event.timestamp).toSorted();
  const startedAt = timestamps[0] ?? nowIso;
  const endedAt = timestamps[timestamps.length - 1] ?? startedAt;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

  const category = classifyCategory(telemetry);
  const isBackground = category !== "dialog";

  return {
    sessionId: telemetry.sessionId ?? fileSessionId,
    projectId: projectDir,
    projectLabel: projectLabelFor(cwd),
    projectPath: cwd,
    projectKind: isTempCwd(cwd) ? "temp" : "real",
    branch: telemetry.branch ?? "",
    model: dominant(modelCounts, ""),
    startedAt,
    durationMs,
    turns: countTurns(telemetry.events),
    category,
    isBackground,
    apiCalls: apiResponses.length,
    tokens: { input: inputTokens, output: outputTokens, thinking: thinkingTokens, cached: cachedTokens },
    avgLatencyMs: apiResponses.length > 0 ? latencySum / apiResponses.length : 0,
    maxLatencyMs,
    toolCounts,
    toolFailures,
    errorTypes,
    autoAccepted,
    rejected,
    tokensByDay,
    tokensByWeekdayHour,
    present: true,
    lastSeenAt: IsoDateTime.make(nowIso),
  };
};
