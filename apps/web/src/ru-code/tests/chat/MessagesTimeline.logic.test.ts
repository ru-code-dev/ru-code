// ru-code: render-layer half of the live 17:23 report ("after a compression
// the reply never appears") — the timeline-row composite must keep a settled
// turn's TERMINAL assistant message visible in every post-compaction shape:
// compaction rows are turn-less, so they must neither join a turn's fold nor
// drag the reply into hiding. Also pins the legacy shape (assistant with a
// NULLED turnId — pre-fix persisted threads): never folded away.
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../../../session-logic";

const T2 = "8e10f236-d7a8-4076-9782-6dcb33be3a00" as never;

function userEntry(id: string, createdAt: string, text: string): TimelineEntry {
  return {
    id: `${id}-entry`,
    kind: "message",
    createdAt,
    message: {
      id: id as never,
      role: "user",
      text,
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

function assistantEntry(
  id: string,
  createdAt: string,
  text: string,
  turnId: unknown,
): TimelineEntry {
  return {
    id: `${id}-entry`,
    kind: "message",
    createdAt,
    message: {
      id: id as never,
      role: "assistant",
      text,
      turnId: turnId as never,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

/** The compaction rows the work log derives — turn-less, info tone. */
function compactionEntry(id: string, createdAt: string, label: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id,
      createdAt,
      turnId: null,
      label,
      tone: "info",
      isContextCompaction: true,
    },
  };
}

function visibleMessageTexts(rows: ReturnType<typeof deriveMessagesTimelineRows>): string[] {
  return rows
    .filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message",
    )
    .map((row) => row.message.text);
}

describe("post-compaction timeline visibility", () => {
  it("the reply of the turn AFTER two compaction rows renders (settled latest turn)", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("user-1", "2026-01-01T00:00:00Z", "старт"),
        assistantEntry("assistant-1", "2026-01-01T00:00:05Z", "ок", "turn-1"),
        compactionEntry("compact-1", "2026-01-01T00:01:00Z", "Контекст уплотнён (15142 → 15283)"),
        compactionEntry("compact-2", "2026-01-01T00:02:00Z", "Контекст уплотнён (15142 → 15236)"),
        userEntry("user-2", "2026-01-01T00:03:00Z", "привет"),
        assistantEntry("assistant-2", "2026-01-01T00:03:05Z", "Привет! 👋", T2),
      ],
      latestTurn: {
        turnId: T2,
        state: "completed",
        requestedAt: "2026-01-01T00:03:00Z",
        startedAt: "2026-01-01T00:03:00Z",
        completedAt: "2026-01-01T00:03:06Z",
      } as never,
      runningTurnId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const texts = visibleMessageTexts(rows);
    expect(texts).toContain("привет");
    expect(texts).toContain("Привет! 👋");
  });

  it("a legacy reply with a NULLED turnId still renders after compaction rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("user-1", "2026-01-01T00:00:00Z", "старт"),
        compactionEntry("compact-1", "2026-01-01T00:01:00Z", "Контекст уплотнён"),
        userEntry("user-2", "2026-01-01T00:03:00Z", "привет"),
        assistantEntry("assistant-2", "2026-01-01T00:03:05Z", "Привет! 👋", null),
      ],
      latestTurn: null,
      runningTurnId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(visibleMessageTexts(rows)).toContain("Привет! 👋");
  });

  it("control: with work rows in the turn, the fold hides the work but never the reply", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("user-2", "2026-01-01T00:03:00Z", "привет"),
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:03:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:03:02Z",
            turnId: T2,
            label: "Читаю файл",
            tone: "tool",
          },
        },
        assistantEntry("assistant-2", "2026-01-01T00:03:05Z", "Привет! 👋", T2),
      ],
      latestTurn: {
        turnId: T2,
        state: "completed",
        requestedAt: "2026-01-01T00:03:00Z",
        startedAt: "2026-01-01T00:03:00Z",
        completedAt: "2026-01-01T00:03:06Z",
      } as never,
      runningTurnId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const texts = visibleMessageTexts(rows);
    expect(texts).toContain("Привет! 👋");
    // The tool row folds behind the "Worked for" anchor.
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(true);
  });
});
