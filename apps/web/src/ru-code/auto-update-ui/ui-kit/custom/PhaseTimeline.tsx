// ru-code: the install run's phase timeline — four dots with done / now / todo states.
//
// Restored from the prototype's /updating page (retired in F, when the press moved onto the
// settings hero): a bare progress bar says "something is happening", the timeline says WHAT is
// happening and how much of the sequence is left. The SW-served updating page renders the same
// idea in pure HTML (sw-kit/updatingPage.ts `steps`) — the two must read alike, since the user
// crosses from one to the other mid-update.
//
// Vocabulary is the UI RunPhase (the wire's `flip` is already mapped to `install` by wireToUi);
// `reconnect` / `done` never arrive over the wire, so the strip covers the four real steps.

import { cn } from "../cn";
import type { RunPhase } from "../../model";

const TIMELINE: Array<{ key: RunPhase; label: string }> = [
  { key: "download", label: "Download" },
  { key: "verify", label: "Verify" },
  { key: "install", label: "Install" },
  { key: "restart", label: "Restart" },
];

// ru-code: `active`/`pending`, not `now`/`todo` — the localization compare-guard rejects an
// internal enum whose value collides with a translated display word ("now" → «сейчас»).
type StepTone = "done" | "active" | "pending";

/** Everything before the current phase is done, the current one is live, the rest is pending. */
function stepTone(step: RunPhase, current: RunPhase): StepTone {
  const order = TIMELINE.map((entry) => entry.key);
  const currentIndex = order.indexOf(current);
  const ownIndex = order.indexOf(step);
  if (currentIndex === -1) return "pending";
  if (ownIndex < currentIndex) return "done";
  if (ownIndex === currentIndex) return "active";
  return "pending";
}

export function PhaseTimeline({ phase }: { phase: RunPhase }) {
  return (
    <div
      className="flex w-full items-center justify-between gap-1"
      data-phase={phase}
      data-testid="auto-update-run-timeline"
    >
      {TIMELINE.map((step) => {
        const tone = stepTone(step.key, phase);
        return (
          <div className="flex flex-1 flex-col items-center gap-1.5" key={step.key}>
            <span
              className={cn(
                "size-2.5 rounded-full transition-colors",
                tone === "done" && "bg-success",
                tone === "active" && "bg-primary ring-4 ring-primary/16",
                tone === "pending" && "bg-border",
              )}
              data-state={tone}
            />
            <span
              className={cn(
                "text-[11px] font-medium",
                tone === "pending" ? "text-muted-foreground/60" : "text-foreground/80",
              )}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
