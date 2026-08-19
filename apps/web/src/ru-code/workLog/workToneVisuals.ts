/**
 * ru-code: visual mapping for work-log entry tones. Extracted from the inline
 * `workToneIcon` in `MessagesTimeline.tsx` so the ru-code-owned `"warning"`
 * tone (amber, added for respond-failed activities like
 * `provider.approval.respond.failed`) lives outside the upstream-tracked file.
 * MessagesTimeline imports `workToneIcon` and renders the returned `iconName`
 * through its own `WorkEntryIconSvg` registry.
 *
 * To add a new tone: extend `WorkToneName`, add a branch in both helpers, and
 * add the matching literal to `WorkLogEntry.tone` in `session-logic.ts`.
 */

export type WorkToneName = "thinking" | "tool" | "info" | "error" | "warning";

/** Subset of MessagesTimeline's `WorkEntryIconName` reachable from a tone. */
export type WorkToneIconName = "bot" | "check" | "circle-alert" | "triangle-alert" | "zap";

export function workToneIcon(tone: WorkToneName): {
  iconName: WorkToneIconName;
  className: string;
} {
  if (tone === "error") {
    return { iconName: "circle-alert", className: "text-foreground" };
  }
  if (tone === "warning") {
    return { iconName: "triangle-alert", className: "text-amber-600 dark:text-amber-300/90" };
  }
  if (tone === "thinking") {
    return { iconName: "bot", className: "text-foreground" };
  }
  if (tone === "info") {
    return { iconName: "check", className: "text-icon-muted" };
  }
  return { iconName: "zap", className: "text-foreground" };
}

export function workToneClass(tone: WorkToneName): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "warning") return "text-amber-600 dark:text-amber-300/90";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}
