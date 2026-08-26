/**
 * ru-code (agentic-flow wave, P3e): the per-row stop for a BACKGROUND agent.
 *
 * Owner ruling (2026-08-27): "bg-agent CARDS gain a stop icon-button VISIBLE
 * ONLY while that agent is running (bg agents only) → wired to task/cancel; on
 * app crash / acp crash / composer hard stop, bg rows flip status 'aborted' —
 * CARD STAYS, only the button disappears (button rule: bg && running)."
 *
 * So the visibility predicate is the whole component: `isBackgrounded` AND an
 * active status. A foreground subagent has no individually addressable handle
 * upstream (it lives and dies inside the turn), and a settled task's cancel is
 * a typed no-op at qwen — showing the control there would offer an action that
 * cannot mean anything.
 *
 * Visual vocabulary: the composer stop's own palette and glyph
 * (ComposerPrimaryActions.tsx:125-144), square and em-scaled to the title line.
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";

import { threadEnvironment } from "~/state/threads";

/** The ruling's button rule, as one predicate. */
export function canStopAgent(agent: RuntimeSubagent): boolean {
  return agent.isBackgrounded && isActiveSubagentStatus(agent.status);
}

export function AgentStopButton({
  agent,
  environmentId,
  threadId,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  // ru-code (ap-final T2): failure reporting is ON (the default). This used to
  // pass `{ reportFailure: false }`, which — `reportAtomCommandResult`,
  // client-runtime/state/runtime.ts:401-413 — suppressed the ONLY client-side
  // trace a failed stop leaves, so a stop that never happened produced nothing
  // anywhere. The user-facing answer is the reactor's `provider.task.stop.failed`
  // timeline row ("Could not stop the agent", ProviderCommandReactor.ts:1440-1449);
  // this restores the console half rather than adding any new UI.
  const stopTask = useAtomCommand(threadEnvironment.stopTask);
  if (!canStopAgent(agent) || environmentId === null || threadId === null) {
    return null;
  }
  return (
    <button
      type="button"
      // `aria-label` and NO native `title`: t3code(no-native-title-tooltip)
      // bans the native tooltip, and every sibling icon-button on this panel
      // (e.g. "Collapse workflow", AgentsPanel.tsx:481) labels itself the same
      // way rather than opening a Tooltip for a one-word control.
      aria-label="Stop agent"
      // The composer stop's own palette (ComposerPrimaryActions.tsx:129): solid
      // destructive/90, white glyph, full destructive on hover. Square, sized in
      // em against the title's text-sm so a font-size change scales the control
      // with the line it sits on.
      className="flex h-[1.25em] w-[1.25em] shrink-0 cursor-pointer items-center justify-center self-end rounded-[0.25em] bg-destructive/90 text-sm text-white shadow-xs shadow-destructive/24 transition-all duration-150 hover:scale-105 hover:bg-destructive"
      onClick={(event) => {
        // The row itself is a click target (the expander). A stop must not also
        // toggle the unfold.
        event.stopPropagation();
        // Fire-and-forget on purpose: the row does not settle from this call.
        // qwen's cancel mutates the live registry entry and the next poll
        // reports it, so the terminal reaches the row through the one path
        // every other terminal takes.
        void stopTask({ environmentId, input: { threadId, taskId: agent.id } });
      }}
    >
      {/* The composer stop's glyph: a white rounded square, scaled in em. */}
      <svg className="size-[0.6em]" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
}
