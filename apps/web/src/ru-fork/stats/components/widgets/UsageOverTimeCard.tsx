/**
 * ru-fork: Analytics — tokens-over-time hero chart (stacked area, day/week).
 *
 * @module ru-fork/stats/components/widgets/UsageOverTimeCard
 */
import { useMemo } from "react";
import { TrendingUpIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../chart";
import { formatDayLabel, formatTokens } from "../../model/format";
import type { Granularity, TimeBucket } from "../../model/types";
import { Segmented, USAGE_CHART_CONFIG, WidgetCard } from "../primitives";

const GRANULARITY_OPTIONS: readonly { value: Granularity; label: string }[] = [
  { value: "day", label: "По дням" },
  { value: "week", label: "По неделям" },
];

const STACKED_SERIES: readonly ("input" | "output" | "thinking")[] = ["input", "output", "thinking"];

interface UsageOverTimeCardProps {
  readonly series: readonly TimeBucket[];
  readonly granularity: Granularity;
  readonly onGranularityChange: (granularity: Granularity) => void;
  readonly onExpand: () => void;
}

export function UsageOverTimeCard({ series, granularity, onGranularityChange, onExpand }: UsageOverTimeCardProps) {
  const chartData = useMemo(
    () => series.map((bucket) => ({ ...bucket, label: formatDayLabel(bucket.bucketKey) })),
    [series],
  );

  return (
    <WidgetCard
      title="Расход токенов во времени"
      subtitle="Ввод · вывод · размышления"
      icon={TrendingUpIcon}
      onExpand={onExpand}
      actions={
        <Segmented value={granularity} options={GRANULARITY_OPTIONS} onChange={onGranularityChange} size="xs" />
      }
      bodyClassName="pt-2"
    >
      <ChartContainer config={USAGE_CHART_CONFIG} className="aspect-auto h-[240px] w-full">
        <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8 }}>
          <defs>
            {STACKED_SERIES.map((seriesKey, seriesIndex) => (
              <linearGradient key={seriesKey} id={`usage-fill-${seriesKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-chart-${seriesIndex + 1})`} stopOpacity={0.5} />
                <stop offset="95%" stopColor={`var(--color-chart-${seriesIndex + 1})`} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} fontSize={11} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={40}
            fontSize={11}
            tickFormatter={(tickValue: number) => formatTokens(tickValue)}
          />
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          {STACKED_SERIES.map((seriesKey, seriesIndex) => (
            <Area
              key={seriesKey}
              dataKey={seriesKey}
              type="monotone"
              stackId="tokens"
              stroke={`var(--color-chart-${seriesIndex + 1})`}
              fill={`url(#usage-fill-${seriesKey})`}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </WidgetCard>
  );
}
