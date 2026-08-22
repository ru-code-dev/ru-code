// ru-code: auto-update ui-kit — big state emblem for the status hero.
// Tones follow the app's status token set (success/warning/info/destructive/primary).
import type { ReactNode } from "react";

import { cn } from "../cn";

export type HaloTone = "success" | "primary" | "warning" | "destructive" | "muted";

const TONE_CLASSES: Record<HaloTone, string> = {
  success: "bg-success/10 text-success-foreground dark:bg-success/16",
  primary: "bg-primary/10 text-primary dark:bg-primary/16",
  warning: "bg-warning/10 text-warning-foreground dark:bg-warning/16",
  destructive: "bg-destructive/10 text-destructive-foreground dark:bg-destructive/16",
  muted: "bg-muted text-muted-foreground",
};

export function StatusHalo({
  tone,
  pulse = false,
  className,
  children,
}: {
  tone: HaloTone;
  /** true while something is actively happening (checking / downloading) */
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative grid size-14 shrink-0 place-items-center rounded-2xl transition-colors [&_svg:not([class*='size-'])]:size-7",
        TONE_CLASSES[tone],
        className,
      )}
      data-slot="status-halo"
    >
      {pulse ? (
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-2xl bg-current opacity-8 motion-reduce:animate-none"
        />
      ) : null}
      {children}
    </div>
  );
}
