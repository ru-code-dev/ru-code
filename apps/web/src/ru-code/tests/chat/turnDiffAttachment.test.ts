// ru-code: the sometimes-no-diff-in-chat contract, render half. A checkpoint
// can reach the client carrying the SYNTHETIC `assistant:<turnId>` id (the
// CheckpointReactor capture fallback) — an id no rendered message row ever
// carries. The message-first/checkpoint-after ordering persists it in BOTH
// projections (see checkpointAssistantIdRace.test.ts server-side and
// threadReducer-checkpoint-attachment.repro.test.ts client-side), and a lost
// rebind event (the subscribe attach gap) leaves it live too. The render layer
// is the last line of defense: a summary whose id matches no message must
// attach via its turnId to the turn's terminal assistant message. The INTENDED
// cases pin that recovery and FAIL on current code; the control passes.
import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveRevertTurnCountByUserMessageId,
  deriveTurnDiffSummaryByAssistantMessageId,
} from "../../chat/turnDiffAttachment";
import type { TimelineEntry } from "../../../session-logic";
import type { TurnDiffSummary } from "../../../types";

// Real wire shapes: turn ids are UUIDs (the synthetic classifier matches
// `assistant:<uuid>` exactly), real qwen message ids are
// `assistant:assistant:<sessionId>:r<nonce>:segment:N`.
const TURN = TurnId.make("8e10f236-d7a8-4076-9782-6dcb33be3a00");
const USER_MESSAGE = MessageId.make("user-1");
const ASSISTANT_MESSAGE = MessageId.make(
  "assistant:assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:0",
);

const summaryWith = (assistantMessageId: MessageId): TurnDiffSummary => ({
  turnId: TURN,
  checkpointTurnCount: 3,
  checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-1/3"),
  status: "ready",
  files: [{ path: "hello-123.md", kind: "modified", additions: 1, deletions: 0 }],
  assistantMessageId,
  completedAt: "2026-03-01T00:00:10.000Z",
});

const message = (
  id: MessageId,
  role: "user" | "assistant",
  createdAt: string,
  options?: { readonly turnId: TurnId | null },
): TimelineEntry => ({
  id: `entry-${id}`,
  kind: "message",
  createdAt,
  message: {
    id,
    role,
    text: role === "user" ? "создай файл hello-123.md" : "Готово: файл создан.",
    turnId: options !== undefined ? options.turnId : role === "assistant" ? TURN : null,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
  } as never,
});

const TIMELINE: ReadonlyArray<TimelineEntry> = [
  message(USER_MESSAGE, "user", "2026-03-01T00:00:00.000Z"),
  message(ASSISTANT_MESSAGE, "assistant", "2026-03-01T00:00:09.000Z"),
];

describe("turn diff chip + revert attachment", () => {
  it("control: a summary carrying the real assistant message id attaches chip and revert", () => {
    const byMessageId = deriveTurnDiffSummaryByAssistantMessageId(
      [summaryWith(ASSISTANT_MESSAGE)],
      TIMELINE,
    );
    expect(byMessageId.get(ASSISTANT_MESSAGE)).toBeDefined();

    const revert = deriveRevertTurnCountByUserMessageId({
      timelineEntries: TIMELINE,
      turnDiffSummaryByAssistantMessageId: byMessageId,
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(revert.get(USER_MESSAGE)).toBe(2);
  });

  it("a synthetic checkpoint id still attaches the chip via the turn's assistant message", () => {
    // The server-side race fallback: `assistant:<turnId>` matches no row. The
    // timeline still contains the turn's real assistant message — the
    // derivation resolves the summary onto it by turnId (this also heals OLD
    // threads whose checkpoints persisted the synthetic id).
    const syntheticSummary = summaryWith(MessageId.make(`assistant:${TURN}`));
    const byMessageId = deriveTurnDiffSummaryByAssistantMessageId([syntheticSummary], TIMELINE);
    expect(
      byMessageId.get(ASSISTANT_MESSAGE),
      "the turn's diff exists (Diff panel shows it) but the chat chip lookup misses — must fall back by turnId",
    ).toBeDefined();
  });

  it("revert stays available for a synthetic checkpoint id", () => {
    const syntheticSummary = summaryWith(MessageId.make(`assistant:${TURN}`));
    const revert = deriveRevertTurnCountByUserMessageId({
      timelineEntries: TIMELINE,
      turnDiffSummaryByAssistantMessageId: deriveTurnDiffSummaryByAssistantMessageId(
        [syntheticSummary],
        TIMELINE,
      ),
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(revert.get(USER_MESSAGE)).toBe(2);
  });

  it("a summary whose id and turn match nothing rendered attaches nowhere (no phantom chips)", () => {
    const foreignSummary = {
      ...summaryWith(MessageId.make("assistant:ffffffff-ffff-4fff-8fff-ffffffffffff")),
      turnId: TurnId.make("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    };
    const byMessageId = deriveTurnDiffSummaryByAssistantMessageId([foreignSummary], TIMELINE);
    expect(byMessageId.size).toBe(0);
  });

  it("old clobbered data: message turnId nulled but the summary carries the REAL id — direct attach still works", () => {
    // Threads persisted before the turn-attribution fix carry assistant
    // messages whose turnId was wiped to null. The chip lookup is by MESSAGE
    // id first, so a checkpoint holding the real id must still attach.
    const nulledTurnTimeline: ReadonlyArray<TimelineEntry> = [
      message(USER_MESSAGE, "user", "2026-03-01T00:00:00.000Z"),
      message(ASSISTANT_MESSAGE, "assistant", "2026-03-01T00:00:09.000Z", { turnId: null }),
    ];
    const byMessageId = deriveTurnDiffSummaryByAssistantMessageId(
      [summaryWith(ASSISTANT_MESSAGE)],
      nulledTurnTimeline,
    );
    expect(byMessageId.get(ASSISTANT_MESSAGE)).toBeDefined();
  });
});
