import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    // ru-code: qwen exit_plan_mode held approval — no command/file requestKind.
    approval.requestType === "plan_approval"
      ? "Plan ready to implement"
      : approval.requestKind === "command"
        ? "Command approval requested"
        : approval.requestKind === "file-read"
          ? "File-read approval requested"
          : approval.requestKind === "file-change"
            ? "File-change approval requested"
            : // ru-code: generic fallback for any "other" forward-compat kind.
              "Action approval requested";
  const detailLabel =
    approval.requestType === "plan_approval"
      ? "Plan"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "file-change"
            ? "File change"
            : "Details";

  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 min-w-0 max-w-full rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 min-w-0 max-w-full max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
