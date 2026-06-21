/**
 * ru-fork: Analytics — refresh control. Manual ⟳ icon (forces a server
 * `stats.refresh` via the store nonce) and the "обновлено N назад" stamp. There is
 * no auto-refresh — data loads only on open and on this button.
 *
 * @module ru-fork/stats/components/RefreshControl
 */
import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { useStatsStore } from "../store";

const RELATIVE_TIME_TICK_MS = 15_000;

function useRelativeTime(sinceMs: number): string {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const intervalId = setInterval(() => forceRerender((counter) => counter + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(intervalId);
  }, []);

  if (sinceMs === 0) return "—";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (elapsedSeconds < 30) return "только что";
  if (elapsedSeconds < 90) return "минуту назад";
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} мин назад`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  return `${elapsedHours} ч назад`;
}

export function RefreshControl() {
  const status = useStatsStore((state) => state.status);
  const lastRefreshedAtMs = useStatsStore((state) => state.lastRefreshedAtMs);
  const requestRefresh = useStatsStore((state) => state.requestRefresh);
  const relativeTime = useRelativeTime(lastRefreshedAtMs);
  const isRefreshing = status === "loading";

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-muted-foreground/70 sm:inline">обновлено {relativeTime}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => requestRefresh()}
        disabled={isRefreshing}
        aria-label="Обновить статистику"
      >
        <RefreshCwIcon className={cn(isRefreshing && "animate-spin")} />
        <span className="hidden sm:inline">Обновить</span>
      </Button>
    </div>
  );
}
