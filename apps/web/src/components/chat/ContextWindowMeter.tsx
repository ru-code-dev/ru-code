import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  contextUsageColor,
  contextUsageLevel,
  contextUsedPercent,
} from "~/ru-fork/tokens-usage/usage";
import { WARNING_USED_PERCENT } from "~/ru-fork/tokens-usage/constants";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  // ru-fork: selected model's window (tokens); 0 == unknown.
  contextWindowTokens: number;
}) {
  const { usage, contextWindowTokens } = props;
  const hasWindow = contextWindowTokens > 0;
  const windowedModel = { contextWindowTokens };
  const usedPercentageValue = hasWindow ? contextUsedPercent(usage.usedTokens, windowedModel) : null;
  // ru-fork: clamp the DISPLAY to 100 (matches prior behavior). The level is
  // computed from the raw (unclamped) percent, so >100% still reads "danger".
  const displayPercent = usedPercentageValue === null ? null : Math.min(100, usedPercentageValue);
  const maxTokens = hasWindow ? contextWindowTokens : null;
  const level = hasWindow ? contextUsageLevel(usage.usedTokens, windowedModel) : "normal";
  const ringColor = contextUsageColor(level);
  const usedPercentage = formatPercentage(displayPercent);
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentageValue ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {displayPercent !== null
                  ? Math.round(displayPercent)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Контекстное окно
          </div>
          {maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>
                {formatContextWindowTokens(maxTokens)} контекста использовано
              </span>
            </div>
          ) : (
            <div className="text-sm text-foreground">
              использовано токенов: {formatContextWindowTokens(usage.usedTokens)}
            </div>
          )}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Всего обработано: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              токенов
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              Автоматически уплотняет контекст при необходимости.
            </div>
          ) : null}
          {level !== "normal" ? (
            <div className="mt-1 space-y-0.5 border-t border-border/60 pt-1.5 text-xs text-foreground">
              <div>
                {level === "danger"
                  ? "Контекст переполнен."
                  : `Контекст заполнен ≥ ${WARNING_USED_PERCENT}%, снижает качество и скорость ответов.`}
              </div>
              <div>
                Отправьте{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-medium">/compress</code>, чтобы
                уплотнить историю диалога.
              </div>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
