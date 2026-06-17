/**
 * ru-fork: Analytics — reliability: latency histogram, error types, approvals.
 *
 * @module ru-fork/stats/components/widgets/ReliabilityCard
 */
import { ShieldCheckIcon } from "lucide-react";
import { Bar, BarChart, Cell, XAxis } from "recharts";

import { cn } from "~/lib/utils";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../chart";
import { formatInt } from "../../model/format";
import type { ApprovalSplit, ErrorStat, LatencyBucket } from "../../model/types";
import { WidgetCard } from "../primitives";

const LATENCY_CONFIG: ChartConfig = { count: { label: "Запросы", color: "var(--color-chart-1)" } };

interface ReliabilityCardProps {
  readonly latency: readonly LatencyBucket[];
  readonly errors: readonly ErrorStat[];
  readonly approvals: ApprovalSplit;
  readonly onExpand: () => void;
}

export function ReliabilityCard({ latency, errors, approvals, onExpand }: ReliabilityCardProps) {
  const totalErrors = errors.reduce((runningTotal, errorStat) => runningTotal + errorStat.count, 0);
  const approvalTotal = approvals.autoAccepted + approvals.rejected + approvals.manual || 1;

  return (
    <WidgetCard title="Надёжность" subtitle="Задержки · ошибки · одобрения" icon={ShieldCheckIcon} onExpand={onExpand}>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        Распределение задержки
      </div>
      <ChartContainer config={LATENCY_CONFIG} className="aspect-auto h-[96px] w-full">
        <BarChart data={[...latency]} margin={{ top: 4 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} tickMargin={6} />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="count" radius={4}>
            {latency.map((bucket, bucketIndex) => (
              <Cell key={bucket.label} fill={`var(--color-chart-${Math.min(5, bucketIndex + 1)})`} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">Ошибки</span>
            <span className="font-mono text-xs tabular-nums text-foreground">{formatInt(totalErrors)}</span>
          </div>
          <ul className="flex flex-col gap-1 text-[11px]">
            {errors.slice(0, 4).map((errorStat) => (
              <li key={errorStat.type} className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full bg-destructive/70" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={errorStat.type}>
                  {errorStat.type}
                </span>
                <span className="font-mono tabular-nums text-foreground">{errorStat.count}</span>
              </li>
            ))}
            {errors.length === 0 ? <li className="text-success-foreground">Ошибок нет 🎉</li> : null}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Одобрения инструментов
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
            <span className="bg-success/70" style={{ width: `${(approvals.autoAccepted / approvalTotal) * 100}%` }} />
            <span className="bg-destructive/70" style={{ width: `${(approvals.rejected / approvalTotal) * 100}%` }} />
            <span className="bg-muted-foreground/30" style={{ width: `${(approvals.manual / approvalTotal) * 100}%` }} />
          </div>
          <ul className="mt-1.5 flex flex-col gap-1 text-[11px]">
            <ApprovalLegendRow colorClass="bg-success/70" label="Авто-приём" value={approvals.autoAccepted} />
            <ApprovalLegendRow colorClass="bg-destructive/70" label="Отклонено" value={approvals.rejected} />
            <ApprovalLegendRow colorClass="bg-muted-foreground/30" label="Без запроса" value={approvals.manual} />
          </ul>
        </div>
      </div>
    </WidgetCard>
  );
}

function ApprovalLegendRow({ colorClass, label, value }: { colorClass: string; label: string; value: number }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-[2px]", colorClass)} />
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{formatInt(value)}</span>
    </li>
  );
}
