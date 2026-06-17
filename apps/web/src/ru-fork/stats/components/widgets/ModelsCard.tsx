/**
 * ru-fork: Analytics — tokens by model (donut + legend).
 *
 * @module ru-fork/stats/components/widgets/ModelsCard
 */
import { BotIcon } from "lucide-react";
import { Cell, Pie, PieChart } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../chart";
import { formatInt, formatPct, formatTokens } from "../../model/format";
import type { NamedTokenSlice } from "../../model/types";
import { chartColor, WidgetCard } from "../primitives";

const MODELS_CONFIG: ChartConfig = { value: { label: "Токены" } };

interface ModelsCardProps {
  readonly models: readonly NamedTokenSlice[];
  readonly onExpand: () => void;
}

export function ModelsCard({ models, onExpand }: ModelsCardProps) {
  const chartData = models.map((model) => ({ modelKey: model.groupKey, label: model.label, value: model.tokens }));
  const totalSessions = models.reduce((runningTotal, model) => runningTotal + model.sessions, 0);

  return (
    <WidgetCard title="Модели" subtitle={`${models.length} в использовании`} icon={BotIcon} onExpand={onExpand}>
      <div className="flex flex-1 items-center gap-3">
        <ChartContainer config={MODELS_CONFIG} className="aspect-square h-[150px]">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="label" />} />
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="label"
              innerRadius={42}
              outerRadius={68}
              paddingAngle={2}
              strokeWidth={2}
              stroke="var(--color-card)"
            >
              {chartData.map((datum, datumIndex) => (
                <Cell key={datum.modelKey} fill={chartColor(datumIndex)} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="flex flex-1 flex-col gap-2 text-xs">
          {models.map((model, modelIndex) => (
            <li key={model.groupKey} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: chartColor(modelIndex) }} />
              <span className="min-w-0 flex-1 truncate text-foreground">{model.label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{formatTokens(model.tokens)}</span>
              <span className="w-9 text-right text-muted-foreground/60">{formatPct(model.sharePct, 0)}</span>
            </li>
          ))}
          {models.length === 0 ? <li className="text-muted-foreground/60">Нет данных</li> : null}
        </ul>
      </div>
      <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground/60">
        {formatInt(totalSessions)} сессий · окно контекста до 128K
      </p>
    </WidgetCard>
  );
}
