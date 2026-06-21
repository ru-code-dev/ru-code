/**
 * ru-fork: Analytics — the global filter bar. Every control writes to the store;
 * the whole dashboard recomputes from the narrowed session set.
 *
 * @module ru-fork/stats/components/StatsFilterBar
 */
import { useMemo } from "react";
import { BotIcon, CalendarRangeIcon, FolderIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { RANGE_OPTIONS, branchOptions, modelOptions, projectOptions } from "../model/filterOptions";
import { filterSessions } from "../model/selectors";
import type { RangeDays, TrafficFilter } from "../model/types";
import { DEFAULT_FILTERS, useStatsStore } from "../store";
import { FilterSelect, Segmented } from "./primitives";

const TRAFFIC_OPTIONS: readonly { value: TrafficFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "turns", label: "Диалог" },
  { value: "background", label: "Фон" },
];

function parseRangeDays(raw: string): RangeDays {
  if (raw === "all") return "all";
  const parsed = Number(raw);
  if (parsed === 1 || parsed === 7 || parsed === 14 || parsed === 30) return parsed;
  return DEFAULT_FILTERS.rangeDays;
}

export function StatsFilterBar() {
  const filters = useStatsStore((state) => state.filters);
  const setFilters = useStatsStore((state) => state.setFilters);
  const resetFilters = useStatsStore((state) => state.resetFilters);
  const sessions = useStatsStore((state) => state.sessions);
  const lastRefreshedAtMs = useStatsStore((state) => state.lastRefreshedAtMs);

  // Faceted options: each dropdown lists only values present once the OTHER active
  // filters are applied (its own dimension neutralized to "all"), anchored to the
  // same time the dashboard uses.
  const anchorMs = lastRefreshedAtMs > 0 ? lastRefreshedAtMs : Date.now();
  const projectChoices = useMemo(
    () =>
      projectOptions(
        filterSessions(sessions, { ...filters, projectId: "all" }, anchorMs),
        sessions,
        filters.projectId,
      ),
    [sessions, filters, anchorMs],
  );
  const modelChoices = useMemo(
    () => modelOptions(filterSessions(sessions, { ...filters, model: "all" }, anchorMs), filters.model),
    [sessions, filters, anchorMs],
  );
  const branchChoices = useMemo(
    () => branchOptions(filterSessions(sessions, { ...filters, branch: "all" }, anchorMs), filters.branch),
    [sessions, filters, anchorMs],
  );

  const hasActiveFilters =
    filters.rangeDays !== DEFAULT_FILTERS.rangeDays ||
    filters.projectId !== DEFAULT_FILTERS.projectId ||
    filters.model !== DEFAULT_FILTERS.model ||
    filters.branch !== DEFAULT_FILTERS.branch ||
    filters.includeTemp !== DEFAULT_FILTERS.includeTemp ||
    filters.traffic !== DEFAULT_FILTERS.traffic;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <FilterSelect
          ariaLabel="Период"
          icon={CalendarRangeIcon}
          className="w-full"
          value={String(filters.rangeDays)}
          onChange={(nextValue) => setFilters({ rangeDays: parseRangeDays(nextValue) })}
          options={RANGE_OPTIONS}
        />
        <FilterSelect
          ariaLabel="Проект"
          icon={FolderIcon}
          className="w-full"
          value={filters.projectId}
          onChange={(projectId) => setFilters({ projectId })}
          options={projectChoices}
        />
        <FilterSelect
          ariaLabel="Модель"
          icon={BotIcon}
          className="w-full"
          value={filters.model}
          onChange={(model) => setFilters({ model })}
          options={modelChoices}
        />
        <FilterSelect
          ariaLabel="Ветка"
          icon={GitBranchIcon}
          className="w-full"
          value={filters.branch}
          onChange={(branch) => setFilters({ branch })}
          options={branchChoices}
        />

        <Segmented
          value={filters.traffic}
          options={TRAFFIC_OPTIONS}
          onChange={(traffic) => setFilters({ traffic })}
          className="w-full [&>button]:flex-1"
        />

        <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
          <Switch checked={filters.includeTemp} onCheckedChange={(includeTemp) => setFilters({ includeTemp })} />
          Песочница
        </label>
      </div>

      {hasActiveFilters ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={resetFilters}>
            <RotateCcwIcon />
            Сбросить
          </Button>
        </div>
      ) : null}
    </div>
  );
}
