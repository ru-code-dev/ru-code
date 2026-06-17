/**
 * ru-fork: Analytics — widget drill-down. Each dashboard card's expand button
 * opens this sheet with the full, un-truncated breakdown for that metric.
 *
 * @module ru-fork/stats/components/WidgetDetailSheet
 */
import type { ReactNode } from "react";

import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { TOOL_GROUP_LABEL } from "../model/catalog";
import { formatDayLabel, formatInt, formatPct, formatTokens, WEEKDAY_LABELS } from "../model/format";
import type { NamedTokenSlice, StatsView, ToolGroup, ToolStat } from "../model/types";
import { useStatsStore, type WidgetId } from "../store";
import { BarRow, chartBackground } from "./primitives";

interface WidgetMeta {
  readonly title: string;
  readonly description: string;
}

const WIDGET_META: Record<WidgetId, WidgetMeta> = {
  usage: { title: "Расход токенов", description: "Полная разбивка по периодам" },
  composition: { title: "Состав токенов", description: "Ввод, вывод, размышления, кэш" },
  models: { title: "Модели", description: "Расход и сессии по моделям" },
  projects: { title: "Проекты", description: "Все проекты за период, включая ветки" },
  branches: { title: "Ветки", description: "Расход по git-веткам" },
  tools: { title: "Инструменты", description: "Вызовы и успешность по категориям" },
  reliability: { title: "Надёжность", description: "Задержки, ошибки и одобрения" },
  activity: { title: "Активность", description: "Распределение по дням и часам" },
};

export function WidgetDetailSheet({ view }: { view: StatsView }) {
  const openWidget = useStatsStore((state) => state.openWidget);
  const closeWidget = useStatsStore((state) => state.openWidgetDetail);
  const meta = openWidget ? WIDGET_META[openWidget] : null;

  return (
    <Sheet open={openWidget !== null} onOpenChange={(isOpen) => !isOpen && closeWidget(null)}>
      <SheetPopup side="right" className="max-w-xl">
        {meta && openWidget ? (
          <>
            <SheetHeader>
              <SheetTitle>{meta.title}</SheetTitle>
              <SheetDescription>{meta.description}</SheetDescription>
            </SheetHeader>
            <SheetPanel className="flex flex-col gap-4">{renderWidgetBody(openWidget, view)}</SheetPanel>
          </>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}

function renderWidgetBody(widget: WidgetId, view: StatsView): ReactNode {
  switch (widget) {
    case "usage":
    case "composition":
      return <UsageDetail view={view} />;
    case "models":
      return <SliceTable rows={view.byModel} unitLabel="модель" />;
    case "projects":
      return (
        <>
          <DetailSection title="Проекты">
            <SliceBars rows={view.byProject} />
          </DetailSection>
          <DetailSection title="Ветки">
            <SliceBars rows={view.byBranch} />
          </DetailSection>
        </>
      );
    case "branches":
      return <SliceBars rows={view.byBranch} />;
    case "tools":
      return <ToolsDetail view={view} />;
    case "reliability":
      return <ReliabilityDetail view={view} />;
    case "activity":
      return <ActivityDetail view={view} />;
    default:
      return null;
  }
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">{title}</h4>
      {children}
    </section>
  );
}

function UsageDetail({ view }: { view: StatsView }) {
  const { kpis } = view;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <DetailStat label="Всего" value={formatTokens(kpis.totalTokens)} />
        <DetailStat label="Ввод" value={formatTokens(kpis.inputTokens)} />
        <DetailStat label="Вывод" value={formatTokens(kpis.outputTokens)} />
        <DetailStat label="Размышления" value={formatTokens(kpis.thinkingTokens)} />
      </div>
      <DetailSection title="По периодам">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] uppercase text-muted-foreground/60">
            <tr className="border-b border-border/60">
              <th className="py-1.5 font-medium">Период</th>
              <th className="py-1.5 text-right font-medium">Ввод</th>
              <th className="py-1.5 text-right font-medium">Вывод</th>
              <th className="py-1.5 text-right font-medium">Всего</th>
              <th className="py-1.5 text-right font-medium">Запросы</th>
            </tr>
          </thead>
          <tbody>
            {view.series.map((bucket) => (
              <tr key={bucket.bucketKey} className="border-b border-border/30">
                <td className="py-1.5 text-muted-foreground">{formatDayLabel(bucket.bucketKey)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{formatTokens(bucket.input)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{formatTokens(bucket.output)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-foreground">{formatTokens(bucket.total)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{bucket.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DetailSection>
    </>
  );
}

function SliceBars({ rows }: { rows: readonly NamedTokenSlice[] }) {
  const maxTokens = rows[0]?.tokens ?? 1;
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((slice, sliceIndex) => (
        <BarRow
          key={slice.groupKey}
          label={slice.label}
          value={formatTokens(slice.tokens)}
          fraction={slice.tokens / maxTokens}
          colorClass={slice.kind === "temp" ? "bg-muted-foreground/40" : chartBackground(sliceIndex)}
          hint={`${formatInt(slice.sessions)} сессий · ${formatPct(slice.sharePct, 0)}`}
        />
      ))}
    </div>
  );
}

function SliceTable({ rows, unitLabel }: { rows: readonly NamedTokenSlice[]; unitLabel: string }) {
  const grandTotal = rows.reduce((runningTotal, slice) => runningTotal + slice.tokens, 0);
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[11px] uppercase text-muted-foreground/60">
        <tr className="border-b border-border/60">
          <th className="py-1.5 font-medium">{unitLabel}</th>
          <th className="py-1.5 text-right font-medium">Токены</th>
          <th className="py-1.5 text-right font-medium">Сессии</th>
          <th className="py-1.5 text-right font-medium">Доля</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((slice) => (
          <tr key={slice.groupKey} className="border-b border-border/30">
            <td className="py-1.5 text-foreground">{slice.label}</td>
            <td className="py-1.5 text-right font-mono tabular-nums">{formatTokens(slice.tokens)}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{formatInt(slice.sessions)}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{formatPct(slice.sharePct, 0)}</td>
          </tr>
        ))}
        <tr className="font-medium text-foreground">
          <td className="py-1.5">Итого</td>
          <td className="py-1.5 text-right font-mono tabular-nums">{formatTokens(grandTotal)}</td>
          <td />
          <td className="py-1.5 text-right font-mono tabular-nums">100%</td>
        </tr>
      </tbody>
    </table>
  );
}

function ToolsDetail({ view }: { view: StatsView }) {
  const toolsByGroup = new Map<ToolGroup, ToolStat[]>();
  for (const tool of view.tools) {
    const groupTools = toolsByGroup.get(tool.group) ?? [];
    groupTools.push(tool);
    toolsByGroup.set(tool.group, groupTools);
  }
  const maxCalls = view.tools[0]?.calls ?? 1;
  return (
    <>
      {Array.from(toolsByGroup.entries()).map(([group, groupTools]) => (
        <DetailSection key={group} title={TOOL_GROUP_LABEL[group]}>
          <div className="flex flex-col gap-0.5">
            {groupTools.map((tool) => (
              <BarRow
                key={tool.name}
                label={tool.name}
                value={formatInt(tool.calls)}
                fraction={tool.calls / maxCalls}
                hint={`${formatPct(tool.successPct, 0)} успешно${tool.failures ? ` · ${tool.failures} ошибок` : ""}`}
              />
            ))}
          </div>
        </DetailSection>
      ))}
    </>
  );
}

function ReliabilityDetail({ view }: { view: StatsView }) {
  const maxLatencyCount = Math.max(...view.latency.map((bucket) => bucket.count), 1);
  return (
    <>
      <DetailSection title="Задержка запросов">
        <div className="flex flex-col gap-0.5">
          {view.latency.map((bucket, bucketIndex) => (
            <BarRow
              key={bucket.label}
              label={bucket.label}
              value={formatInt(bucket.count)}
              fraction={bucket.count / maxLatencyCount}
              colorClass={chartBackground(bucketIndex)}
            />
          ))}
        </div>
      </DetailSection>
      <DetailSection title="Типы ошибок">
        <table className="w-full text-left text-xs">
          <tbody>
            {view.errors.map((errorStat) => (
              <tr key={errorStat.type} className="border-b border-border/30">
                <td className="py-1.5 text-foreground">{errorStat.type}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{errorStat.count}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{formatPct(errorStat.sharePct, 0)}</td>
              </tr>
            ))}
            {view.errors.length === 0 ? (
              <tr>
                <td className="py-1.5 text-success-foreground">Ошибок за период нет</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </DetailSection>
      <DetailSection title="Одобрения инструментов">
        <div className="grid grid-cols-3 gap-2">
          <DetailStat label="Авто-приём" value={formatInt(view.approvals.autoAccepted)} />
          <DetailStat label="Отклонено" value={formatInt(view.approvals.rejected)} />
          <DetailStat label="Без запроса" value={formatInt(view.approvals.manual)} />
        </div>
      </DetailSection>
    </>
  );
}

function ActivityDetail({ view }: { view: StatsView }) {
  const tokensByWeekday = WEEKDAY_LABELS.map((label, weekdayIndex) => ({
    label,
    tokens: view.heatmap
      .filter((cell) => cell.weekday === weekdayIndex)
      .reduce((runningTotal, cell) => runningTotal + cell.tokens, 0),
  }));
  const maxWeekdayTokens = Math.max(...tokensByWeekday.map((weekday) => weekday.tokens), 1);
  return (
    <DetailSection title="По дням недели">
      <div className="flex flex-col gap-0.5">
        {tokensByWeekday.map((weekday, weekdayIndex) => (
          <BarRow
            key={weekday.label}
            label={weekday.label}
            value={formatTokens(weekday.tokens)}
            fraction={weekday.tokens / maxWeekdayTokens}
            colorClass={chartBackground(weekdayIndex)}
          />
        ))}
      </div>
    </DetailSection>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground/60">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
