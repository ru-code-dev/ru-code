/**
 * ru-fork: Analytics — UI state (zustand) + the derived-view hook.
 *
 * Holds filters, granularity, the fetched sessions, load status, and which
 * drill-down is open. Numbers are derived by {@link useStatsView} from the
 * server-provided sessions for the current filters. The fetch itself lives in
 * {@link useStatsData}; the ⟳ button bumps `refreshNonce` to force a refresh.
 *
 * @module ru-fork/stats/store
 */
import { useMemo } from "react";
import { create } from "zustand";

import type { StatsSession } from "@t3tools/contracts";

import { buildView } from "./model/selectors";
import type { Granularity, StatsFilters, StatsView } from "./model/types";

export type WidgetId =
  | "usage"
  | "models"
  | "projects"
  | "tools"
  | "reliability"
  | "activity"
  | "branches"
  | "composition";

export type StatsStatus = "idle" | "loading" | "ready" | "error";

export const DEFAULT_FILTERS: StatsFilters = {
  rangeDays: 30,
  projectId: "all",
  model: "all",
  branch: "all",
  includeTemp: false,
  traffic: "turns",
};

interface StatsState {
  readonly filters: StatsFilters;
  readonly granularity: Granularity;
  readonly sessions: ReadonlyArray<StatsSession>;
  readonly status: StatsStatus;
  readonly errorDetail: string | null;
  readonly lastRefreshedAtMs: number;
  readonly refreshNonce: number;
  readonly openWidget: WidgetId | null;
  readonly selectedSessionId: string | null;

  readonly setFilters: (patch: Partial<StatsFilters>) => void;
  readonly resetFilters: () => void;
  readonly setGranularity: (granularity: Granularity) => void;
  readonly setSnapshot: (sessions: ReadonlyArray<StatsSession>, atMs: number) => void;
  readonly setStatus: (status: StatsStatus, errorDetail?: string | null) => void;
  readonly requestRefresh: () => void;
  readonly openWidgetDetail: (widget: WidgetId | null) => void;
  readonly selectSession: (sessionId: string | null) => void;
}

export const useStatsStore = create<StatsState>()((set) => ({
  filters: DEFAULT_FILTERS,
  granularity: "day",
  sessions: [],
  status: "idle",
  errorDetail: null,
  lastRefreshedAtMs: 0,
  refreshNonce: 0,
  openWidget: null,
  selectedSessionId: null,

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  setGranularity: (granularity) => set({ granularity }),
  // Replace the session set + clear any prior error. Used by both the instant read
  // and a successful refresh.
  setSnapshot: (sessions, atMs) =>
    set({ sessions, status: "ready", errorDetail: null, lastRefreshedAtMs: atMs }),
  // Status-only update — never touches `sessions`, so a failed refresh keeps the
  // last good data on screen (just flips status to "error" + a note).
  setStatus: (status, errorDetail = null) => set({ status, errorDetail }),
  // ⟳ button: bump the nonce so useStatsData runs a forced refresh.
  requestRefresh: () => set((state) => ({ refreshNonce: state.refreshNonce + 1, status: "loading" })),
  openWidgetDetail: (openWidget) => set({ openWidget }),
  selectSession: (selectedSessionId) => set({ selectedSessionId }),
}));

/** Derived dashboard view for the active filters + fetched sessions. */
export function useStatsView(): StatsView {
  const filters = useStatsStore((state) => state.filters);
  const granularity = useStatsStore((state) => state.granularity);
  const sessions = useStatsStore((state) => state.sessions);
  const lastRefreshedAtMs = useStatsStore((state) => state.lastRefreshedAtMs);
  return useMemo(() => {
    const anchorMs = lastRefreshedAtMs > 0 ? lastRefreshedAtMs : Date.now();
    return buildView(sessions, filters, granularity, anchorMs);
  }, [sessions, filters, granularity, lastRefreshedAtMs]);
}

export function findSessionById(view: StatsView, sessionId: string | null): StatsSession | null {
  if (!sessionId) return null;
  return view.sessions.find((session) => session.sessionId === sessionId) ?? null;
}
