/**
 * ru-fork: Analytics — recent sessions table; a row opens the session detail.
 *
 * @module ru-fork/stats/components/widgets/SessionsTableCard
 */
import { ChevronRightIcon, TableIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { formatDateTime, formatDuration, formatInt, formatTokens } from "../../model/format";
import type { StatsSession } from "../../model/types";
import { WidgetCard } from "../primitives";

function sumRecordValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value;
  return total;
}

function visibleTokenTotal(session: StatsSession): number {
  return session.tokens.input + session.tokens.output + session.tokens.thinking;
}

interface SessionsTableCardProps {
  readonly sessions: readonly StatsSession[];
  readonly onSelect: (sessionId: string) => void;
  readonly onExpand: () => void;
  readonly limit?: number;
}

export function SessionsTableCard({ sessions, onSelect, onExpand, limit = 10 }: SessionsTableCardProps) {
  const visibleSessions = sessions.slice(0, limit);

  return (
    <WidgetCard
      title="Сессии"
      subtitle={`${formatInt(sessions.length)} за период`}
      icon={TableIcon}
      onExpand={onExpand}
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
            <tr className="border-b border-border/60">
              <th className="px-4 py-2 font-medium">Дата</th>
              <th className="px-2 py-2 font-medium">Проект</th>
              <th className="px-2 py-2 font-medium">Ветка</th>
              <th className="px-2 py-2 text-right font-medium">Токены</th>
              <th className="px-2 py-2 text-right font-medium">Ходы</th>
              <th className="px-2 py-2 text-right font-medium">Инстр.</th>
              <th className="px-2 py-2 text-right font-medium">Длит.</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {visibleSessions.map((session) => {
              const errorCount = sumRecordValues(session.errorTypes);
              return (
                <tr
                  key={session.sessionId}
                  onClick={() => onSelect(session.sessionId)}
                  className="group/row cursor-pointer border-b border-border/40 last:border-0 hover:bg-accent/50"
                >
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{formatDateTime(session.startedAt)}</td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-foreground">{session.projectLabel}</span>
                      {session.projectKind === "temp" ? <Badge size="sm" variant="outline">temp</Badge> : null}
                      {session.isBackground ? <Badge size="sm" variant="secondary">фон</Badge> : null}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-muted-foreground/80">{session.branch}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground">{formatTokens(visibleTokenTotal(session))}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-muted-foreground">{session.turns}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-muted-foreground">{formatInt(sumRecordValues(session.toolCounts))}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted-foreground">{formatDuration(session.durationMs)}</td>
                  <td className="px-2 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      {errorCount > 0 ? (
                        <span className="size-1.5 rounded-full bg-destructive" title={`${errorCount} ошибок`} />
                      ) : null}
                      <ChevronRightIcon className="size-3.5 text-muted-foreground/40 transition-transform group-hover/row:translate-x-0.5" />
                    </span>
                  </td>
                </tr>
              );
            })}
            {visibleSessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground/60">
                  Нет сессий под текущие фильтры
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </WidgetCard>
  );
}
