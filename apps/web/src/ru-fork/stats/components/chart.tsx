"use client";

/**
 * Chart primitive — the shadcn/basecn `ChartContainer` pattern wrapping Recharts.
 *
 * Series colors come from `ChartConfig` as `var(--chart-N)` (or any token); the
 * container injects them as `--color-<key>` CSS variables so Recharts elements
 * reference `var(--color-<key>)`. Because the source values are theme tokens,
 * every chart recolors automatically across all themes + dark/light with no
 * per-chart color code. Tooltip chrome is our own Tailwind, not Recharts'.
 */

import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "~/lib/utils";

type ChartThemeName = "light" | "dark";
const THEME_NAMES: readonly ChartThemeName[] = ["light", "dark"];
const THEME_SELECTOR_PREFIX: Record<ChartThemeName, string> = { light: "", dark: ".dark" };

export interface ChartSeriesConfig {
  readonly label?: React.ReactNode;
  readonly icon?: React.ComponentType;
  readonly color?: string;
  readonly theme?: Record<ChartThemeName, string>;
}

export type ChartConfig = Record<string, ChartSeriesConfig>;

interface ChartContextValue {
  readonly config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

export function useChart(): ChartContextValue {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

interface ChartContainerProps extends React.ComponentProps<"div"> {
  readonly config: ChartConfig;
  readonly children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}

function ChartContainer({ id, className, children, config, ...divProps }: ChartContainerProps) {
  const generatedId = React.useId();
  const chartId = `chart-${id ?? generatedId.replace(/:/g, "")}`;
  const contextValue = React.useMemo(() => ({ config }), [config]);

  return (
    <ChartContext.Provider value={contextValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs",
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground",
          "[&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50",
          "[&_.recharts-curve.recharts-tooltip-cursor]:stroke-border",
          "[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/60",
          "[&_.recharts-dot[stroke='#fff']]:stroke-transparent",
          "[&_.recharts-layer]:outline-none",
          "[&_.recharts-sector]:outline-none [&_.recharts-sector[stroke='#fff']]:stroke-transparent",
          "[&_.recharts-surface]:outline-none",
          className,
        )}
        {...divProps}
      >
        <ChartStyle chartId={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function colorForSeries(seriesConfig: ChartSeriesConfig, themeName: ChartThemeName): string | undefined {
  return seriesConfig.theme?.[themeName] ?? seriesConfig.color;
}

function ChartStyle({ chartId, config }: { chartId: string; config: ChartConfig }) {
  const colorizedSeries = Object.entries(config).filter(
    ([, seriesConfig]) => seriesConfig.color !== undefined || seriesConfig.theme !== undefined,
  );
  if (colorizedSeries.length === 0) return null;

  const styleText = THEME_NAMES.map((themeName) => {
    const variableLines = colorizedSeries
      .map(([seriesKey, seriesConfig]) => {
        const color = colorForSeries(seriesConfig, themeName);
        return color ? `  --color-${seriesKey}: ${color};` : null;
      })
      .filter((line): line is string => line !== null)
      .join("\n");
    return `${THEME_SELECTOR_PREFIX[themeName]} [data-chart=${chartId}] {\n${variableLines}\n}`;
  }).join("\n");

  return <style dangerouslySetInnerHTML={{ __html: styleText }} />;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

/** The subset of a Recharts tooltip payload row that our chrome reads. */
interface ChartTooltipEntry {
  readonly dataKey?: string | number;
  readonly name?: string | number;
  readonly value?: string | number;
  readonly color?: string;
  readonly payload?: Record<string, string | number>;
}

interface ChartTooltipContentProps {
  readonly active?: boolean;
  readonly payload?: readonly ChartTooltipEntry[];
  readonly className?: string;
  readonly indicator?: "line" | "dot" | "dashed";
  readonly hideLabel?: boolean;
  readonly hideIndicator?: boolean;
  readonly label?: string | number;
  readonly labelClassName?: string;
  readonly labelKey?: string;
  readonly nameKey?: string;
}

function configKeyForEntry(entry: ChartTooltipEntry, fallbackKey: string): string {
  return String(entry.dataKey ?? entry.name ?? fallbackKey);
}

function resolveSeriesName(
  entry: ChartTooltipEntry,
  config: ChartConfig,
  nameKey: string | undefined,
): React.ReactNode {
  if (nameKey && entry.payload) {
    const fromPayload = entry.payload[nameKey];
    if (fromPayload !== undefined) return fromPayload;
  }
  const configKey = configKeyForEntry(entry, "value");
  return config[configKey]?.label ?? entry.name ?? configKey;
}

function resolveSeriesIcon(
  entry: ChartTooltipEntry,
  config: ChartConfig,
  nameKey: string | undefined,
): React.ComponentType | undefined {
  const configKey = nameKey ?? configKeyForEntry(entry, "value");
  return config[configKey]?.icon;
}

function resolveIndicatorColor(entry: ChartTooltipEntry): string | undefined {
  const fillValue = entry.payload?.["fill"];
  const fillColor = typeof fillValue === "string" ? fillValue : undefined;
  return entry.color ?? fillColor;
}

function resolveTooltipLabel(
  payload: readonly ChartTooltipEntry[],
  config: ChartConfig,
  label: string | number | undefined,
  labelKey: string | undefined,
): React.ReactNode {
  const [firstEntry] = payload;
  if (!firstEntry) return null;
  if (typeof label === "string") {
    return config[label]?.label ?? label;
  }
  const configKey = labelKey ?? configKeyForEntry(firstEntry, "value");
  return config[configKey]?.label ?? label ?? null;
}

function formatTooltipValue(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString("ru-RU") : value;
}

function indicatorShapeClass(indicator: "line" | "dot" | "dashed"): string {
  if (indicator === "line") return "h-3 w-1 rounded-[2px]";
  if (indicator === "dashed") return "h-3 w-0 border-[1.5px] border-dashed";
  return "size-2.5 rounded-[2px]";
}

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelClassName,
  labelKey,
  nameKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload || payload.length === 0) return null;

  const labelNode = hideLabel ? null : resolveTooltipLabel(payload, config, label, labelKey);

  return (
    <div
      className={cn(
        "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/60 bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
        className,
      )}
    >
      {labelNode ? <div className={cn("font-medium", labelClassName)}>{labelNode}</div> : null}
      <div className="grid gap-1.5">
        {payload.map((entry, entryIndex) => {
          const seriesName = resolveSeriesName(entry, config, nameKey);
          const indicatorColor = resolveIndicatorColor(entry);
          const SeriesIcon = resolveSeriesIcon(entry, config, nameKey);
          return (
            <div
              key={String(entry.dataKey ?? entry.name ?? entryIndex)}
              className="flex w-full items-center gap-2"
            >
              {SeriesIcon ? (
                <SeriesIcon />
              ) : !hideIndicator && indicatorColor ? (
                <span
                  className={cn("shrink-0", indicatorShapeClass(indicator))}
                  style={{
                    backgroundColor: indicator === "dashed" ? "transparent" : indicatorColor,
                    borderColor: indicatorColor,
                  }}
                />
              ) : null}
              <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                <span className="text-muted-foreground">{seriesName}</span>
                {entry.value !== undefined ? (
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatTooltipValue(entry.value)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartStyle };
