/**
 * ru-fork: Analytics — single-session drill-down (opened from the table row).
 *
 * @module ru-fork/stats/components/SessionDetailSheet
 */
import { Badge } from "~/components/ui/badge";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { formatDateTime, formatDuration, formatInt, formatTokens } from "../model/format";
import type { StatsSession, StatsView } from "../model/types";
import { findSessionById, useStatsStore } from "../store";
import { BarRow } from "./primitives";

export function SessionDetailSheet({ view }: { view: StatsView }) {
  const selectedSessionId = useStatsStore((state) => state.selectedSessionId);
  const selectSession = useStatsStore((state) => state.selectSession);
  const session = findSessionById(view, selectedSessionId);

  return (
    <Sheet open={selectedSessionId !== null} onOpenChange={(isOpen) => !isOpen && selectSession(null)}>
      <SheetPopup side="right" className="max-w-lg">
        {session ? <SessionDetailBody session={session} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

function SessionDetailBody({ session }: { session: StatsSession }) {
  const visibleTotal = session.tokens.input + session.tokens.output + session.tokens.thinking;
  const toolEntries = Object.entries(session.toolCounts).toSorted((first, second) => second[1] - first[1]);
  const maxToolCalls = toolEntries[0]?.[1] ?? 1;
  const errorEntries = Object.entries(session.errorTypes);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono text-base">{session.projectLabel}</SheetTitle>
        <SheetDescription>{formatDateTime(session.startedAt)}</SheetDescription>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{session.branch}</Badge>
          <Badge variant="secondary">{session.model.replace("qwen/", "")}</Badge>
          {session.projectKind === "temp" ? <Badge variant="outline">песочница</Badge> : null}
          {session.isBackground ? <Badge variant="info">фон</Badge> : null}
        </div>
      </SheetHeader>
      <SheetPanel className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          <SessionStat label="Токены" value={formatTokens(visibleTotal)} />
          <SessionStat label="Ходы" value={formatInt(session.turns)} />
          <SessionStat label="Запросы API" value={formatInt(session.apiCalls)} />
          <SessionStat label="Длительность" value={formatDuration(session.durationMs)} />
          <SessionStat label="Ср. задержка" value={formatDuration(session.avgLatencyMs)} />
          <SessionStat label="Макс. задержка" value={formatDuration(session.maxLatencyMs)} />
        </div>

        <section className="flex flex-col gap-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">Состав токенов</h4>
          <div className="flex h-3 overflow-hidden rounded-full bg-muted">
            <span className="bg-chart-1" style={{ width: `${(session.tokens.input / visibleTotal) * 100}%` }} />
            <span className="bg-chart-2" style={{ width: `${(session.tokens.output / visibleTotal) * 100}%` }} />
            <span className="bg-chart-3" style={{ width: `${(session.tokens.thinking / visibleTotal) * 100}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Ввод {formatTokens(session.tokens.input)}</span>
            <span>Вывод {formatTokens(session.tokens.output)}</span>
            <span>Размышл. {formatTokens(session.tokens.thinking)}</span>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Инструменты ({formatInt(toolEntries.reduce((runningTotal, entry) => runningTotal + entry[1], 0))})
          </h4>
          <div className="flex flex-col gap-0.5">
            {toolEntries.map(([toolName, callCount]) => (
              <BarRow
                key={toolName}
                label={toolName}
                value={formatInt(callCount)}
                fraction={callCount / maxToolCalls}
                hint={session.toolFailures[toolName] ? `${session.toolFailures[toolName]} ошибок` : undefined}
              />
            ))}
            {toolEntries.length === 0 ? (
              <p className="px-1.5 text-xs text-muted-foreground/60">Без вызовов инструментов</p>
            ) : null}
          </div>
        </section>

        {errorEntries.length ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">Ошибки</h4>
            {errorEntries.map(([errorType, count]) => (
              <div
                key={errorType}
                className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs"
              >
                <span className="size-1.5 rounded-full bg-destructive" />
                <span className="flex-1 text-destructive-foreground">{errorType}</span>
                <span className="font-mono tabular-nums">{count}</span>
              </div>
            ))}
          </section>
        ) : null}
      </SheetPanel>
    </>
  );
}

function SessionStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground/60">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
