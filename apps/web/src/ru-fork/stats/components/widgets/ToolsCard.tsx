/**
 * ru-fork: Analytics — tool usage (calls + success rate), colored by group.
 *
 * @module ru-fork/stats/components/widgets/ToolsCard
 */
import { WrenchIcon } from "lucide-react";

import { formatInt } from "../../model/format";
import type { ToolGroup, ToolStat } from "../../model/types";
import { BarRow, WidgetCard } from "../primitives";

const GROUP_BACKGROUND: Record<ToolGroup, string> = {
  fs: "bg-chart-1",
  shell: "bg-chart-2",
  search: "bg-chart-3",
  flow: "bg-chart-4",
  agent: "bg-chart-5",
  mcp: "bg-chart-2",
  web: "bg-chart-3",
};

interface ToolsCardProps {
  readonly tools: readonly ToolStat[];
  readonly onExpand: () => void;
}

export function ToolsCard({ tools, onExpand }: ToolsCardProps) {
  const maxCalls = tools[0]?.calls ?? 1;
  const totalCalls = tools.reduce((runningTotal, tool) => runningTotal + tool.calls, 0);

  return (
    <WidgetCard
      title="Инструменты"
      subtitle={`${formatInt(totalCalls)} вызовов`}
      icon={WrenchIcon}
      onExpand={onExpand}
      bodyClassName="gap-0.5"
    >
      {tools.slice(0, 7).map((tool) => (
        <BarRow
          key={tool.name}
          label={tool.name}
          value={formatInt(tool.calls)}
          fraction={tool.calls / maxCalls}
          colorClass={GROUP_BACKGROUND[tool.group]}
          hint={`${tool.successPct.toFixed(0)}% успешно${tool.failures ? ` · ${tool.failures} ошибок` : ""}`}
          trailing={
            <span className="mt-1 inline-block h-1 w-full max-w-[120px] overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-success/70" style={{ width: `${tool.successPct}%` }} />
            </span>
          }
        />
      ))}
      {tools.length === 0 ? (
        <p className="px-1.5 text-xs text-muted-foreground/60">Нет вызовов за период</p>
      ) : null}
    </WidgetCard>
  );
}
