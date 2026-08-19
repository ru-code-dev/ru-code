import { useState } from "react";

import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
// ru-code: popover body lives in its own presentational component so the advice
// text can be render-tested (base-ui portals the popup out of static markup).
import { ContextMeterPopoverBody } from "~/ru-code/tokens-usage/ContextMeterPopoverBody";
// ru-code: qwen-only warn/danger bands, gated on the provider snapshot flag;
// compactActionClosingPopover closes the popover when Compact is pressed.
import { compactActionClosingPopover, contextMeterAdvice } from "~/ru-code/tokens-usage/usage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  // ru-code: manual compaction — present only for providers that support the
  // hidden `/compress` (qwen kind, live session). Null/absent ⇒ text hint only.
  onCompactContext?: (() => void) | null;
  // ru-code: true while a turn streams / the session is parked — compaction
  // needs an idle serial session.
  compactDisabled?: boolean;
}) {
  const { usage, modelDisplayName, onCompactContext, compactDisabled } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  // ru-code: the whole band decision lives in the tokens-usage module. Only
  // providers that DON'T auto-compact (qwen) with a known window get the
  // warn/danger bands + /compress advice; Codex/Claude keep the neutral blue
  // meter and their own auto-compact line — no leak. The level is computed from
  // RAW usedTokens/maxTokens (usedPercentage is pre-clamped to 100, which would
  // read >100% as "warning" instead of "danger").
  const { ringColor, headline, showCompress, showCompactButton } = contextMeterAdvice(usage);
  // ru-code: controlled so pressing Compact closes the hover popover it sits
  // in (compactActionClosingPopover) — progress lives in the timeline row.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const handleCompactContext = onCompactContext
    ? compactActionClosingPopover(() => setPopoverOpen(false), onCompactContext)
    : onCompactContext;

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              {/* ru-code: in-ring usage readout — % when the window is known, else raw token count. */}
              <span className="relative flex items-center justify-center rounded-full bg-background text-[7px] font-medium text-muted-foreground leading-none tabular-nums">
                {usage.maxTokens != null
                  ? Math.round(usage.usedPercentage ?? 0)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <ContextMeterPopoverBody
          usage={usage}
          usedPercentage={usedPercentage}
          normalizedPercentage={normalizedPercentage}
          ringColor={ringColor}
          headline={headline}
          showCompress={showCompress}
          showCompactButton={showCompactButton}
          modelDisplayName={modelDisplayName}
          onCompactContext={handleCompactContext}
          compactDisabled={compactDisabled}
        />
      </PopoverPopup>
    </Popover>
  );
}
