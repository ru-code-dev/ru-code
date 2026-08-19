import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

import { ThreadErrorBanner } from "../../../components/chat/ThreadErrorBanner";
import { deriveWorkLogEntries } from "../../../session-logic";

// --------------------------------------------------------------------------
// The three qwen error UI surfaces, each rendered by a distinct web element:
//   Bubble       -> assistant chat message (content.delta assistant_text)
//   Timeline     -> a tone:"error" work-log row from deriveWorkLogEntries,
//                   persisting after the turn ends
//   Notification -> the red ThreadErrorBanner driven by session.lastError
// Each test proves its surface renders AND that the OTHER surfaces are absent
// for that input.
// --------------------------------------------------------------------------

// Classified friendly text the server puts on a failed task's `summary` (the
// heading of the Timeline row). Starts capitalised and carries no trailing
// "complete" so the row heading equals the text verbatim after the timeline's
// capitalize/normalize pass.
const TIMELINE_ERROR = "Qwen provider hit a protocol error";
// Classified text the server writes to session.lastError -> ThreadErrorBanner.
const NOTIFICATION_ERROR = "Qwen provider failed to start the turn.";
// Friendly assistant text streamed as content.delta -> chat bubble.
const BUBBLE_TEXT = "Извините, произошёл сбой при обработке запроса Qwen.";
// Fixed heading the server emits for a runtime.error activity.
const RUNTIME_ERROR_HEADING = "Runtime error";

let nextActivityId = 0;

// Mirrors the makeActivity helper in session-logic.test.ts: a real
// OrchestrationThreadActivity as the server records it.
function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
  };
}

// The failed-task activity the server emits for a Timeline decision
// (ProviderRuntimeIngestion `task.completed` with status "failed": tone
// "error", the classified text on `summary`).
function makeFailedTaskActivity(text: string, turnId?: string): OrchestrationThreadActivity {
  return makeActivity({
    id: "activity-failed-task",
    kind: "task.completed",
    tone: "error",
    summary: text,
    payload: { taskId: "task-1", status: "failed", detail: text },
    ...(turnId ? { turnId } : {}),
  });
}

// The other Timeline variant: a runtime.error activity (fixed heading,
// classified message on payload).
function makeRuntimeErrorActivity(message: string): OrchestrationThreadActivity {
  return makeActivity({
    id: "activity-runtime-error",
    kind: "runtime.error",
    tone: "error",
    summary: RUNTIME_ERROR_HEADING,
    payload: { message },
  });
}

// ==========================================================================
// MessagesTimeline render harness (mirrors MessagesTimeline.test.tsx).
// ==========================================================================

vi.mock("@legendapp/list/react", async () => {
  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      onReady?: (info: { anchorIndex: number }) => void;
      onSizeChanged?: (size: number) => void;
    };
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onSizeChanged?.(240);
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: { fileDiff: { name?: string | null; prevName?: string | null } }) {
  return (
    <div data-testid="file-diff">{props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}</div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

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
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildTimelineProps(activeTurnInProgress: boolean) {
  return {
    isWorking: activeTurnInProgress,
    activeTurnInProgress,
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
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
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

function errorWorkTimelineEntry(text: string) {
  return {
    id: "entry-error",
    kind: "work" as const,
    createdAt: CREATED_AT,
    entry: {
      id: "work-error",
      createdAt: CREATED_AT,
      label: text,
      tone: "error" as const,
      sourceActivityKind: "task.completed" as const,
    },
  };
}

function assistantMessageTimelineEntry(text: string) {
  return {
    id: "entry-assistant",
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make("message-assistant"),
      role: "assistant" as const,
      text,
      turnId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
    },
  };
}

// ==========================================================================
// Surface 1 — Timeline
// ==========================================================================

describe("qwen error surfaces / Timeline", () => {
  it("derives exactly one tone:'error' row whose heading is the classified text", () => {
    const entries = deriveWorkLogEntries([makeFailedTaskActivity(TIMELINE_ERROR)]);

    expect(entries).toHaveLength(1);
    const row = entries[0]!;
    expect(row.tone).toBe("error");
    // The failed-task summary becomes the row heading verbatim.
    expect(row.label).toBe(TIMELINE_ERROR);
    expect(row.sourceActivityKind).toBe("task.completed");
  });

  it("also produces an error row for the runtime.error variant", () => {
    const entries = deriveWorkLogEntries([makeRuntimeErrorActivity(TIMELINE_ERROR)]);

    expect(entries).toHaveLength(1);
    const row = entries[0]!;
    expect(row.tone).toBe("error");
    expect(row.label).toBe(RUNTIME_ERROR_HEADING);
    expect(row.sourceActivityKind).toBe("runtime.error");
  });

  it("does NOT imply a notification banner (Timeline surface sets no session.lastError)", () => {
    // A Timeline decision emits an activity only; session.lastError stays null,
    // so the banner renders nothing and never carries the timeline text.
    const bannerMarkup = renderToStaticMarkup(<ThreadErrorBanner error={null} />);
    expect(bannerMarkup).toBe("");
    expect(bannerMarkup).not.toContain(TIMELINE_ERROR);
  });
});

// ==========================================================================
// Surface 2 — Notification (ThreadErrorBanner / session.lastError)
// ==========================================================================

describe("qwen error surfaces / Notification", () => {
  it("renders the exact error text in the banner's content column (#3017 guard)", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={NOTIFICATION_ERROR} />);

    expect(markup).toContain(NOTIFICATION_ERROR);
    expect(markup).toContain('data-slot="alert-description"');

    // Guard #3017: the AlertDescription (and its text) must live in the
    // width-constrained content column, after it opens — not back in the
    // narrow icon column where it would collapse to one letter per line.
    // ru-code: fixture rot fix (F2/F3) — Alert's icon-column class list changed
    // upstream (no longer contains the literal "size-4 shrink-0" substring);
    // "[&>svg]:size-4" is the stable marker of the icon column today.
    const iconColumnIndex = markup.indexOf("&gt;svg]:size-4");
    const contentColumnIndex = markup.indexOf("flex min-w-0 flex-1 flex-col");
    const descriptionIndex = markup.indexOf('data-slot="alert-description"');
    const errorIndex = markup.indexOf(NOTIFICATION_ERROR);

    expect(iconColumnIndex).toBeGreaterThanOrEqual(0);
    expect(contentColumnIndex).toBeGreaterThan(iconColumnIndex);
    expect(descriptionIndex).toBeGreaterThan(contentColumnIndex);
    expect(errorIndex).toBeGreaterThan(descriptionIndex);
  });

  it("renders nothing when session.lastError is null or empty", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
    expect(renderToStaticMarkup(<ThreadErrorBanner error="" />)).toBe("");
  });

  it("does NOT add a work-log error row (Notification surface emits no activity)", () => {
    // A Notification-only decision sets session.lastError but records no
    // orchestration activity, so the work log stays empty of error rows.
    const entries = deriveWorkLogEntries([]);
    expect(entries).toHaveLength(0);
    expect(entries.some((entry) => entry.tone === "error")).toBe(false);
  });
});

// ==========================================================================
// Surface 3 — Bubble (assistant chat message)
// ==========================================================================

describe("qwen error surfaces / Bubble", () => {
  it("renders the friendly assistant text as a chat message", async () => {
    const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(false)}
        timelineEntries={[assistantMessageTimelineEntry(BUBBLE_TEXT)]}
      />,
    );

    expect(markup).toContain(BUBBLE_TEXT);
  });

  it("does NOT surface as a banner or a work-log error row on its own", () => {
    // A Bubble-only decision streams assistant text; no lastError, no activity.
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).not.toContain(BUBBLE_TEXT);
    const entries = deriveWorkLogEntries([]);
    expect(entries.some((entry) => entry.tone === "error")).toBe(false);
  });
});

// ==========================================================================
// Surface 4 — Timeline survives turn-end (capability guard)
// ==========================================================================

describe("qwen error surfaces / Timeline persists after the turn ends", () => {
  it("keeps deriving the error row regardless of turn state (turn-independent)", () => {
    // deriveWorkLogEntries takes no turn-progress input: the error row exists
    // purely from the recorded activity, so it cannot be hidden by turn-end.
    const entries = deriveWorkLogEntries([makeFailedTaskActivity(TIMELINE_ERROR, "turn-1")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tone).toBe("error");
  });

  it("still renders the error row when the turn has settled (activeTurnInProgress:false)", async () => {
    const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");
    const settled = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(false)}
        timelineEntries={[errorWorkTimelineEntry(TIMELINE_ERROR)]}
      />,
    );
    const inProgress = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(true)}
        timelineEntries={[errorWorkTimelineEntry(TIMELINE_ERROR)]}
      />,
    );

    // turnSettled only toggles a status ICON; the error heading survives both.
    expect(settled).toContain(TIMELINE_ERROR);
    expect(inProgress).toContain(TIMELINE_ERROR);
  });
});

// ==========================================================================
// Surface 5 — Bubble + Timeline together (capability)
// ==========================================================================

describe("qwen error surfaces / Bubble + Timeline together", () => {
  it("renders BOTH the assistant bubble and the persistent error row for one turn", async () => {
    const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(false)}
        timelineEntries={[
          assistantMessageTimelineEntry(BUBBLE_TEXT),
          errorWorkTimelineEntry(TIMELINE_ERROR),
        ]}
      />,
    );

    expect(markup).toContain(BUBBLE_TEXT);
    expect(markup).toContain(TIMELINE_ERROR);
  });
});
