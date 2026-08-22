// ru-code: auto-update ui-kit — monospace «terminal» box for commands and live logs.
// Tones mirror the app's status tokens; used by the wizard test step, the dev
// details section and the /updating live journal.
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { cn } from "../cn";
import type { RunLogTone } from "../../model";

const TONE_TEXT: Record<RunLogTone, string> = {
  dim: "text-muted-foreground/70",
  ok: "text-success-foreground",
  act: "text-primary",
  warn: "text-warning-foreground",
  err: "text-destructive-foreground",
};

export interface TerminalLine {
  tone: RunLogTone;
  text: string;
  time?: string;
}

export function TerminalBox({
  lines,
  command,
  className,
  maxHeight = "max-h-44",
  follow = false,
  action,
}: {
  lines: TerminalLine[];
  /** optional `$ …` header line rendered before the log */
  command?: string;
  className?: string;
  maxHeight?: string;
  /** autoscroll to the newest line (live journal) */
  follow?: boolean;
  /** e.g. a CopyButton pinned to the top-right corner */
  action?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!follow) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, lines.length]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-border/70 bg-muted/48 dark:bg-input/24",
        className,
      )}
      data-slot="terminal-box"
    >
      {action ? <div className="absolute end-1.5 top-1.5 z-10">{action}</div> : null}
      {/* This box IS the connection test's and the run's narration — lines append while the user
          waits. Without a live region a screen reader announced nothing at all, so the whole
          feedback of a credential test was silent. `polite`, because these lines are progress,
          never an interruption. */}
      <div
        aria-live="polite"
        className={cn(
          "overflow-y-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.75]",
          maxHeight,
        )}
        ref={scrollRef}
        role="log"
      >
        {command ? (
          <div className="whitespace-pre-wrap break-all text-foreground/80">
            <span className="select-none text-success-foreground">$ </span>
            {command}
          </div>
        ) : null}
        {lines.map((line) => (
          <div
            className="flex gap-2 whitespace-pre-wrap break-all"
            key={`${line.time}-${line.tone}-${line.text}`}
          >
            {line.time ? (
              <span className="shrink-0 select-none text-muted-foreground/50">{line.time}</span>
            ) : null}
            <span className={TONE_TEXT[line.tone]}>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
