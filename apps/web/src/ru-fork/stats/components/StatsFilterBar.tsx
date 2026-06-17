/**
 * ru-fork: Analytics — the global filter bar. Every control writes to the store;
 * the whole dashboard recomputes from the narrowed session set.
 *
 * @module ru-fork/stats/components/StatsFilterBar
 */
import { BotIcon, CalendarRangeIcon, FolderIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { BRANCH_OPTIONS, MODEL_OPTIONS, PROJECT_OPTIONS, RANGE_OPTIONS } from "../model/fakeData";
import type { RangeDays, StatsFilters, TrafficFilter } from "../model/types";
import { useStatsStore } from "../store";
import { FilterSelect, Segmented } from "./primitives";

const TRAFFIC_OPTIONS: readonly { value: TrafficFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "turns", label: "Диалог" },
  { value: "background", label: "Фон" },
];

const DEFAULT_FILTERS: StatsFilters = {
  rangeDays: 30,
  projectId: "all",
  model: "all",
  branch: "all",
  includeTemp: false,
  traffic: "all",
};

function parseRangeDays(raw: string): RangeDays {
  const parsed = Number(raw);
  if (parsed === 7 || parsed === 14 || parsed === 30 || parsed === 48) return parsed;
  return DEFAULT_FILTERS.rangeDays;
}

export function StatsFilterBar() {
  const filters = useStatsStore((state) => state.filters);
  const setFilters = useStatsStore((state) => state.setFilters);
  const resetFilters = useStatsStore((state) => state.resetFilters);

  const hasActiveFilters =
    filters.rangeDays !== DEFAULT_FILTERS.rangeDays ||
    filters.projectId !== DEFAULT_FILTERS.projectId ||
    filters.model !== DEFAULT_FILTERS.model ||
    filters.branch !== DEFAULT_FILTERS.branch ||
    filters.includeTemp !== DEFAULT_FILTERS.includeTemp ||
    filters.traffic !== DEFAULT_FILTERS.traffic;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2">
      <FilterSelect
        ariaLabel="Период"
        icon={CalendarRangeIcon}
        value={String(filters.rangeDays)}
        onChange={(nextValue) => setFilters({ rangeDays: parseRangeDays(nextValue) })}
        options={RANGE_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
      />
      <FilterSelect
        ariaLabel="Проект"
        icon={FolderIcon}
        value={filters.projectId}
        onChange={(projectId) => setFilters({ projectId })}
        options={PROJECT_OPTIONS}
      />
      <FilterSelect
        ariaLabel="Модель"
        icon={BotIcon}
        value={filters.model}
        onChange={(model) => setFilters({ model })}
        options={MODEL_OPTIONS}
      />
      <FilterSelect
        ariaLabel="Ветка"
        icon={GitBranchIcon}
        value={filters.branch}
        onChange={(branch) => setFilters({ branch })}
        options={BRANCH_OPTIONS}
      />

      <Segmented value={filters.traffic} options={TRAFFIC_OPTIONS} onChange={(traffic) => setFilters({ traffic })} />

      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
        <Switch checked={filters.includeTemp} onCheckedChange={(includeTemp) => setFilters({ includeTemp })} />
        Песочница
      </label>

      {hasActiveFilters ? (
        <Button size="sm" variant="ghost" className="ms-auto text-muted-foreground" onClick={resetFilters}>
          <RotateCcwIcon />
          Сбросить
        </Button>
      ) : null}
    </div>
  );
}
