import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPrimaryActions } from "../../../components/chat/ComposerPrimaryActions";

// aria-label of the red Stop button; its absence proves a Send button rendered.
const STOP_LABEL = "Stop generation";
const SEND_LABEL = "Send message";

const baseProps = {
  compact: false,
  pendingAction: null,
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

describe("ComposerPrimaryActions send-while-parked (M7)", () => {
  it("renders the red Stop button when running and NOT parked on the user", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} isRunning isParkedOnUser={false} />,
    );
    expect(markup).toContain(STOP_LABEL);
    expect(markup).not.toContain(SEND_LABEL);
  });

  it("renders the Send button (not Stop) when running but parked on the user", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} isRunning isParkedOnUser />,
    );
    expect(markup).not.toContain(STOP_LABEL);
    expect(markup).toContain(SEND_LABEL);
  });
});
