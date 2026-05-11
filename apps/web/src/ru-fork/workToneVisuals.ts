/**
 * Visual mapping for work-log entry tones. Extracted from
 * `MessagesTimeline.tsx` so ru-fork-owned tones (currently
 * `"warning"`, added for ACP failure activities like
 * `provider.user-input.respond.failed`) don't bloat the upstream-
 * tracked file. MessagesTimeline imports these helpers and gets a
 * net-negative diff against upstream.
 *
 * To add a new tone: extend the `WorkToneName` union, add a branch
 * in both `workToneIcon` and `workToneClass`. The matching literal
 * has to be added to `WorkLogEntry.tone` in `session-logic.ts`.
 */

import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

export type WorkToneName = "thinking" | "tool" | "info" | "error" | "warning";

export function workToneIcon(tone: WorkToneName): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return { icon: CircleAlertIcon, className: "text-foreground/92" };
  }
  if (tone === "warning") {
    return { icon: AlertTriangleIcon, className: "text-foreground/92" };
  }
  if (tone === "thinking") {
    return { icon: BotIcon, className: "text-foreground/92" };
  }
  if (tone === "info") {
    return { icon: CheckIcon, className: "text-foreground/92" };
  }
  return { icon: ZapIcon, className: "text-foreground/92" };
}

export function workToneClass(tone: WorkToneName): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "warning") return "text-amber-300/60 dark:text-amber-300/60";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}
