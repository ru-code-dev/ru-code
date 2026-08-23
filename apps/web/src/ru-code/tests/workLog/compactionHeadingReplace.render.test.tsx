// ru-code: the compaction row REPLACES its text — while it runs the chat shows
// the progress line, and on completion that SAME row's heading BECOMES the
// outcome. It must not become "«Идет сжатие контекста…» - <outcome>".
//
// The heading the screen prints comes from `toolWorkEntryHeading`
// (MessagesTimeline.tsx:2105-2110), which prefers `toolTitle` over `label`.
// Upstream 749baec35 started stamping `title` on every `task.progress` payload,
// so the progress heading outlived the compaction and the outcome was demoted
// to a "- suffix" (the breaker warning sentence disappeared entirely, since it
// lives in `label` while the preview comes from `detail`). Those are precisely
// the fields these fixtures carry — ingested shape, not a hand-trimmed one.
//
// This suite asserts RENDERED MARKUP, not `label`: compactionAgentRows.test.ts
// asserted `label`, the field the screen does NOT print, and stayed green while
// the row rendered wrong.
import { EnvironmentId, EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

import { CONTEXT_COMPACTION_TASK_PREFIX, CONTEXT_COMPACTION_TASK_TYPE } from "@ru-code/branding";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

vi.mock("@legendapp/list/react", async () => {
  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid="legend-list">
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );
  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="file-diff" />,
}));

function matchMedia() {
  return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
}

beforeAll(() => {
  const classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", { documentElement: { classList, offsetHeight: 0 } });
});

const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}heading-1`;
const PROGRESS_TEXT = "Идет сжатие контекста…";
const SUCCESS_TEXT = "Сжатие выполнено (200000 → 12345).";
const BREAKER_TEXT = "Сжатие почти не уменьшило контекст. Автосжатие отключено.";
const ADVICE_TEXT = "Начните новый диалог, чтобы продолжить работу.";
const FAILURE_TEXT = "Не удалось сжать контекст: boom";

// Exactly what ProviderRuntimeIngestion writes for the compaction pair today:
// `title` + `detail` + the `agentKind` stamp on the progress row (:607-610,
// :634), and `title` on the completed row TOO — ingestion remembers the
// progress `description` per task (cache :967-985) and looks it up at :760 to
// title the completion activity. Both limbs must be suppressed.
const progressActivity = (): OrchestrationThreadActivity => ({
  id: EventId.make("heading-progress"),
  createdAt: "2026-08-20T00:00:00.000Z",
  kind: "task.progress",
  summary: PROGRESS_TEXT,
  tone: "info",
  payload: {
    taskId: TASK_ID,
    title: PROGRESS_TEXT,
    detail: PROGRESS_TEXT,
    agentKind: "background",
    taskType: CONTEXT_COMPACTION_TASK_TYPE,
  },
  turnId: null,
});

const completedActivity = (payload: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make("heading-completed"),
  createdAt: "2026-08-20T00:00:05.000Z",
  kind: "task.completed",
  summary: "Task completed",
  tone: "info",
  payload: {
    taskId: TASK_ID,
    // The remembered progress description, as ingestion writes it (:760).
    title: PROGRESS_TEXT,
    agentKind: "background",
    taskType: CONTEXT_COMPACTION_TASK_TYPE,
    ...payload,
  },
  turnId: null,
});

// LEGACY persisted shape: pre-fix build, no taskType on the wire, so ingestion
// stamped agentKind "agent" on both rows.
const legacy = (activity: OrchestrationThreadActivity): OrchestrationThreadActivity => {
  const payload: Record<string, unknown> = {
    ...(activity.payload as Record<string, unknown>),
    agentKind: "agent",
  };
  delete payload["taskType"];
  return { ...activity, payload };
};

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    liveFollowEnabled: true,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

async function renderMarkup(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");
  const timelineEntries = deriveTimelineEntries([], [], deriveWorkLogEntries(activities));
  return renderToStaticMarkup(
    <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
  );
}

describe("compaction row REPLACES its text (rendered markup)", () => {
  it("MID-COMPRESSION: the row reads the progress line", async () => {
    const markup = await renderMarkup([progressActivity()]);
    expect(markup).toContain(PROGRESS_TEXT);
  });

  it("SUCCESS: the same row now reads the outcome, with the progress line GONE", async () => {
    const markup = await renderMarkup([
      progressActivity(),
      completedActivity({
        status: "completed",
        summary: SUCCESS_TEXT,
        detail: SUCCESS_TEXT,
        usage: { preTokens: 200_000, postTokens: 12_345 },
      }),
    ]);
    expect(markup).toContain(SUCCESS_TEXT);
    // The regression rendered "«Идет сжатие контекста…» - «Сжатие выполнено…»".
    expect(markup).not.toContain(PROGRESS_TEXT);
  });

  it("BREAKER WARNING: the warning sentence itself renders (it used to vanish)", async () => {
    const markup = await renderMarkup([
      progressActivity(),
      completedActivity({
        status: "completed",
        summary: BREAKER_TEXT,
        detail: ADVICE_TEXT,
        tone: "warning",
        usage: { preTokens: 200_000, postTokens: 199_000 },
      }),
    ]);
    expect(markup).toContain(BREAKER_TEXT);
    expect(markup).not.toContain(PROGRESS_TEXT);
  });

  it("FAILURE: the row reads the failure text", async () => {
    const markup = await renderMarkup([
      progressActivity(),
      completedActivity({ status: "failed", summary: FAILURE_TEXT, detail: FAILURE_TEXT }),
    ]);
    expect(markup).toContain(FAILURE_TEXT);
    expect(markup).not.toContain(PROGRESS_TEXT);
  });

  // F1: a thread compacted by the pre-fix build. Its rows are stamped
  // agentKind "agent" forever, so they used to render the subagent CTA —
  // «Ran 1 subagent · ✓ completed · View ▸» — which prints neither the outcome
  // nor the progress text. Old threads must now read exactly like new ones.
  it("LEGACY thread: the outcome renders, and no subagent CTA does", async () => {
    const markup = await renderMarkup([
      legacy(progressActivity()),
      legacy(
        completedActivity({
          status: "completed",
          summary: SUCCESS_TEXT,
          detail: SUCCESS_TEXT,
          usage: { preTokens: 200_000, postTokens: 12_345 },
        }),
      ),
    ]);
    expect(markup).toContain(SUCCESS_TEXT);
    expect(markup).not.toContain(PROGRESS_TEXT);
    expect(markup).not.toContain("subagent");
  });
});
