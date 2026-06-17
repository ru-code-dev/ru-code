/**
 * ru-fork: Analytics — refresh cadence control. Manual refresh icon (re-rolls
 * the demo data so it feels live), the "обновлено N назад" stamp, and the
 * update-interval setting (default 30 мин) that also drives an auto-refresh tick.
 *
 * @module ru-fork/stats/components/RefreshControl
 */
import { useEffect, useState } from "react";
import { RefreshCwIcon, TimerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { REFRESH_INTERVAL_OPTIONS, useStatsStore } from "../store";
import { FilterSelect } from "./primitives";

const RELATIVE_TIME_TICK_MS = 15_000;
const REFRESH_SPINNER_MS = 700;
const MILLISECONDS_PER_MINUTE = 60_000;

function useRelativeTime(sinceMs: number): string {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const intervalId = setInterval(() => forceRerender((counter) => counter + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(intervalId);
  }, []);

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (elapsedSeconds < 30) return "только что";
  if (elapsedSeconds < 90) return "минуту назад";
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} мин назад`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  return `${elapsedHours} ч назад`;
}

export function RefreshControl() {
  const isRefreshing = useStatsStore((state) => state.isRefreshing);
  const lastRefreshedAtMs = useStatsStore((state) => state.lastRefreshedAtMs);
  const refreshIntervalMin = useStatsStore((state) => state.refreshIntervalMin);
  const startRefresh = useStatsStore((state) => state.startRefresh);
  const finishRefresh = useStatsStore((state) => state.finishRefresh);
  const setRefreshIntervalMin = useStatsStore((state) => state.setRefreshIntervalMin);
  const relativeTime = useRelativeTime(lastRefreshedAtMs);

  // Resolve the spinner shortly after a refresh starts.
  useEffect(() => {
    if (!isRefreshing) return;
    const timeoutId = setTimeout(() => finishRefresh(), REFRESH_SPINNER_MS);
    return () => clearTimeout(timeoutId);
  }, [isRefreshing, finishRefresh]);

  // Auto-refresh on the configured cadence.
  useEffect(() => {
    const intervalId = setInterval(() => startRefresh(), refreshIntervalMin * MILLISECONDS_PER_MINUTE);
    return () => clearInterval(intervalId);
  }, [refreshIntervalMin, startRefresh]);

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-muted-foreground/70 sm:inline">обновлено {relativeTime}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => startRefresh()}
        disabled={isRefreshing}
        aria-label="Обновить статистику"
      >
        <RefreshCwIcon className={cn(isRefreshing && "animate-spin")} />
        <span className="hidden sm:inline">Обновить</span>
      </Button>
      <FilterSelect
        ariaLabel="Интервал обновления"
        icon={TimerIcon}
        value={String(refreshIntervalMin)}
        onChange={(nextValue) => setRefreshIntervalMin(Number(nextValue))}
        options={REFRESH_INTERVAL_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
      />
    </div>
  );
}
