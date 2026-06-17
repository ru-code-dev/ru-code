/**
 * ru-fork: Analytics — UI state (zustand) + the derived-view hook.
 *
 * Holds filters, chart granularity, the refresh cadence setting, and which
 * drill-down (widget detail / session) is open. The actual numbers are derived
 * by {@link useStatsView} from the fake session set for the current seed —
 * "refresh" just bumps the seed + stamps a time, so it feels live, 0 server.
 *
 * @module ru-fork/stats/store
 */
import { useMemo } from "react";
import { create } from "zustand";

import { BASE_SESSIONS, sessionsForSeed } from "./model/fakeData";
import { buildView } from "./model/selectors";
import type { Granularity, StatsFilters, StatsSession, StatsView } from "./model/types";

/** Which expandable widget detail panel is open. */
export type WidgetId =
  | "usage"
  | "models"
  | "projects"
  | "tools"
  | "reliability"
  | "activity"
  | "branches"
  | "composition";

export interface RefreshIntervalOption {
  readonly value: number;
  readonly label: string;
}

export const REFRESH_INTERVAL_OPTIONS: readonly RefreshIntervalOption[] = [
  { value: 5, label: "5 минут" },
  { value: 15, label: "15 минут" },
  { value: 30, label: "30 минут" },
  { value: 60, label: "1 час" },
  { value: 360, label: "6 часов" },
];

const DEFAULT_FILTERS: StatsFilters = {
  rangeDays: 30,
  projectId: "all",
  model: "all",
  branch: "all",
  includeTemp: false,
  traffic: "all",
};

interface StatsState {
  readonly filters: StatsFilters;
  readonly granularity: Granularity;
  readonly refreshIntervalMin: number;
  readonly seed: number;
  readonly lastRefreshedAtMs: number;
  readonly isRefreshing: boolean;
  readonly openWidget: WidgetId | null;
  readonly selectedSessionId: string | null;

  readonly setFilters: (patch: Partial<StatsFilters>) => void;
  readonly resetFilters: () => void;
  readonly setGranularity: (granularity: Granularity) => void;
  readonly setRefreshIntervalMin: (refreshIntervalMin: number) => void;
  readonly startRefresh: () => void;
  readonly finishRefresh: () => void;
  readonly openWidgetDetail: (widget: WidgetId | null) => void;
  readonly selectSession: (sessionId: string | null) => void;
}

export const useStatsStore = create<StatsState>()((set) => ({
  filters: DEFAULT_FILTERS,
  granularity: "day",
  refreshIntervalMin: 30,
  seed: 0,
  lastRefreshedAtMs: Date.now(),
  isRefreshing: false,
  openWidget: null,
  selectedSessionId: null,

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  setGranularity: (granularity) => set({ granularity }),
  setRefreshIntervalMin: (refreshIntervalMin) => set({ refreshIntervalMin }),
  startRefresh: () => set({ isRefreshing: true }),
  finishRefresh: () =>
    set((state) => ({ isRefreshing: false, seed: state.seed + 1, lastRefreshedAtMs: Date.now() })),
  openWidgetDetail: (openWidget) => set({ openWidget }),
  selectSession: (selectedSessionId) => set({ selectedSessionId }),
}));

/** Derived dashboard view for the active filters/seed. Memoized per input. */
export function useStatsView(): StatsView {
  const filters = useStatsStore((state) => state.filters);
  const granularity = useStatsStore((state) => state.granularity);
  const seed = useStatsStore((state) => state.seed);
  return useMemo(() => {
    const sessions = seed === 0 ? BASE_SESSIONS : sessionsForSeed(seed);
    return buildView(sessions, filters, granularity);
  }, [filters, granularity, seed]);
}

export function findSessionById(view: StatsView, sessionId: string | null): StatsSession | null {
  if (!sessionId) return null;
  return view.sessions.find((session) => session.sessionId === sessionId) ?? null;
}
