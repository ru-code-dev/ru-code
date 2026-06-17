/**
 * ru-fork: Analytics — the top KPI strip (headline numbers + trend chips).
 *
 * @module ru-fork/stats/components/KpiStrip
 */
import type { ComponentType } from "react";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CoinsIcon,
  FolderGitIcon,
  GaugeIcon,
  MessagesSquareIcon,
  WrenchIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { formatDuration, formatInt, formatPct, formatTokens } from "../model/format";
import type { KpiSet } from "../model/types";
import { DeltaChip } from "./primitives";

interface Tile {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly delta?: number;
  readonly deltaInvert?: boolean;
  readonly accent?: string;
}

export function KpiStrip({ kpis }: { kpis: KpiSet }) {
  const tiles: readonly Tile[] = [
    { icon: CoinsIcon, label: "Всего токенов", value: formatTokens(kpis.totalTokens), sub: `${formatTokens(kpis.inputTokens)} ввод`, delta: kpis.tokensDeltaPct, accent: "text-chart-1" },
    { icon: ActivityIcon, label: "Запросов API", value: formatInt(kpis.apiCalls), sub: `${formatTokens(kpis.outputTokens)} вывод` },
    { icon: WrenchIcon, label: "Вызовов инструментов", value: formatInt(kpis.toolCalls) },
    { icon: MessagesSquareIcon, label: "Сессий", value: formatInt(kpis.sessions) },
    { icon: FolderGitIcon, label: "Проектов", value: formatInt(kpis.projects) },
    { icon: AlertTriangleIcon, label: "Ошибок", value: formatInt(kpis.errors), sub: formatPct(kpis.errorRatePct) + " ошибок" },
    { icon: GaugeIcon, label: "Ср. задержка", value: formatDuration(kpis.avgLatencyMs) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {tiles.map((tile) => {
        const Icon = tile.icon;
        return (
          <div
            key={tile.label}
            className="flex flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs/5"
          >
            <div className="flex items-center gap-1.5">
              <Icon className={cn("size-3.5", tile.accent ?? "text-muted-foreground/60")} />
              <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {tile.label}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{tile.value}</span>
              {tile.delta !== undefined ? <DeltaChip value={tile.delta} invert={tile.deltaInvert ?? false} /> : null}
            </div>
            {tile.sub ? <span className="truncate text-[11px] text-muted-foreground/60">{tile.sub}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
