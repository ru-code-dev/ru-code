/**
 * ru-fork: Analytics — the demo dataset + filter-option helpers.
 *
 * `BASE_SESSIONS` is generated once (stable seed). `sessionsForSeed` lets the
 * "refresh" control re-roll a near-identical dataset so the dashboard feels
 * live (numbers nudge, ordering wobbles) without any backend.
 *
 * @module ru-fork/stats/model/fakeData
 */
import { MODELS, PROJECTS } from "./catalog";
import { DEMO_TODAY, generateSessions } from "./generateSessions";
import type { StatsSession } from "./types";

export { DEMO_TODAY };

export const BASE_SESSIONS: readonly StatsSession[] = generateSessions();

/** Re-roll with a different seed (used by the manual refresh to feel live). */
export function sessionsForSeed(seed: number): readonly StatsSession[] {
  return generateSessions(0xc0ffee ^ (seed * 2654435761));
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export const PROJECT_OPTIONS: readonly FilterOption[] = [
  { value: "all", label: "Все проекты" },
  ...PROJECTS.map((project) => ({ value: project.projectId, label: project.label })),
];

export const MODEL_OPTIONS: readonly FilterOption[] = [
  { value: "all", label: "Все модели" },
  ...MODELS.map((model) => ({ value: model.modelId, label: model.label })),
];

export const BRANCH_OPTIONS: readonly FilterOption[] = [
  { value: "all", label: "Все ветки" },
  ...Array.from(new Set(BASE_SESSIONS.map((session) => session.branch))).map((branch) => ({
    value: branch,
    label: branch,
  })),
];

export interface RangeOption {
  readonly value: number;
  readonly label: string;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  { value: 7, label: "7 дней" },
  { value: 14, label: "14 дней" },
  { value: 30, label: "30 дней" },
  { value: 48, label: "Всё время" },
];
