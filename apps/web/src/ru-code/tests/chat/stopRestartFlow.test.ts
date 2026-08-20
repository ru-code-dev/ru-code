// ru-code: warm-engine web contract (acp-process-pool §4.4). The server-side
// stop→restart flow (pinned end-to-end by stopThenNextTurnPipeline.e2e on the
// server) deliberately changed NO event vocabulary, so the web derivers must
// read the mirrored projection sequence exactly as before — plus the one NEW
// state the engine now produces early: session.status "starting" during the
// restart window, which must derive the "connecting" busy phase (the instant
// spinner of §2.2b). Pinned here over the pure derivers the chat surface
// renders from: isLatestTurnSettled (Stop↔Send flip), derivePhase (busy
// phase), deriveActiveWorkStartedAt (fresh timer) and deriveTimelineEntries
// (no orphaned/dropped rows across the whole flow).
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntries,
  isLatestTurnSettled,
  type TimelineEntry,
} from "../../../session-logic";
import type { ThreadSession } from "../../../types";

const THREAD_ID = "stop-restart-thread" as never;
const TURN_1 = "turn-1" as never;
const TURN_2 = "turn-2" as never;

const T0 = "2026-05-01T10:00:00.000Z";
const T1_STARTED = "2026-05-01T10:00:01.000Z";
const T1_STOPPED = "2026-05-01T10:00:05.000Z";
const T2_SENT = "2026-05-01T10:00:06.000Z";
const T2_STARTED = "2026-05-01T10:00:07.000Z";
const T2_COMPLETED = "2026-05-01T10:00:12.000Z";

function makeSession(
  status: ThreadSession["status"],
  activeTurnId: unknown,
  updatedAt: string,
): ThreadSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "qwen",
    runtimeMode: "approval-required",
    activeTurnId: activeTurnId as never,
    lastError: null,
    updatedAt,
  };
}

const messageEntry = (
  id: string,
  role: "user" | "assistant",
  createdAt: string,
  turnId: unknown,
): TimelineEntry => ({
  id: `${id}-entry`,
  kind: "message",
  createdAt,
  message: {
    id: id as never,
    role,
    text: `${id} text`,
    turnId: turnId as never,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
  },
});

describe("stop → restart → next turn (warm engine flow, §4.3 projection mirror)", () => {
  it("mid-turn 1: the turn is unsettled (Stop button) and the phase is running", () => {
    const session = makeSession("running", TURN_1, T1_STARTED);
    const latestTurn = { turnId: TURN_1, startedAt: T1_STARTED, completedAt: null };
    expect(isLatestTurnSettled(latestTurn, session)).toBe(false);
    expect(derivePhase(session)).toBe("running");
  });

  it("after Stop: the interrupted turn settles instantly (Send button back), no running residue", () => {
    // Mirrors the pipeline projection after thread.turn.interrupt:
    // latestTurn interrupted with completedAt, session stopped, activeTurn null.
    const session = makeSession("stopped", null, T1_STOPPED);
    const latestTurn = { turnId: TURN_1, startedAt: T1_STARTED, completedAt: T1_STOPPED };
    expect(isLatestTurnSettled(latestTurn, session)).toBe(true);
    expect(derivePhase(session)).toBe("disconnected");
  });

  it("restart window: session.status 'starting' derives the CONNECTING busy phase (§2.2b spinner)", () => {
    // The warm engine emits session.state.changed{starting} the moment the
    // next message spawns/binds — ingestion maps it to status "starting".
    const session = makeSession("starting", null, T2_SENT);
    expect(derivePhase(session)).toBe("connecting");
    // The previous (interrupted) turn stays settled — the send stays usable.
    const latestTurn = { turnId: TURN_1, startedAt: T1_STARTED, completedAt: T1_STOPPED };
    expect(isLatestTurnSettled(latestTurn, session)).toBe(true);
  });

  it("turn 2 runs as a FRESH turn: unsettled, running phase, its own timer", () => {
    const session = makeSession("running", TURN_2, T2_STARTED);
    const latestTurn = { turnId: TURN_2, startedAt: T2_STARTED, completedAt: null };
    expect(isLatestTurnSettled(latestTurn, session)).toBe(false);
    expect(derivePhase(session)).toBe("running");
    // The working timer starts from turn 2's own start — never from the
    // stopped turn 1 (a bleed here would show a wrong «working for …»).
    expect(deriveActiveWorkStartedAt(latestTurn, session, T2_SENT)).toBe(T2_STARTED);
  });

  it("turn 2 completes: settled, ready phase", () => {
    const session = makeSession("ready", null, T2_COMPLETED);
    const latestTurn = { turnId: TURN_2, startedAt: T2_STARTED, completedAt: T2_COMPLETED };
    expect(isLatestTurnSettled(latestTurn, session)).toBe(true);
    expect(derivePhase(session)).toBe("ready");
  });

  it("the whole flow's timeline keeps every row, ordered, with no orphans", () => {
    const entries = [
      messageEntry("user-1", "user", T0, null),
      messageEntry("assistant-1", "assistant", T1_STARTED, TURN_1),
      messageEntry("user-2", "user", T2_SENT, null),
      messageEntry("assistant-2", "assistant", T2_STARTED, TURN_2),
    ];
    const timeline = deriveTimelineEntries(
      entries.map((entry) => (entry.kind === "message" ? entry.message : (null as never))),
      [],
      [],
    );
    expect(timeline).toHaveLength(4);
    expect(timeline.map((row) => row.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    // Chronological order survives the stop/restart boundary.
    const createdAts = timeline.map((row) => row.createdAt);
    expect([...createdAts].sort()).toEqual(createdAts);
  });
});
