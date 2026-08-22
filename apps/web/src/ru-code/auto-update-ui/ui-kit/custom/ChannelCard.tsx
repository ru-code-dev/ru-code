// ru-code: auto-update ui-kit — update-channel card (v2 multi-source model).
// One repeating anatomy for every channel: health dot + name + status line +
// user-owned switch, expandable into the config area. Health is system-owned
// and NEVER moves the switch (auth errors freeze, they don't disable).
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../button";
import { isDisclosureOpen, needsAttention, settleHealth } from "./channelDisclosure";
import { cn } from "../cn";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../collapsible";
import { Spinner } from "../spinner";
import { Switch } from "../switch";
import type { ChannelHealth } from "../../model";

function HealthDot({ health, enabled }: { health: ChannelHealth; enabled: boolean }) {
  if (!enabled) return <span className="size-2 rounded-full bg-muted-foreground/40" />;
  switch (health) {
    case "ok":
      return (
        <span className="size-2 rounded-full bg-success shadow-[0_0_0_3px] shadow-success/16" />
      );
    case "probing":
      return <Spinner className="size-3 text-primary" />;
    // Nothing has been asked of this source yet: neutral, not a warning.
    case "unchecked":
      return <span className="size-2 rounded-full bg-muted-foreground/60" />;
    case "needs-setup":
      return (
        <span className="size-2 rounded-full bg-warning shadow-[0_0_0_3px] shadow-warning/16" />
      );
    case "unreachable":
      return (
        <span className="size-2 rounded-full bg-destructive shadow-[0_0_0_3px] shadow-destructive/16" />
      );
  }
}

export function channelStatusText(health: ChannelHealth, enabled: boolean): string {
  if (!enabled) return "off";
  switch (health) {
    case "ok":
      return "operational";
    case "probing":
      return "checking…";
    case "unchecked":
      return "not checked yet";
    case "needs-setup":
      return "needs setup";
    case "unreachable":
      return "not reachable";
  }
}

export function ChannelCard({
  icon,
  title,
  health,
  enabled,
  onToggle,
  statusLine,
  issue,
  lastProbe,
  onProbe,
  probeDisabled = false,
  children,
  className,
  testId,
  probeTestId,
  // ru-code: e2e — the derived SourceState (ok/errored/paused/…) exposed as an
  // attribute so a spec can assert a source card's health state without reading
  // Russian copy. Purely a data-attribute; nothing visual reads it.
  dataState,
}: {
  icon: ReactNode;
  title: string;
  health: ChannelHealth;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** one-line summary under the title, e.g. «через ваши системные ключи git» */
  statusLine: ReactNode;
  /** reason text while needs-setup / unreachable */
  issue?: string | null;
  lastProbe?: string | null;
  onProbe?: () => void;
  /** Disable the probe button while a global check / install run is in flight. */
  probeDisabled?: boolean;
  /** config area (expandable) */
  children?: ReactNode;
  className?: string;
  testId?: string;
  probeTestId?: string;
  dataState?: string;
}) {
  // Открыт, когда есть реальная проблема — или когда пользователь открыл его сам.
  // The whole rule (and why it is not a mount snapshot) lives in channelDisclosure.ts.
  const [settledHealth, setSettledHealth] = useState(health);
  useEffect(() => {
    setSettledHealth((previous) => settleHealth(previous, health));
  }, [health]);

  const [userSet, setUserSet] = useState<boolean | null>(null);
  const attention = needsAttention({ enabled, settledHealth });
  const open = isDisclosureOpen({ userSet, attention });

  return (
    <div
      className={cn(
        "rounded-xl border transition-colors",
        attention
          ? health === "unreachable"
            ? "border-destructive/32 bg-destructive/4 dark:bg-destructive/6"
            : "border-warning/36 bg-warning/4 dark:bg-warning/6"
          : "border-border/70 bg-background dark:bg-input/16",
        !enabled && "opacity-88",
        className,
      )}
      data-slot="channel-card"
      data-testid={testId}
      data-state={dataState}
      // ru-code: e2e — whether the configuration area is expanded, as an attribute, so a spec can
      // assert "a clean check never touches the block" without reading Russian copy or geometry.
      data-open={open ? "true" : "false"}
    >
      <Collapsible onOpenChange={setUserSet} open={open}>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <span className="grid w-4 shrink-0 place-items-center">
            <HealthDot enabled={enabled} health={health} />
          </span>
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/64 text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
              enabled &&
                health === "ok" &&
                "border-success/24 bg-success/8 text-success-foreground",
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">{title}</span>
              <span
                className={cn(
                  "font-mono text-[10px] font-semibold uppercase tracking-[0.06em]",
                  !enabled
                    ? "text-muted-foreground/60"
                    : health === "ok"
                      ? "text-success-foreground"
                      : health === "probing"
                        ? "text-primary"
                        : health === "unchecked"
                          ? "text-muted-foreground"
                          : health === "needs-setup"
                            ? "text-warning-foreground"
                            : "text-destructive-foreground",
                )}
              >
                {channelStatusText(health, enabled)}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{statusLine}</div>
          </div>
          {onProbe && enabled ? (
            <Button
              data-testid={probeTestId}
              disabled={probeDisabled || health === "probing"}
              onClick={onProbe}
              size="xs"
              variant="outline"
            >
              <RefreshCwIcon />
              Check
            </Button>
          ) : null}
          {/* Disabled source: greyed and neutral — zero controls except the switch. */}
          {enabled ? (
            <CollapsibleTrigger
              aria-label="Channel settings"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronDownIcon
                className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
              />
            </CollapsibleTrigger>
          ) : null}
          {/* The card title is a plain <span>, so this control had NO accessible name at all — a
              screen reader announced "switch, on" with nothing to say which of the two sources it
              belongs to, on the only control that can turn an update source off. */}
          <Switch
            aria-label={`${title} — update source`}
            checked={enabled}
            onCheckedChange={(checked) => onToggle(checked)}
          />
        </div>
        {enabled ? (
          <CollapsiblePanel>
            <div className="space-y-4 border-t border-border/60 px-3.5 py-3.5">
              {issue ? (
                <p
                  className={cn(
                    "text-xs leading-relaxed",
                    health === "unreachable"
                      ? "text-destructive-foreground"
                      : "text-warning-foreground",
                  )}
                >
                  {issue}
                </p>
              ) : null}
              {children}
              {lastProbe ? (
                <p className="font-mono text-[10.5px] text-muted-foreground/60">
                  last check: {lastProbe}
                </p>
              ) : null}
            </div>
          </CollapsiblePanel>
        ) : null}
      </Collapsible>
    </div>
  );
}
