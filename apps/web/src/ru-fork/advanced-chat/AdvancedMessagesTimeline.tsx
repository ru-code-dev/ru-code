// ru-fork: advanced chat mode timeline. Renders the merged transcript flow:
// user bubbles, assistant text (no redundant label) with model/token/latency
// badges, merged tool-step cards (call + result + telemetry), and system
// dividers. Theme-safe semantic tokens; heavy content collapses, nothing clamps.
import type { TranscriptRecord } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { ToolStepCard } from "./ToolStep";
import { TranscriptParts } from "./TranscriptParts";
import { UserBubble } from "./UserBubble";
import { buildTranscriptFlow, type AssistantFlowItem } from "./transcriptFlow";
import type { SystemRecord } from "./transcriptTypes";

const SYSTEM_LABELS: Record<NonNullable<SystemRecord["subtype"]>, string> = {
  chat_compression: "Контекст сжат",
  slash_command: "Slash-команда",
  ui_telemetry: "Телеметрия",
  at_command: "@-команда",
};

function formatLatency(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

function AssistantTurn({ item, cwd }: { item: AssistantFlowItem; cwd: string | undefined }) {
  const { record } = item;
  // function_call parts become tool steps; everything else renders as prose.
  const textParts = record.parts.filter((part) => part.kind !== "function_call");
  const usage = record.usage;
  const latency = formatLatency(item.latencyMs);
  const tokenBadges: Array<[string, number | undefined]> = [
    ["вход", usage?.promptTokens],
    ["кэш", usage?.cachedTokens],
    ["выход", usage?.outputTokens],
    ["Σ", usage?.totalTokens],
  ];

  return (
    <div className="flex flex-col gap-2">
      {textParts.length > 0 ? (
        <div className="px-1">
          <TranscriptParts parts={textParts} cwd={cwd} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 px-1">
        {record.model ? (
          <Badge variant="outline" size="sm" className="font-mono">
            {record.model}
          </Badge>
        ) : null}
        {tokenBadges.map(([label, value]) =>
          value === undefined ? null : (
            <Badge key={label} variant="outline" size="sm" className="font-mono">
              {label} {value}
            </Badge>
          ),
        )}
        {latency ? (
          <Badge variant="outline" size="sm" className="font-mono">
            {latency}
          </Badge>
        ) : null}
      </div>
      {item.tools.map((step) => (
        <ToolStepCard key={step.key} step={step} cwd={cwd} />
      ))}
    </div>
  );
}

function SystemDivider({ record }: { record: SystemRecord }) {
  const label = record.subtype ? SYSTEM_LABELS[record.subtype] : "Системное событие";
  const date = new Date(record.timestamp);
  const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <InfoIcon className="size-3.5" />
      <span className="font-medium">{label}</span>
      {time ? (
        <span className="font-mono text-[0.7rem]" title={record.timestamp}>
          {time}
        </span>
      ) : null}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function AdvancedMessagesTimeline({
  records,
  markdownCwd,
}: {
  records: ReadonlyArray<TranscriptRecord>;
  markdownCwd: string | undefined;
}) {
  if (records.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Пока нет записей в стенограмме CLI для этого диалога.
      </div>
    );
  }
  const flow = buildTranscriptFlow(records);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-4 sm:px-5">
        {flow.map((item) => {
          switch (item.kind) {
            case "user":
              return <UserBubble key={item.record.uuid} record={item.record} cwd={markdownCwd} />;
            case "assistant":
              return <AssistantTurn key={item.record.uuid} item={item} cwd={markdownCwd} />;
            case "system":
              return <SystemDivider key={item.record.uuid} record={item.record} />;
          }
        })}
      </div>
    </div>
  );
}
