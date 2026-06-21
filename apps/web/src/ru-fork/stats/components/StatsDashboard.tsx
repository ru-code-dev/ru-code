/**
 * ru-fork: Analytics dashboard — the Settings → «Аналитика» panel.
 *
 * Read-only view over the server stats snapshot. Composes the filter bar, KPI
 * strip and the widget grid; every card can expand into a drill-down sheet, and
 * the sessions table opens a per-session sheet. All numbers derive from {@link
 * useStatsView} so a filter change re-renders the whole board consistently;
 * {@link useStatsData} keeps the session set in sync with the server.
 *
 * @module ru-fork/stats/components/StatsDashboard
 */
import { ChartColumnIcon } from "lucide-react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { useStatsStore, useStatsView } from "../store";
import { useStatsData } from "../useStatsData";
import { KpiStrip } from "./KpiStrip";
import { RefreshControl } from "./RefreshControl";
import { SessionDetailSheet } from "./SessionDetailSheet";
import { StatsFilterBar } from "./StatsFilterBar";
import { WidgetDetailSheet } from "./WidgetDetailSheet";
import { ActivityHeatmapCard } from "./widgets/ActivityHeatmapCard";
import { ModelsCard } from "./widgets/ModelsCard";
import { ProjectsCard } from "./widgets/ProjectsCard";
import { ReliabilityCard } from "./widgets/ReliabilityCard";
import { SessionsTableCard } from "./widgets/SessionsTableCard";
import { TokenCompositionCard } from "./widgets/TokenCompositionCard";
import { ToolsCard } from "./widgets/ToolsCard";
import { UsageOverTimeCard } from "./widgets/UsageOverTimeCard";

export function StatsDashboard() {
  useStatsData();
  const view = useStatsView();
  const status = useStatsStore((state) => state.status);
  const errorDetail = useStatsStore((state) => state.errorDetail);
  const granularity = useStatsStore((state) => state.granularity);
  const setGranularity = useStatsStore((state) => state.setGranularity);
  const setFilters = useStatsStore((state) => state.setFilters);
  const openWidgetDetail = useStatsStore((state) => state.openWidgetDetail);
  const selectSession = useStatsStore((state) => state.selectSession);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 p-4 sm:p-5">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <ChartColumnIcon className="size-5 text-chart-1" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Аналитика</h2>
              <p className="text-xs text-muted-foreground/70">Использование CLI по всем проектам</p>
            </div>
          </div>
          <div className="ms-auto">
            <RefreshControl />
          </div>
        </header>

        <StatsFilterBar />
        <KpiStrip kpis={view.kpis} />

        {status === "error" ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
            {errorDetail ?? "Не удалось обновить статистику"}
          </p>
        ) : null}
        {status === "loading" && view.sessions.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground/70">Загрузка статистики…</p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4 xl:grid-cols-6">
          <div className="lg:col-span-4 xl:col-span-4">
            <UsageOverTimeCard
              series={view.series}
              granularity={granularity}
              onGranularityChange={setGranularity}
              onExpand={() => openWidgetDetail("usage")}
            />
          </div>
          <div className="lg:col-span-2 xl:col-span-2">
            <TokenCompositionCard composition={view.composition} onExpand={() => openWidgetDetail("composition")} />
          </div>

          <div className="lg:col-span-2 xl:col-span-2">
            <ModelsCard models={view.byModel} onExpand={() => openWidgetDetail("models")} />
          </div>
          <div className="lg:col-span-2 xl:col-span-2">
            <ProjectsCard
              projects={view.byProject}
              onPick={(projectId) => setFilters({ projectId })}
              onExpand={() => openWidgetDetail("projects")}
            />
          </div>
          <div className="lg:col-span-2 xl:col-span-2">
            <ToolsCard tools={view.tools} onExpand={() => openWidgetDetail("tools")} />
          </div>

          <div className="lg:col-span-2 xl:col-span-3">
            <ReliabilityCard
              latency={view.latency}
              errors={view.errors}
              approvals={view.approvals}
              onExpand={() => openWidgetDetail("reliability")}
            />
          </div>
          <div className="lg:col-span-2 xl:col-span-3">
            <ActivityHeatmapCard heatmap={view.heatmap} onExpand={() => openWidgetDetail("activity")} />
          </div>

          <div className="lg:col-span-4 xl:col-span-6">
            <SessionsTableCard
              sessions={view.sessions}
              onSelect={selectSession}
              onExpand={() => openWidgetDetail("usage")}
            />
          </div>
        </div>
      </div>

      <WidgetDetailSheet view={view} />
      <SessionDetailSheet view={view} />
    </ScrollArea>
  );
}
