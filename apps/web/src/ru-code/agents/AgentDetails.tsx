/**
 * ru-code (sub-agents): the expanded body of one agent row.
 *
 * Everything here is data the fold already computes and nothing rendered it:
 * the full terminal text (the row truncates at 180 chars), the 6-entry
 * `recentActivity` ring (zero consumers before this file), and the five usage
 * stats the row drops. It lives in the zone and is imported into the panel
 * through one marked seam, so the upstream `AgentRow` — and its `h-[3.875rem]`
 * height invariant — is untouched.
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";

import { L } from "@ru-code/localization";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  buildAgentDetailsModel,
  hasAgentDetails,
  type AgentUsageStatKey,
} from "./agentDetails.logic";

// ru-code: MODULE-LEVEL constant map ⇒ inline `L()` pairs, per the
// CHAT_VIEW_MODE_LABELS precedent (SettingsPanels.tsx:204-207). «Ввод» and
// «Рассуждение» reuse the wording already paired for the same words in
// Sidebar.tsx / CodexAdapter.ts rather than inventing a second vocabulary.
const USAGE_STAT_LABELS: Record<AgentUsageStatKey, string> = {
  input: L("Input", "Ввод"),
  cached: L("Cached", "Из кэша"),
  output: L("Output", "Вывод"),
  reasoning: L("Reasoning", "Рассуждение"),
  toolCalls: L("Tool calls", "Вызовы инструментов"),
  duration: L("Duration", "Длительность"),
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5 first:mt-0">
      <div className="text-[.6rem] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
      {children}
    </div>
  );
}

export function agentHasDetails(agent: RuntimeSubagent): boolean {
  return hasAgentDetails(buildAgentDetailsModel(agent, formatSubagentTokenCount));
}

export function AgentDetails({ agent }: { agent: RuntimeSubagent }) {
  const model = buildAgentDetailsModel(agent, formatSubagentTokenCount);
  return (
    <div
      data-testid="agent-details"
      className="mb-1 ml-3.5 mr-1.5 rounded-md border border-border/60 bg-background/50 px-2 py-1.5"
    >
      {model.error ? (
        <Section title="Error">
          {/* ru-code (livejitter): line-clamp-3 keeps a long error readable
              instead of pushing the roster around; the repo's Tooltip (not a
              native `title`, per t3code(no-native-title-tooltip)) — same
              pattern as ThreadErrorBanner.tsx — surfaces the full text. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-destructive-foreground" />
              }
            >
              {model.error}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {model.error}
            </TooltipPopup>
          </Tooltip>
        </Section>
      ) : null}
      {model.result ? (
        <Section title="Result">
          {/* The row shows 180 chars; the full report is usually longer still —
              this remains the expanded result, as today, now bounded to 3
              wrapped lines (line-clamp-3) instead of a taller scroll box, so
              it reads consistently with every other expander text. The full
              text stays in the DOM (untruncated node) and in the Tooltip
              popup on hover/focus. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/90" />
              }
            >
              {model.result}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {model.result}
            </TooltipPopup>
          </Tooltip>
        </Section>
      ) : null}
      {model.activity.length > 0 ? (
        <Section title="Recent activity">
          <ol className="mt-0.5 flex flex-col gap-0.5">
            {model.activity.map((entry, index) => (
              // ru-code (livejitter): line-clamp-3 (was `truncate`, one hard
              // cutoff line) so a live tail's up-to-180-char echo — the
              // newest entry, index 0 — reads across a few wrapped lines
              // instead of an ellipsis after a handful of words. No Tooltip
              // here (dispatch-approved drop): each entry is already capped
              // at 180 chars and 3 wrapped lines comfortably fits that at
              // this font size, and a Tooltip on every row of a list that
              // updates in place while streaming (part 2's replace-not-append)
              // would pop/reposition mid-hover — full text remains in the DOM
              // node regardless (only visually clamped, never string-cut).
              <li
                key={`${entry.at}:${entry.summary}`}
                className={cn(
                  "line-clamp-3 break-words font-mono text-[.7rem]",
                  index === 0 ? "text-foreground/80" : "text-muted-foreground/70",
                )}
              >
                {entry.summary}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {model.stats.length > 0 ? (
        <Section title="Usage">
          <dl className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {model.stats.map((stat) => (
              <div key={stat.key} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-[.7rem] text-muted-foreground">
                  {USAGE_STAT_LABELS[stat.key]}
                </dt>
                <dd className="font-mono text-[.7rem] tabular-nums text-foreground/80">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
      {model.outputFile ? (
        <Section title="Output file">
          <p className="truncate font-mono text-[.7rem] text-muted-foreground">
            {model.outputFile}
          </p>
        </Section>
      ) : null}
      {model.activations !== null ? (
        <p className="mt-1.5 font-mono text-[.65rem] text-muted-foreground/70">
          {`× ${model.activations}`}
        </p>
      ) : null}
    </div>
  );
}
