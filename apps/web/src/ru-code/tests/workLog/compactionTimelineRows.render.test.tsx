// ru-code: COMPONENT-LEVEL twin of compactionTimelineRows.test.ts. The
// neutral-tool filter exists twice — in deriveMessagesTimelineRows AND again
// inside MessagesTimeline's WorkGroupSection — so a fix that only clears the
// logic layer can green the logic test while the screen stays empty. These
// cases pin the actual markup.
import { EnvironmentId, EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
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

const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}render-tsx-1`;
const PROGRESS_TEXT = "Идет сжатие контекста…";
const BREAKER_TEXT =
  "Сжатие почти не уменьшило контекст (200000 -> 199000). Автоматическое сжатие отключено.";

let nextActivityId = 0;
function makeActivity(overrides: {
  kind: string;
  payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`render-tsx-activity-${activityIndex}`),
    createdAt: `2026-03-08T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.kind === "task.progress" ? "Обновление рассуждений" : "Task completed",
    tone: "info",
    payload: overrides.payload,
    turnId: null,
  };
}

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    // ru-code: fixture rot fix (F2) — MessagesTimeline gained this required prop.
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

describe("compaction rows — actual MessagesTimeline markup", () => {
  it("MID-COMPRESSION: the spinner row appears in the rendered markup", async () => {
    const markup = await renderMarkup([
      makeActivity({
        kind: "task.progress",
        payload: { taskId: TASK_ID, detail: PROGRESS_TEXT },
      }),
    ]);
    expect(markup).toContain(PROGRESS_TEXT);
  });

  it("breaker trip: the amber warning row appears in the rendered markup", async () => {
    const markup = await renderMarkup([
      makeActivity({
        kind: "task.progress",
        payload: { taskId: TASK_ID, detail: PROGRESS_TEXT },
      }),
      makeActivity({
        kind: "task.completed",
        payload: {
          taskId: TASK_ID,
          status: "completed",
          detail: BREAKER_TEXT,
          tone: "warning",
          usage: { preTokens: 200_000, postTokens: 199_000 },
        },
      }),
    ]);
    expect(markup).toContain(
      "Сжатие почти не уменьшило контекст (200000 -&gt; 199000). Автоматическое сжатие отключено.",
    );
  });
});
