/**
 * ru-code (sub-agents): per-agent expander.
 *
 * Upstream's `AgentRow` is documented "Flat, non-interactive. No unfold." and
 * pins its own height (`h-[3.875rem]`). Both stay true here: the collapsed state
 * IS that component, rendered verbatim as `row`, and this wrapper adds only a
 * click target around it plus a body BELOW it. The collapse machinery upstream
 * uses for workflows (AgentsPanel.tsx:378-522) is a pattern, not a component —
 * copied in shape (open state is presentation state, settling never yanks it
 * shut), not imported.
 *
 * The per-row background stop is NOT hosted here any more: it moved into the
 * row's own title line (`AgentRow`'s `stop` slot, AgentsPanel.tsx:174), so this
 * component no longer needs the dispatch ids and no longer takes them.
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AgentDetails, agentHasDetails } from "./AgentDetails";

export function AgentRowExpander({ agent, row }: { agent: RuntimeSubagent; row: ReactNode }) {
  const [open, setOpen] = useState(false);
  // An agent whose whole state is already on the row keeps the flat row: an
  // expander that opens onto nothing is worse than no expander.
  if (!agentHasDetails(agent)) {
    return <>{row}</>;
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  // The stop control now lives INSIDE the row's title line (AgentRow's `stop`
  // slot) — it stopPropagation()s its clicks, so the expander toggle is safe.
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Hide agent details" : "Show agent details"}
        className="group relative block w-full rounded-md text-left hover:bg-accent/40"
      >
        {row}
        {/* Height-neutral by construction: absolutely positioned, so the row's
              three-line grid is unchanged. Revealed on hover or while open, so a
              resting roster looks exactly as it did before. */}
        <Chevron
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-1 right-1 size-3 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100",
            open && "opacity-100",
          )}
        />
      </button>
      {open ? <AgentDetails agent={agent} /> : null}
    </div>
  );
}
