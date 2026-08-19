/**
 * ru-code: presentational body of the context meter popover, extracted from
 * ContextWindowMeter so it can be render-tested directly — base-ui portals the
 * popup, so its content never appears under renderToStaticMarkup in Node.
 *
 * @module ru-code/tokens-usage/ContextMeterPopoverBody
 */
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { formatContextWindowCompactionMessage } from "../../components/chat/ContextWindowMeter.logic";

export function ContextMeterPopoverBody(props: {
  usage: ContextWindowSnapshot;
  /** Pre-formatted display percentage (e.g. "60%"); null when unknown. */
  usedPercentage: string | null;
  /** Display fill percentage clamped to 0–100 for the progress bar. */
  normalizedPercentage: number;
  ringColor: string;
  headline: string | null;
  showCompress: boolean;
  showCompactButton: boolean;
  modelDisplayName?: string | null | undefined;
  onCompactContext?: (() => void) | null | undefined;
  compactDisabled?: boolean | undefined;
}) {
  const {
    usage,
    usedPercentage,
    normalizedPercentage,
    ringColor,
    headline,
    showCompress,
    showCompactButton,
    modelDisplayName,
    onCompactContext,
    compactDisabled,
  } = props;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Context Window</div>
        {usage.maxTokens !== null && usedPercentage ? (
          <div className="text-[11px] tabular-nums text-secondary-label">
            <span>{usedPercentage}</span>
            <span className="mx-1">·</span>
            <span>
              {formatContextWindowTokens(usage.usedTokens)}/
              {formatContextWindowTokens(usage.maxTokens ?? null)}
            </span>
          </div>
        ) : (
          <div className="text-[11px] tabular-nums text-secondary-label">
            {formatContextWindowTokens(usage.usedTokens)}
          </div>
        )}
      </div>
      {usage.maxTokens !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label="Context window usage"
        >
          <div
            className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${normalizedPercentage}%`, backgroundColor: ringColor }}
          />
        </div>
      ) : null}
      {showTotalProcessed ? (
        <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className="text-secondary-label">Total processed</span>
          <span className="font-medium tabular-nums text-secondary-label">
            {formatContextWindowTokens(totalProcessedTokens)}
          </span>
        </div>
      ) : null}
      {usage.compactsAutomatically ? (
        <div className="mt-1 text-pretty text-[11px] font-medium text-secondary-label">
          {/* ru-code: model-precise auto-compact line — wording from t3's tested helper. */}
          {formatContextWindowCompactionMessage(modelDisplayName)}
        </div>
      ) : null}
      {/* ru-code: qwen-only warn/danger advice — mutually exclusive with the
          auto-compact line above via the same compactsAutomatically flag. */}
      {showCompress ? (
        <div className="mt-1 space-y-0.5 border-border/60 border-t pt-1.5 text-[11px] text-foreground">
          <div>{headline}</div>
          {onCompactContext ? null : (
            <div>
              Send <code className="rounded bg-muted px-1 py-0.5 font-medium">/compress</code>, to
              compact the conversation history.
            </div>
          )}
        </div>
      ) : null}
      {/* ru-code: manual compaction — hidden `/compress` turn: timeline row +
          meter update, no user message. Disabled while the session is busy. */}
      {showCompactButton && onCompactContext ? (
        <button
          type="button"
          onClick={onCompactContext}
          disabled={compactDisabled ?? false}
          className={cn(
            "mt-1 w-full rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium transition-colors",
            compactDisabled
              ? "cursor-not-allowed text-secondary-label/50"
              : "cursor-pointer text-foreground hover:bg-accent",
          )}
        >
          Compact context
        </button>
      ) : null}
    </div>
  );
}
