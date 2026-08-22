// ru-code: auto-update ui-kit — slim determinate progress bar (token-colored).
import { cn } from "../cn";

export function ProgressBar({
  value,
  className,
  indeterminate = false,
}: {
  /** 0..100 */
  value: number;
  className?: string;
  indeterminate?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full border border-border/50 bg-muted",
        className,
      )}
      data-slot="progress-bar"
      role="progressbar"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
          indeterminate && "w-1/3 animate-pulse",
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
