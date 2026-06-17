/**
 * ru-fork: Analytics — deterministic fake-session generator.
 *
 * A seeded PRNG (mulberry32) makes the dataset stable across reloads so the
 * dashboard looks the same every time (and snapshots/screenshots are diffable).
 * Timestamps hang off a fixed "today" so the demo never drifts. Pure: no I/O.
 *
 * @module ru-fork/stats/model/generateSessions
 */
import { BRANCHES, ERROR_TYPES, MODELS, PROJECTS, TOOLS, type Weighted } from "./catalog";
import type { StatsSession } from "./types";

/** Anchor day for the whole demo (matches the real scan's last day). */
export const DEMO_TODAY = "2026-06-17";
const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const GENERATED_SPAN_DAYS = 48;
const GENERATED_SESSION_COUNT = 168;

/** Returns a deterministic [0, 1) generator seeded from `seed`. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one element with probability proportional to its weight. */
function pickWeighted<Item extends Weighted>(
  random: () => number,
  items: readonly [Item, ...Item[]],
): Item {
  const totalWeight = items.reduce((runningWeight, candidate) => runningWeight + candidate.weight, 0);
  let threshold = random() * totalWeight;
  let chosen = items[0];
  for (const candidate of items) {
    chosen = candidate;
    threshold -= candidate.weight;
    if (threshold <= 0) break;
  }
  return chosen;
}

function randomInt(random: () => number, minimum: number, maximum: number): number {
  return Math.floor(minimum + random() * (maximum - minimum + 1));
}

/** Heavier activity on working/evening hours so the heatmap looks real. */
function pickActiveHour(random: () => number): number {
  const activeHours: readonly number[] = [9, 10, 11, 14, 15, 16, 17, 21, 22, 23, 1];
  if (random() < 0.72) {
    const position = randomInt(random, 0, activeHours.length - 1);
    return activeHours.at(position) ?? randomInt(random, 0, 23);
  }
  return randomInt(random, 0, 23);
}

interface ToolUsage {
  readonly callsByTool: Record<string, number>;
  readonly failuresByTool: Record<string, number>;
  readonly totalCalls: number;
  readonly failedCalls: number;
}

function buildToolUsage(random: () => number, intensity: number): ToolUsage {
  const callsByTool: Record<string, number> = {};
  const failuresByTool: Record<string, number> = {};
  let totalCalls = 0;
  let failedCalls = 0;
  const distinctToolPicks = randomInt(random, 2, 6) + Math.round(intensity * 4);
  for (let pickIndex = 0; pickIndex < distinctToolPicks; pickIndex += 1) {
    const tool = pickWeighted(random, TOOLS);
    const callCount = randomInt(random, 1, 4);
    callsByTool[tool.name] = (callsByTool[tool.name] ?? 0) + callCount;
    totalCalls += callCount;
    let failuresForTool = 0;
    for (let attempt = 0; attempt < callCount; attempt += 1) {
      if (random() > tool.successRate) failuresForTool += 1;
    }
    if (failuresForTool > 0) {
      failuresByTool[tool.name] = (failuresByTool[tool.name] ?? 0) + failuresForTool;
      failedCalls += failuresForTool;
    }
  }
  return { callsByTool, failuresByTool, totalCalls, failedCalls };
}

const EMPTY_TOOL_USAGE: ToolUsage = { callsByTool: {}, failuresByTool: {}, totalCalls: 0, failedCalls: 0 };

export function generateSessions(seed = 0xc0ffee): readonly StatsSession[] {
  const random = createSeededRandom(seed);
  const anchorMs = Date.parse(`${DEMO_TODAY}T23:59:59.000Z`);
  const sessions: StatsSession[] = [];

  for (let sessionIndex = 0; sessionIndex < GENERATED_SESSION_COUNT; sessionIndex += 1) {
    const project = pickWeighted(random, PROJECTS);
    const model = pickWeighted(random, MODELS);
    const branch = pickWeighted(random, BRANCHES);

    // Recency bias: more sessions in the recent weeks.
    const dayOffset = Math.floor(random() ** 1.7 * GENERATED_SPAN_DAYS);
    const hour = pickActiveHour(random);
    const startedAtMs =
      anchorMs -
      dayOffset * MILLISECONDS_PER_DAY -
      (24 - hour) * MILLISECONDS_PER_HOUR -
      randomInt(random, 0, 3_540_000) * 1000;
    const startedAt = new Date(startedAtMs).toISOString();

    const isBackground = random() < 0.06;
    const intensity = random() ** 1.5; // 0..1 skewed small
    const turns = isBackground ? 1 : randomInt(random, 1, 4) + Math.round(intensity * 22);
    const apiCalls = isBackground ? 1 : turns + randomInt(random, 0, turns);

    // Input dominates (context re-sent each call); output is small.
    const inputPerCall = randomInt(random, 9_000, 22_000) + Math.round(intensity * 30_000);
    const inputTokens = inputPerCall * apiCalls;
    const outputTokens = apiCalls * randomInt(random, 60, 520);
    const thinkingTokens = random() < 0.3 ? apiCalls * randomInt(random, 0, 30) : 0;

    const toolUsage = isBackground ? EMPTY_TOOL_USAGE : buildToolUsage(random, intensity);

    const errorTypes: Record<string, number> = {};
    if (random() < 0.22) {
      const errorType = pickWeighted(random, ERROR_TYPES);
      errorTypes[errorType.type] = randomInt(random, 1, 2);
    }

    const autoAccepted = Math.round(toolUsage.totalCalls * 0.15 * random());
    const rejected = random() < 0.08 ? randomInt(random, 1, 2) : 0;

    const avgLatencyMs = randomInt(random, 4_000, 16_000) + Math.round(intensity * 9_000);
    const maxLatencyMs = avgLatencyMs + randomInt(random, 2_000, 60_000);

    sessions.push({
      sessionId: `session-${(sessionIndex + 1).toString().padStart(3, "0")}-${Math.floor(random() * 1e6).toString(36)}`,
      projectId: project.projectId,
      projectLabel: project.label,
      projectPath: project.path,
      projectKind: project.kind,
      branch: branch.name,
      model: model.modelId,
      startedAt,
      durationMs: Math.max(turns, 1) * randomInt(random, 25_000, 95_000),
      turns,
      isBackground,
      apiCalls,
      tokens: { input: inputTokens, output: outputTokens, thinking: thinkingTokens, cached: 0 },
      avgLatencyMs,
      maxLatencyMs,
      toolCounts: toolUsage.callsByTool,
      toolFailures: toolUsage.failuresByTool,
      errorTypes,
      autoAccepted,
      rejected,
    });
  }

  return sessions.toSorted((first, second) => second.startedAt.localeCompare(first.startedAt));
}
