import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import type { ApprovalRequestId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
// ru-code: pure plan-primary-action decision (M2), shared + tested.
import { selectPlanPrimaryAction } from "~/ru-code/composer/planActions";
// ru-code: send blocked + tooltip while a hidden context compaction runs.
import { COMPACTING_CONTEXT_TOOLTIP } from "~/ru-code/workLog/contextCompaction";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  /**
   * ru-code (M7): true when the session is parked waiting on the user — a held
   * approval or a held user-input question. phase stays "running" but the user
   * has an action to take, not a Stop to issue, so we suppress the red Stop and
   * render the regular Send button (letting them queue a follow-up).
   */
  isParkedOnUser: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  // ru-code: true while a hidden context compaction runs — send is blocked
  // with the "Compacting the context…" tooltip until task.completed lands.
  isCompactingContext?: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  /** Enter-to-send is disabled on mobile viewports, where stop would otherwise
   * be the only primary action and a running turn could not be steered. */
  showSendWhileRunning?: boolean;
  onPreviousPendingQuestion: () => void;
  /**
   * ru-code (M8): submits the active pending user-input request with an empty
   * answers payload (`{}`). Rendered as a destructive-outline button next to
   * the submit button while a user-input request is parked; the server turns
   * the empty answer into a cancelled outcome that resumes the turn.
   */
  onSkipPendingUserInput?: () => void;
  onInterrupt: () => void;
  /**
   * ru-code (M2): live requestId for the server-held plan_approval Deferred.
   * Non-null (qwen only) ⇒ the primary action approves in-place; null ⇒ the
   * port's existing same-thread submit / new-thread fallback (today's
   * behaviour for every non-qwen provider).
   */
  pendingPlanApprovalRequestId: ApprovalRequestId | null;
  onImplementPlanInNewThread: () => void;
  /** ru-code (M2): responds to the held plan_approval Deferred in the same thread. */
  onApproveInSameThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  isParkedOnUser,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isCompactingContext = false, // ru-code
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  showSendWhileRunning = false,
  onPreviousPendingQuestion,
  onSkipPendingUserInput,
  onInterrupt,
  pendingPlanApprovalRequestId,
  onImplementPlanInNewThread,
  onApproveInSameThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const isSendDisabled = sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none",
        insidePendingAction
          ? "size-8 sm:size-7"
          : showSendWhileRunning && hasSendableContent
            ? "size-9 sm:size-8"
            : "size-8 sm:h-8 sm:w-8",
      )}
      {...pointerFocusProps}
      onClick={onInterrupt}
      aria-label="Stop generation"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? renderStopGenerationButton(true) : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        {onSkipPendingUserInput ? (
          <Button
            size="sm"
            variant="destructive-outline"
            className={cn("rounded-full", compact ? "px-3" : "px-4")}
            {...pointerFocusProps}
            onClick={onSkipPendingUserInput}
            disabled={pendingAction.isResponding}
            title="Send an empty response — let the model decide what to do next"
          >
            I'd rather not answer
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn(
            "rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover",
            compact ? "px-3" : "px-4",
          )}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn(
            "rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover",
            compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8",
          )}
          {...pointerFocusProps}
          // ru-code: auto-compact fires at turn end — exactly when this UI
          // shows; blocked like every other send affordance.
          disabled={
            isSendBusy ||
            isSendDisabled ||
            isConnecting ||
            isEnvironmentUnavailable ||
            isCompactingContext
          }
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    // ru-code (M2): when the server still holds a plan_approval Deferred (qwen
    // only) the primary approves it in-place (`onApproveInSameThread`, no form
    // submit) instead of starting a fresh turn. With no live Deferred (every
    // non-qwen provider) `handlerKind` is "new-thread" ⇒ we keep the port's
    // existing same-thread submit button + new-thread dropdown, byte-identical
    // to today's behaviour. The label stays "Implement" in both states — the
    // helper's null-branch label is only consumed by the pure-helper contract
    // (the port routes new-thread through the dropdown, not the primary label).
    const isPlanApprovalLive =
      selectPlanPrimaryAction({ pendingPlanApprovalRequestId }).handlerKind === "same-thread";
    // ru-code: isCompactingContext — a press mid-compaction was a silent no-op.
    const planActionsDisabled =
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      isEnvironmentUnavailable ||
      isCompactingContext;

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type={isPlanApprovalLive ? "button" : "submit"}
          size="sm"
          className="h-9 rounded-l-full rounded-r-none bg-message-action px-4 text-message-action-foreground hover:bg-message-action-hover sm:h-8"
          {...pointerFocusProps}
          disabled={planActionsDisabled}
          {...(isPlanApprovalLive ? { onClick: () => onApproveInSameThread() } : {})}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-message-action-foreground/20 bg-message-action px-2 text-message-action-foreground hover:bg-message-action-hover sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={planActionsDisabled}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={planActionsDisabled}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  const sendButton = (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      {...pointerFocusProps}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isCompactingContext ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isCompactingContext
            ? COMPACTING_CONTEXT_TOOLTIP
            : sendDisabledReason
              ? sendDisabledReason
              : isConnecting
                ? "Connecting"
                : isPreparingWorktree
                  ? "Preparing worktree"
                  : isSendBusy
                    ? "Sending"
                    : "Send message"
      }
    >
      {stageBackdropVariant ? (
        <span className="absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  // ru-code (M7): parked-on-user takes precedence over isRunning so the user
  // gets a Send button (not the red Stop) while CLI holds a permission / plan /
  // user-input Deferred. When not parked this is byte-identical to `isRunning`.
  if (!isRunning || isParkedOnUser) {
    // ru-code: while a compaction runs the button is disabled (pointer-events
    // none), so the tooltip triggers on a wrapper span, not the button itself.
    if (!isCompactingContext) {
      return sendButton;
    }
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
        <TooltipPopup side="top">{COMPACTING_CONTEXT_TOOLTIP}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <>
      {renderStopGenerationButton(false)}
      {showSendWhileRunning && hasSendableContent ? sendButton : null}
    </>
  );
});
