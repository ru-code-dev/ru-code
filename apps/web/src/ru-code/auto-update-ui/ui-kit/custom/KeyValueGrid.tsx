// ru-code: auto-update ui-kit — dt/dd grid for technical facts (dev details, diagnostics).
import type { ReactNode } from "react";

import { cn } from "../cn";

export interface KeyValueEntry {
  key: string;
  value: ReactNode;
  /** render value in monospace (default true — these are technical facts) */
  mono?: boolean;
}

export function KeyValueGrid({
  entries,
  className,
}: {
  entries: KeyValueEntry[];
  className?: string;
}) {
  return (
    <dl
      className={cn("grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-xs", className)}
      data-slot="key-value-grid"
    >
      {entries.map((entry) => (
        <div className="contents" key={entry.key}>
          <dt className="text-muted-foreground">{entry.key}</dt>
          <dd
            className={cn(
              "min-w-0 break-all text-foreground/90",
              entry.mono !== false && "font-mono text-[11.5px] leading-relaxed",
            )}
          >
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
