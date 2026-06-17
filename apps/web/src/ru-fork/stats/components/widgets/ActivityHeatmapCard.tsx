/**
 * ru-fork: Analytics — activity heatmap (weekday × hour), pure CSS grid colored
 * by token intensity from the `--chart-1` token. No charting library needed.
 *
 * @module ru-fork/stats/components/widgets/ActivityHeatmapCard
 */
import { useMemo } from "react";
import { CalendarClockIcon } from "lucide-react";

import { formatTokens, weekdayLabel, WEEKDAY_LABELS } from "../../model/format";
import type { HeatCell } from "../../model/types";
import { WidgetCard } from "../primitives";

const HOURS_OF_DAY: readonly number[] = Array.from(Array(24).keys());
const WEEKDAYS: readonly number[] = Array.from(Array(7).keys());

function intensityColor(intensity: number): string {
  const mixPercent = Math.round(18 + intensity * 82);
  return `color-mix(in oklab, var(--color-chart-1) ${mixPercent}%, transparent)`;
}

interface ActivityHeatmapCardProps {
  readonly heatmap: readonly HeatCell[];
  readonly onExpand: () => void;
}

export function ActivityHeatmapCard({ heatmap, onExpand }: ActivityHeatmapCardProps) {
  const { cellsByKey, maxTokens, peakCell } = useMemo(() => {
    const lookup = new Map<string, HeatCell>();
    let highestTokens = 0;
    let busiestCell: HeatCell | null = null;
    for (const cell of heatmap) {
      lookup.set(`${cell.weekday}:${cell.hour}`, cell);
      if (cell.tokens > highestTokens) {
        highestTokens = cell.tokens;
        busiestCell = cell;
      }
    }
    return { cellsByKey: lookup, maxTokens: highestTokens || 1, peakCell: busiestCell };
  }, [heatmap]);

  return (
    <WidgetCard
      title="Активность"
      subtitle={peakCell ? `Пик: ${weekdayLabel(peakCell.weekday)} ${peakCell.hour}:00` : "По часам и дням"}
      icon={CalendarClockIcon}
      onExpand={onExpand}
    >
      <div className="flex flex-1 flex-col justify-center">
        <div className="flex gap-1">
          <div className="flex w-6 shrink-0 flex-col justify-between pb-4 pt-0.5 text-[9px] text-muted-foreground/50">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label} className="leading-[10px]">
                {label}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid gap-0.5">
              {WEEKDAYS.map((weekdayIndex) => (
                <div key={weekdayIndex} className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5">
                  {HOURS_OF_DAY.map((hourValue) => {
                    const cell = cellsByKey.get(`${weekdayIndex}:${hourValue}`);
                    const intensity = cell ? cell.tokens / maxTokens : 0;
                    const cellTitle = cell
                      ? `${weekdayLabel(weekdayIndex)} ${hourValue}:00 — ${formatTokens(cell.tokens)} токенов, ${cell.sessions} сессий`
                      : `${weekdayLabel(weekdayIndex)} ${hourValue}:00`;
                    return (
                      <div
                        key={hourValue}
                        title={cellTitle}
                        className="aspect-square rounded-[2px] ring-1 ring-inset ring-border/40"
                        style={{ backgroundColor: intensity > 0 ? intensityColor(intensity) : "var(--color-muted)" }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/40">
              <span>00:00</span>
              <span>06:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>23:00</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground/50">
          <span>меньше</span>
          {[0.1, 0.35, 0.6, 0.85, 1].map((legendIntensity) => (
            <span
              key={legendIntensity}
              className="size-2.5 rounded-[2px]"
              style={{ backgroundColor: intensityColor(legendIntensity) }}
            />
          ))}
          <span>больше</span>
        </div>
      </div>
    </WidgetCard>
  );
}
