import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import type { ApprovalRequestId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

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
   * True when the active session is parked waiting on the user — held
   * approval (file/edit/shell), held plan-approval, or held user-input
   * question. In this state the channel is technically "running" from
   * the orchestration's POV but the user has an action to take, not a
   * stop to issue. Suppresses the red Stop button so the regular Send
   * button renders; the server-side reactor auto-interrupts the held
   * Deferred when the new turn is dispatched (see specs/done/
   * stop-acp-session.md "Send-while-parked").
   */
  isParkedOnUser: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  /**
   * Ru-fork addition — submits the active pending user-input
   * request with an empty answers payload (`{}`). Rendered as a
   * destructive-outline Button next to the Submit button while a
   * user-input request is parked. See
   * `instrumental/changes/pending-requests-handling.md`.
   */
  onSkipPendingUserInput?: () => void;
  onInterrupt: () => void;
  /**
   * Live requestId for the server-held exit_plan_mode Deferred. Non-null
   * means the server's `pendingApprovals` Map still has the Deferred and
   * a `thread.approval.respond` dispatch will reach CLI. Null means the
   * Deferred is gone (server restarted, ACP child died, follow-up
   * already interrupted it) — the primary plan button must route to a
   * new thread instead.
   */
  pendingPlanApprovalRequestId: ApprovalRequestId | null;
  onImplementPlanInNewThread: () => void;
  /**
   * Ru-fork addition — dispatches `thread.approval.respond` against
   * the held plan_approval Deferred. Only valid when
   * `pendingPlanApprovalRequestId !== null`. See
   * `instrumental/changes/pending-requests-handling.md`.
   */
  onApproveInSameThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Отправка…";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Отправить" : "Далее";
  }
  if (!input.isLastQuestion) {
    return "Следующий вопрос";
  }
  return input.questionIndex > 0 ? "Отправить ответы" : "Отправить ответ";
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
  isConnecting,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  pendingPlanApprovalRequestId,
  onPreviousPendingQuestion,
  onSkipPendingUserInput,
  onInterrupt,
  onImplementPlanInNewThread,
  onApproveInSameThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
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
              Назад
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
            title="Отправить пустой ответ — модель сама решит, что делать дальше"
          >
            Не хочу отвечать
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
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

  // Plan-implement button takes priority over the stop button: when a
  // plan is ready, the turn is "running" only because the adapter is
  // holding the exit_plan_mode permission RPC waiting for our response
  // (see CliAdapter exit_plan_mode branch). Implement is the genuine
  // action; submitting it interrupts the held permission and starts the
  // implementation turn.
  if (showPlanFollowUpPrompt) {
    // Disable plan actions while CLI is genuinely streaming output —
    // session.status is `running` but user is NOT parked on a held
    // Deferred. While parked on plan_approval, `isParkedOnUser` is true
    // (hasPendingPlanApproval feeds it) so the buttons stay enabled —
    // clicking is how the user unblocks CLI. Once the Deferred resolves
    // and CLI starts streaming the implementation, the flag flips and
    // these disable until the turn settles.
    const isPlanActionDisabled = isSendBusy || isConnecting || (isRunning && !isParkedOnUser);

    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isPlanActionDisabled}
        >
          {isConnecting || isSendBusy ? "Отправка…" : "Уточнить"}
        </Button>
      );
    }

    // Two actions, two labels — same strings in both states, just swap
    // which is primary based on whether the server still holds the
    // exit_plan_mode Deferred. User can always pick either from the
    // dropdown (selecting «Реализовать» without a live id is allowed;
    // it'll fail with a stale-detail error if the Deferred is gone).
    const isPlanApprovalLive = pendingPlanApprovalRequestId !== null;
    const primaryLabel = isPlanApprovalLive ? "Реализовать" : "Реализовать в новом диалоге";
    const handlePrimaryClick = isPlanApprovalLive
      ? onApproveInSameThread
      : onImplementPlanInNewThread;

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isPlanActionDisabled}
          onClick={() => handlePrimaryClick()}
        >
          {isConnecting || isSendBusy ? "Отправка…" : primaryLabel}
        </Button>
        <Menu disabled={isPlanActionDisabled}>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            {isPlanApprovalLive ? (
              <MenuItem onClick={() => void onImplementPlanInNewThread()}>
                Реализовать в новом диалоге
              </MenuItem>
            ) : (
              <MenuItem onClick={() => void onApproveInSameThread()}>Реализовать</MenuItem>
            )}
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  // Parked-on-user takes precedence over isRunning so the user gets a
  // Send button (not the red Stop) when CLI is holding a permission /
  // plan / user-input Deferred. Server-side reactor will auto-interrupt
  // before dispatching the new turn.
  if (isRunning && !isParkedOnUser) {
    return (
      <button
        type="button"
        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
        {...pointerFocusProps}
        onClick={onInterrupt}
        aria-label="Stop generation"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-9 w-9 enabled:cursor-pointer items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
      {...pointerFocusProps}
      disabled={isSendBusy || isConnecting || !hasSendableContent}
      aria-label={
        isConnecting
          ? "Connecting"
          : isPreparingWorktree
            ? "Preparing worktree"
            : isSendBusy
              ? "Sending"
              : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
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
});
