// ru-code: RENDER-LEVEL coverage of the ask-a-question flow — ingestion-shaped
// `user-input.requested` activities → derivePendingUserInputs → the real
// question panel markup, plus the question-navigation/skip chrome of
// ComposerPrimaryActions. Until now nothing rendered this panel from any
// input; the strict question parser can silently swallow a request (parked
// RPC, no panel) and no test would notice.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "../../../components/chat/ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "../../../components/chat/ComposerPrimaryActions";
import { derivePendingUserInputs } from "../../../session-logic";

let nextActivityId = 0;
function userInputRequestedActivity(
  questions: ReadonlyArray<Record<string, unknown>>,
): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`user-input-activity-${activityIndex}`),
    createdAt: `2026-03-06T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: "user-input.requested",
    summary: "User input requested",
    tone: "info",
    payload: { requestId: `req-q-${activityIndex}`, questions },
    turnId: null,
  };
}

const question = (index: number, extra?: Record<string, unknown>) => ({
  id: `cli-q${index}-question-${index}`,
  header: `Header ${index}`,
  question: `Question text ${index}?`,
  options: [
    { label: `Option A${index}`, description: `Option A${index}` },
    { label: `Option B${index}`, description: `Longer description B${index}` },
  ],
  multiSelect: false,
  ...extra,
});

function renderPanel(activity: OrchestrationThreadActivity, questionIndex = 0): string {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={derivePendingUserInputs([activity])}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );
}

describe("pending question panel — rendered markup", () => {
  it("single question: header, text, options and digit shortcuts render", () => {
    const markup = renderPanel(userInputRequestedActivity([question(0)]));
    expect(markup).toContain("Header 0");
    expect(markup).toContain("Question text 0?");
    expect(markup).toContain("Option A0");
    expect(markup).toContain("Option B0");
    expect(markup).toContain(">1<");
    expect(markup).not.toContain("Select one or more options.");
  });

  it("multi-select question shows the multi-select hint", () => {
    const markup = renderPanel(userInputRequestedActivity([question(0, { multiSelect: true })]));
    expect(markup).toContain("Select one or more options.");
  });

  it("4-question batch: counter chip 1/4, then 4/4 with the last question", () => {
    const batch = userInputRequestedActivity([question(0), question(1), question(2), question(3)]);
    const first = renderPanel(batch, 0);
    expect(first).toContain("1/4");
    expect(first).toContain("Question text 0?");
    const last = renderPanel(batch, 3);
    expect(last).toContain("4/4");
    expect(last).toContain("Question text 3?");
  });

  it("an option without a description must still be offered to the user", () => {
    // The wire allows options without a description; silently dropping one
    // hides a choice the CLI offered.
    const markup = renderPanel(
      userInputRequestedActivity([
        {
          id: "cli-q0-bare",
          header: "Bare",
          question: "Bare question?",
          options: [{ label: "Only label" }, { label: "Full", description: "Full" }],
          multiSelect: false,
        },
      ]),
    );
    expect(markup).toContain("Bare question?");
    expect(markup).toContain("Only label");
  });

  it("a question whose options all lack descriptions must not vanish (parked RPC, no panel)", () => {
    // If the parser rejects every option it drops the question and then the
    // whole pending input — the request stays parked with NO panel at all,
    // the silent deadlock this panel exists to prevent.
    const markup = renderPanel(
      userInputRequestedActivity([
        {
          id: "cli-q0-all-bare",
          header: "AllBare",
          question: "All bare question?",
          options: [{ label: "First" }, { label: "Second" }],
          multiSelect: false,
        },
      ]),
    );
    expect(markup).toContain("All bare question?");
  });
});

const basePrimaryProps = {
  compact: false,
  isRunning: false,
  isParkedOnUser: true,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: false,
  pendingPlanApprovalRequestId: null,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
  onApproveInSameThread: () => {},
} as const;

describe("question navigation / skip chrome — ComposerPrimaryActions", () => {
  it("mid-batch: «Next question» + «Previous», skip offered when wired", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        {...basePrimaryProps}
        pendingAction={{
          questionIndex: 1,
          isLastQuestion: false,
          canAdvance: true,
          isResponding: false,
          isComplete: false,
        }}
        onSkipPendingUserInput={() => {}}
      />,
    );
    expect(markup).toContain("Next question");
    expect(markup).toContain("Previous");
    expect(markup).toContain("rather not answer");
  });

  it("last question: «Submit answers»; skip absent when the handler is not wired", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        {...basePrimaryProps}
        pendingAction={{
          questionIndex: 1,
          isLastQuestion: true,
          canAdvance: false,
          isResponding: false,
          isComplete: true,
        }}
      />,
    );
    expect(markup).toContain("Submit answers");
    expect(markup).not.toContain("rather not answer");
  });
});
