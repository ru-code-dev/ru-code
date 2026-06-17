/**
 * ru-fork: Analytics — token composition donut (input/output/thinking/cached).
 *
 * @module ru-fork/stats/components/widgets/TokenCompositionCard
 */
import { useMemo } from "react";
import { PieChartIcon } from "lucide-react";
import { Cell, Pie, PieChart } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../chart";
import { formatPct, formatTokens } from "../../model/format";
import type { TokenBreakdown } from "../../model/types";
import { chartColor, WidgetCard } from "../primitives";

const COMPOSITION_CONFIG: ChartConfig = {
  input: { label: "Ввод", color: "var(--color-chart-1)" },
  output: { label: "Вывод", color: "var(--color-chart-2)" },
  thinking: { label: "Размышления", color: "var(--color-chart-3)" },
  cached: { label: "Из кэша", color: "var(--color-chart-5)" },
};

interface TokenCompositionCardProps {
  readonly composition: TokenBreakdown;
  readonly onExpand: () => void;
}

export function TokenCompositionCard({ composition, onExpand }: TokenCompositionCardProps) {
  const visibleTotal = composition.input + composition.output + composition.thinking;
  const slices = useMemo(
    () =>
      [
        { sliceKey: "input", label: "Ввод", value: composition.input },
        { sliceKey: "output", label: "Вывод", value: composition.output },
        { sliceKey: "thinking", label: "Размышления", value: composition.thinking },
      ].filter((slice) => slice.value > 0),
    [composition],
  );

  return (
    <WidgetCard title="Состав токенов" subtitle="Куда уходит контекст" icon={PieChartIcon} onExpand={onExpand}>
      <div className="flex flex-1 items-center gap-3">
        <div className="relative">
          <ChartContainer config={COMPOSITION_CONFIG} className="aspect-square h-[150px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="label" />} />
              <Pie
                data={slices}
                dataKey="value"
                nameKey="label"
                innerRadius={48}
                outerRadius={68}
                strokeWidth={2}
                stroke="var(--color-card)"
              >
                {slices.map((slice, sliceIndex) => (
                  <Cell key={slice.sliceKey} fill={chartColor(sliceIndex)} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-base font-semibold text-foreground">{formatTokens(visibleTotal)}</span>
            <span className="text-[10px] text-muted-foreground">токенов</span>
          </div>
        </div>
        <ul className="flex flex-1 flex-col gap-1.5 text-xs">
          {slices.map((slice, sliceIndex) => (
            <li key={slice.sliceKey} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: chartColor(sliceIndex) }} />
              <span className="flex-1 text-muted-foreground">{slice.label}</span>
              <span className="font-mono tabular-nums text-foreground">{formatTokens(slice.value)}</span>
              <span className="w-10 text-right text-muted-foreground/60">
                {formatPct((slice.value / visibleTotal) * 100, 0)}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-border/60 pt-1.5 text-muted-foreground/60">
            <span className="size-2.5 shrink-0 rounded-[3px] bg-muted" />
            <span className="flex-1">Из кэша</span>
            <span className="font-mono tabular-nums">0</span>
            <span className="w-10 text-right">0%</span>
          </li>
        </ul>
      </div>
    </WidgetCard>
  );
}
