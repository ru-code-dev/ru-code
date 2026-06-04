import { cn } from "~/lib/utils";
import type { McpStatus } from "../types";
import { statusVisual } from "../visuals";

/** A coloured status dot, optionally followed by its label. Reads from {@link statusVisual}. */
export function StatusBadge({
  status,
  showLabel = true,
  className,
}: {
  status: McpStatus;
  showLabel?: boolean;
  className?: string;
}) {
  const visual = statusVisual(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          visual.dotClass,
          visual.pulse && "animate-pulse",
        )}
        aria-hidden
      />
      {showLabel && (
        <span className={cn("text-xs font-medium", visual.textClass)}>{visual.label}</span>
      )}
    </span>
  );
}
