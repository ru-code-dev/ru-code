/**
 * ru-fork: Analytics — small shared UI atoms (cards, filter select, bar rows,
 * delta chips). Keeps every widget visually consistent and on the theme tokens.
 *
 * @module ru-fork/stats/components/primitives
 */
import type { ComponentType, ReactNode } from "react";
import { Maximize2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { ChartConfig } from "./chart";
import { formatSignedPct } from "../model/format";

/** Series colors come straight from the theme `--chart-*` tokens. */
export const CHART_COLORS: readonly [string, string, string, string, string] = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export const CHART_BACKGROUNDS: readonly [string, string, string, string, string] = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
];

/** Cycle the chart palette by index, always returning a defined token. */
export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}
export function chartBackground(index: number): string {
  return CHART_BACKGROUNDS[index % CHART_BACKGROUNDS.length] ?? CHART_BACKGROUNDS[0];
}

export const USAGE_CHART_CONFIG: ChartConfig = {
  input: { label: "Ввод (контекст)", color: "var(--color-chart-1)" },
  output: { label: "Вывод", color: "var(--color-chart-2)" },
  thinking: { label: "Размышления", color: "var(--color-chart-3)" },
  total: { label: "Всего", color: "var(--color-chart-1)" },
  calls: { label: "Запросы", color: "var(--color-chart-4)" },
};

interface WidgetCardProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly actions?: ReactNode;
  readonly onExpand?: () => void;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children: ReactNode;
}

/** The standard framed widget container with a header + optional expand button. */
export function WidgetCard({
  title,
  subtitle,
  icon: HeaderIcon,
  actions,
  onExpand,
  className,
  bodyClassName,
  children,
}: WidgetCardProps) {
  return (
    <section
      className={cn(
        "group/widget flex h-full flex-col rounded-2xl border border-border bg-card text-card-foreground shadow-xs/5",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        {HeaderIcon ? <HeaderIcon className="size-4 shrink-0 text-muted-foreground/70" /> : null}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold leading-tight text-foreground">{title}</h3>
          {subtitle ? <p className="truncate text-xs text-muted-foreground/70">{subtitle}</p> : null}
        </div>
        {actions}
        {onExpand ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Подробнее"
            className="opacity-0 transition-opacity group-hover/widget:opacity-100 focus-visible:opacity-100"
            onClick={onExpand}
          >
            <Maximize2Icon />
          </Button>
        ) : null}
      </header>
      <div className={cn("flex min-h-0 flex-1 flex-col p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** ▲/▼ percentage chip colored by direction (green up, red down for tokens). */
export function DeltaChip({ value, invert = false }: { value: number; invert?: boolean }) {
  const isPositive = value > 0;
  const isFavorable = invert ? !isPositive : isPositive;
  if (value === 0) return <span className="text-xs text-muted-foreground/60">0%</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        isFavorable ? "bg-success/10 text-success-foreground" : "bg-destructive/10 text-destructive-foreground",
      )}
    >
      {formatSignedPct(value)}
    </span>
  );
}

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface FilterSelectProps {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly ariaLabel: string;
  readonly className?: string;
}

/** Themed dropdown used across the filter bar. */
export function FilterSelect({ value, options, onChange, icon: LeadingIcon, ariaLabel, className }: FilterSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onChange(nextValue);
      }}
      items={[...options]}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className={cn("min-w-0 gap-1.5", className)}>
        {LeadingIcon ? <LeadingIcon className="size-3.5 text-muted-foreground/70" /> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectPopup side="bottom" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

interface BarRowProps {
  readonly label: string;
  readonly value: string;
  readonly fraction: number; // 0..1
  readonly colorClass?: string | undefined;
  readonly hint?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly trailing?: ReactNode;
}

/** A labeled horizontal bar for leaderboards (projects, tools, branches). */
export function BarRow({ label, value, fraction, colorClass = "bg-chart-1", hint, onClick, trailing }: BarRowProps) {
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] text-foreground">{label}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", colorClass)}
          style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%` }}
        />
      </div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground/60">{hint}</p> : null}
      {trailing}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/50"
      >
        {content}
      </button>
    );
  }
  return <div className="px-1.5 py-1">{content}</div>;
}

interface SegmentedProps<OptionValue extends string> {
  readonly value: OptionValue;
  readonly options: readonly { value: OptionValue; label: string }[];
  readonly onChange: (value: OptionValue) => void;
  readonly className?: string;
  readonly size?: "sm" | "xs";
}

/** A compact single-select segmented control (granularity, traffic, …). */
export function Segmented<OptionValue extends string>({
  value,
  options,
  onChange,
  className,
  size = "sm",
}: SegmentedProps<OptionValue>) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md font-medium transition-colors",
              size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
              isActive ? "bg-background text-foreground shadow-xs/5" : "text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
