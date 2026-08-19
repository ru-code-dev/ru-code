// ru-code: the send button while a hidden context compaction runs — disabled,
// labelled «Compacting the context…», and wrapped in the app Tooltip (the button
// itself is pointer-events-none when disabled, so the tooltip triggers on the
// wrapper span).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPrimaryActions } from "../../../components/chat/ComposerPrimaryActions";
import { COMPACTING_CONTEXT_TOOLTIP } from "../../workLog/contextCompaction";

const baseProps = {
  compact: false,
  pendingAction: null,
  isRunning: false,
  isParkedOnUser: false,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  pendingPlanApprovalRequestId: null,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
  onApproveInSameThread: () => {},
} as const;

describe("ComposerPrimaryActions — send during compaction", () => {
  it("compacting: the button is disabled with the compaction label and a wrapper trigger", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} isCompactingContext />,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(COMPACTING_CONTEXT_TOOLTIP);
    // The Tooltip trigger renders as the wrapper span around the button —
    // hover works even though the disabled button swallows pointer events.
    expect(markup).toMatch(/<span[^>]*>\s*<button/);
  });

  it("not compacting: the plain enabled send button, no compaction label", () => {
    const markup = renderToStaticMarkup(<ComposerPrimaryActions {...baseProps} />);
    expect(markup).toContain("Send message");
    expect(markup).not.toContain(COMPACTING_CONTEXT_TOOLTIP);
    expect(markup).not.toContain('disabled=""');
  });

  it("plan follow-up during compaction: «Implement» + dropdown + menu item all disabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} showPlanFollowUpPrompt isCompactingContext />,
    );
    expect(markup).toContain("Implement");
    expect(markup.split('disabled=""').length - 1).toBeGreaterThanOrEqual(2);
  });

  it("plan follow-up with typed text during compaction: «Refine» disabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        {...baseProps}
        showPlanFollowUpPrompt
        promptHasText
        isCompactingContext
      />,
    );
    expect(markup).toContain("Refine");
    expect(markup).toContain('disabled=""');
  });

  it("plan follow-up while idle: buttons enabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} showPlanFollowUpPrompt />,
    );
    expect(markup).toContain("Implement");
    expect(markup).not.toContain('disabled=""');
  });
});
