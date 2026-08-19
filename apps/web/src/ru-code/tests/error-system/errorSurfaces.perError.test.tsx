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

import { APP_HOME_SLUG, CLI_DISPLAY_NAME } from "@ru-code/branding";

import { ThreadErrorBanner } from "../../../components/chat/ThreadErrorBanner";
import { deriveWorkLogEntries } from "../../../session-logic";

// ==========================================================================
// PER-ERROR surface proof.
//
// Every qwen error outcome the server classifier (`apps/server/src/ru-code/
// qwen/errors/recognizers.ts`) can emit is listed below with the EXACT
// surface subset it projects and its EXACT text (hard-copied from
// that file — the web can't import the server recognizers). For each row we
// reconstruct the projection shape the error produces, then drive the THREE
// real web surfaces and assert the target surface(s) render the exact text
// AND every other surface renders NOTHING of it:
//
//   Bubble       -> an assistant chat message (content.delta) rendered by
//                   MessagesTimeline (marker: data-message-role="assistant").
//   Timeline     -> a tone:"error" work-log row from deriveWorkLogEntries,
//                   built from a failed task.completed activity.
//   Notification -> the red ThreadErrorBanner driven by session.lastError.
//
// The whole point is "no unexpected surfaces": each row asserts present ✓ for
// its target(s) and absent ✗ for the rest.
// ==========================================================================

type Surface = "bubble" | "timeline" | "notification";
const BUBBLE: Surface = "bubble";
const TIMELINE: Surface = "timeline";
const NOTIFICATION: Surface = "notification";

interface ErrorCase {
  /** Recognizer id (A1, B1.41, unrecognized, …) — the `it` label. */
  readonly id: string;
  /** The exact surface subset this error's projection sets. */
  readonly surfaces: ReadonlyArray<Surface>;
  /** Classified text on the failed-task summary (Timeline heading) AND the
   *  banner text (Notification). For a Bubble-only error this is the friendly
   *  assistant text; for the synthetic combo the Timeline text (see bubbleText). */
  readonly text: string;
  /** Overrides the Bubble text when it differs from `text` (combo only). */
  readonly bubbleText?: string;
  /** Substrings that must appear in the rendered bubble. Defaults to the whole
   *  bubbleText; overridden when Markdown rendering transforms the raw text
   *  (A7 carries a code span + bullet list). */
  readonly bubbleFragments?: ReadonlyArray<string>;
  readonly note?: string;
}

// --------------------------------------------------------------------------
// EXACT classified strings, kept in lockstep with recognizers.ts by sharing its
// CLI_DISPLAY_NAME source of truth (no literal "Cli" copy). The A7 context file
// ("QWEN.md") comes from the profile artifact, independent of CLI_DISPLAY_NAME.
// --------------------------------------------------------------------------

// A7's SLASH_UNSUPPORTED_TEXT is a joined multi-line Markdown bullet list.
const A7_TEXT = [
  "⚠️ The command could not be run.",
  "",
  "Possible causes and fixes:",
  "- The file `QWEN.md` already exists — delete it and retry.",
].join("\n");

// A3 interpolates the RPC `data.details`; we feed a representative detail.
const A3_DETAIL = "upstream returned 500";
const A3_TEXT = `⚠️ ${CLI_DISPLAY_NAME} returned an error: ${A3_DETAIL}. Try sending the message again.`;

// Z surfaces a clean ProviderAdapterRequestError.detail verbatim; representative.
const Z_DETAIL = "Upstream service unavailable (503)";

// C4's transport text — C1 collapses onto it (see the C1 row's note).
const C4_TEXT = `Connection to ${CLI_DISPLAY_NAME} lost. Send a message to reconnect.`;

const CASES: ReadonlyArray<ErrorCase> = [
  // ---- Bubble-only (A1, A2, A3, A7) -------------------------------------
  {
    id: "A1",
    surfaces: [BUBBLE],
    text: '⚠️ The model returned an empty response. Try sending "continue" — that sometimes works.',
    // Markdown/HTML-escapes the straight quotes around "continue" to &quot;, so
    // assert the surviving prose fragments rather than the raw quoted string.
    bubbleFragments: [
      "⚠️ The model returned an empty response.",
      "Try sending",
      "continue",
      "— that sometimes works.",
    ],
  },
  {
    id: "A2",
    surfaces: [BUBBLE],
    text: "⚠️ Too many requests. Wait a minute and send the message again.",
  },
  {
    id: "A3",
    surfaces: [BUBBLE],
    text: A3_TEXT,
  },
  {
    id: "A7",
    surfaces: [BUBBLE],
    text: A7_TEXT,
    // Markdown turns the code span + bullet into HTML, so assert the surviving
    // prose fragments rather than the raw joined string.
    bubbleFragments: [
      "The command could not be run",
      "Possible causes and fixes",
      "QWEN.md",
      "already exists — delete it and retry",
    ],
  },

  // ---- Timeline-only (A4, A6, E, D1, D2, D3) ----------------------------
  {
    id: "A4",
    surfaces: [TIMELINE],
    text: `Internal ${CLI_DISPLAY_NAME} protocol error. See the server log for details.`,
  },
  {
    id: "A6",
    surfaces: [TIMELINE],
    text: `${CLI_DISPLAY_NAME} resource not found. Send a message to continue.`,
  },
  {
    id: "E",
    surfaces: [TIMELINE],
    text: "An unexpected server error occurred. See the log for details.",
  },
  {
    id: "D1",
    surfaces: [TIMELINE],
    text: "Internal request-validation error. See the server log for details.",
  },
  {
    id: "D2",
    surfaces: [TIMELINE],
    text: `${CLI_DISPLAY_NAME} session not found. Send a message to reconnect.`,
  },
  {
    id: "D3",
    surfaces: [TIMELINE],
    text: "Internal provider error. See the server log for details.",
  },

  // ---- Timeline + Notification -----------------------------------------
  {
    id: "A5",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `${CLI_DISPLAY_NAME} authorization required. Restart the app.`,
  },
  {
    id: "C4",
    surfaces: [TIMELINE, NOTIFICATION],
    text: C4_TEXT,
  },
  {
    id: "C1",
    surfaces: [TIMELINE, NOTIFICATION],
    // Documented collapse: C1 shares C4's transport surface + wire shape, so the
    // UI-level test asserts C4's text for the C1 outcome (recognizers.ts C1 also
    // notes C2/C3 fold onto C4). Timeline+Notification, same as C4.
    text: C4_TEXT,
    note: "C1 collapses onto C4's text",
  },
  {
    id: "Z (request-error)",
    surfaces: [TIMELINE, NOTIFICATION],
    // Z surfaces the RequestError.detail verbatim.
    text: Z_DETAIL,
  },
  {
    id: "unrecognized",
    surfaces: [TIMELINE, NOTIFICATION],
    text: "An unexpected error occurred. See the server log for details.",
  },
  {
    id: "B1.41",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: authorization required. Send a message to restart the session.`,
  },
  {
    id: "B1.42",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: invalid input. Send a message to restart the session.`,
  },
  {
    id: "B1.44",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: sandbox error. Send a message to restart the session.`,
  },
  {
    id: "B1.52",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: configuration error. Send a message to restart the session.`,
  },
  {
    id: "B1.53",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: turn limit reached. Send a message to restart the session.`,
  },
  {
    id: "B1.54",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended: tool error. Send a message to restart the session.`,
  },
  {
    id: "B1.130",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session was interrupted. Send a message to continue.`,
  },
  {
    id: "B1.generic (unknown exit code 99)",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} session ended (code 99). Send a message to restart the session.`,
  },
  {
    // ru-code: B2 = process exit with NO readable code (recognizers.ts fatalText,
    // exitCode === undefined). Not wire-inducible from a running agent, so this
    // per-error surface proof is its only end-to-end check besides pure classify.
    id: "B2 (exit, no readable code)",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `The ${CLI_DISPLAY_NAME} process exited unexpectedly. Send a message to restart the session.`,
  },
  {
    id: "B3",
    surfaces: [TIMELINE, NOTIFICATION],
    text: `Could not start the ${CLI_DISPLAY_NAME} process. Check the installation (run \`${APP_HOME_SLUG}\` again).`,
  },

  // ---- Synthetic Bubble + Timeline combo --------------------------------
  {
    id: "combo (Bubble + Timeline)",
    surfaces: [BUBBLE, TIMELINE],
    text: "Qwen provider hit a protocol error",
    bubbleText: "Извините, произошёл сбой при обработке запроса Qwen.",
  },
];

// ==========================================================================
// Projection builders (mirror session-logic.test.ts / the sibling web test).
// ==========================================================================

let nextActivityId = 0;

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

// The server's Timeline decision: a failed `task.completed` whose summary is
// the classified text (tone "error"). The classified text also rides `detail`
// so `deriveWorkLogEntries` lifts it to the row heading verbatim.
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

// The only DOM marker unique to an assistant chat bubble; work rows omit the
// data-message-role attribute entirely (MessagesTimeline.tsx:464).
const ASSISTANT_BUBBLE_MARKER = 'data-message-role="assistant"';

// ==========================================================================
// The per-error assertion — present ✓ for target surface(s), absent ✗ for the
// rest — driven through the REAL web functions.
// ==========================================================================

describe("qwen error surfaces / per-error surface exactness", () => {
  for (const errorCase of CASES) {
    it(`${errorCase.id} renders EXACTLY ${errorCase.surfaces.join("+")} and nothing else`, async () => {
      const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");

      const hasBubble = errorCase.surfaces.includes(BUBBLE);
      const hasTimeline = errorCase.surfaces.includes(TIMELINE);
      const hasNotification = errorCase.surfaces.includes(NOTIFICATION);
      const bubbleText = errorCase.bubbleText ?? errorCase.text;
      const bubbleFragments = errorCase.bubbleFragments ?? [bubbleText];

      // The projection this error produces.
      const activities = hasTimeline ? [makeFailedTaskActivity(errorCase.text)] : [];
      const lastError: string | null = hasNotification ? errorCase.text : null;

      // ---- Surface 1: Timeline (deriveWorkLogEntries) --------------------
      const entries = deriveWorkLogEntries(activities);
      const errorRows = entries.filter((entry) => entry.tone === "error");
      if (hasTimeline) {
        expect(errorRows).toHaveLength(1);
        expect(errorRows[0]!.label).toBe(errorCase.text);
        expect(errorRows[0]!.sourceActivityKind).toBe("task.completed");
      } else {
        // ✗ absent: no error work-log row at all.
        expect(errorRows).toHaveLength(0);
      }

      // ---- Surface 2: Notification (ThreadErrorBanner) -------------------
      const bannerMarkup = renderToStaticMarkup(<ThreadErrorBanner error={lastError} />);
      if (hasNotification) {
        expect(bannerMarkup).toContain(errorCase.text);
        expect(bannerMarkup).toContain('data-slot="alert-description"');
      } else {
        // ✗ absent: lastError is null → banner renders literally nothing.
        expect(bannerMarkup).toBe("");
        expect(bannerMarkup).not.toContain(errorCase.text);
      }

      // ---- Surface 3: Bubble (assistant chat message) --------------------
      // Render MessagesTimeline over the error's projection: the assistant
      // message iff Bubble is a target, plus the persistent error row iff
      // Timeline is a target. The assistant marker proves presence/absence.
      const timelineEntries = [
        ...(hasBubble ? [assistantMessageTimelineEntry(bubbleText)] : []),
        ...(hasTimeline ? [errorWorkTimelineEntry(errorCase.text)] : []),
      ];
      const markup = renderToStaticMarkup(
        <MessagesTimeline {...buildTimelineProps(false)} timelineEntries={timelineEntries} />,
      );
      if (hasBubble) {
        expect(markup).toContain(ASSISTANT_BUBBLE_MARKER);
        for (const fragment of bubbleFragments) {
          expect(markup).toContain(fragment);
        }
      } else {
        // ✗ absent: no assistant chat bubble is rendered for this error (the
        // Timeline work row carries the text instead, asserted above).
        expect(markup).not.toContain(ASSISTANT_BUBBLE_MARKER);
      }
    });
  }
});

// ==========================================================================
// Capability guard — the Timeline error row survives turn-end (settled AND
// in-progress), independent of turn state (kept from the sibling test).
// ==========================================================================

describe("qwen error surfaces / Timeline row survives turn-end", () => {
  const TIMELINE_TEXT = `Internal ${CLI_DISPLAY_NAME} protocol error. See the server log for details.`;

  it("keeps deriving the error row regardless of turn (turn-independent input)", () => {
    const entries = deriveWorkLogEntries([makeFailedTaskActivity(TIMELINE_TEXT, "turn-1")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tone).toBe("error");
    expect(entries[0]!.label).toBe(TIMELINE_TEXT);
  });

  it("renders the error row heading whether the turn settled (false) or is in progress (true)", async () => {
    const { MessagesTimeline } = await import("../../../components/chat/MessagesTimeline");
    const settled = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(false)}
        timelineEntries={[errorWorkTimelineEntry(TIMELINE_TEXT)]}
      />,
    );
    const inProgress = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(true)}
        timelineEntries={[errorWorkTimelineEntry(TIMELINE_TEXT)]}
      />,
    );

    expect(settled).toContain(TIMELINE_TEXT);
    expect(inProgress).toContain(TIMELINE_TEXT);
  });
});
