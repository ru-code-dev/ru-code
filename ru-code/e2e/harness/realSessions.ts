// ru-code (extended-view redesign): the REAL qwen sessions the extended-view specs render.
//
// Byte-verbatim copies of the owner's transcripts (the same files the transcript-core
// goldens and the extended-chat fixture specs pin: 5eeb4968 sha256 03d7a7fb…, the two
// others from `tests/goldens/real/`), each with its `subagents/<session>/` tree. The fake
// ACP's `replay` knob (fake-acp-server.ts `FlowControl.replay`) streams a session into the
// fake-bound thread's transcript — instantly for a settled fixture, paced for the live
// states — and copies the agent tree under the fake session id so the on-demand agent flow
// attaches (`subagents.ts` readMeta identity check on `parentSessionId`).
//
// The FACTS below are the phase-1 / IMPL-P measurements the specs assert against
// (phase1-map-report.md §3/§5, impl-p-report.md §8): they describe the FILES, not the UI.
import * as NodePath from "node:path";

export interface RealSessionFixture {
  readonly id: string;
  /** Absolute path of the main transcript. */
  readonly file: string;
  /** Absolute path of the `subagents/<id>/` tree (agent transcripts + `.meta.json` sidecars). */
  readonly subagentsDir: string;
  /** The first user message (turn 1) — the "session rendered" predicate. */
  readonly firstUser: string;
  readonly records: number;
  readonly humanTurns: number;
  /** `agent` launches in the file (= agent cards in the view). */
  readonly agentLaunches: number;
}

const FIXTURES_ROOT = NodePath.resolve(import.meta.dirname, "../fixtures/sessions");

const fixture = (
  id: string,
  facts: Omit<RealSessionFixture, "id" | "file" | "subagentsDir">,
): RealSessionFixture => ({
  id,
  file: NodePath.join(FIXTURES_ROOT, id, "session.jsonl"),
  subagentsDir: NodePath.join(FIXTURES_ROOT, id, "subagents"),
  ...facts,
});

/** 154 records, 2 human turns, 5 background `fork` launches (2 cancelled → 2 relaunched),
 *  3 notifications, 3 `todo_write`, 1 compression. */
export const SESSION_5EEB = fixture("5eeb4968-c7ed-4708-9aa4-cf9e1549eee5", {
  firstUser: "run some agentic flow! multiple subagents doing something",
  records: 154,
  humanTurns: 2,
  agentLaunches: 5,
});

/** 130 records, 7 human turns, 6 launches (4 bg / 2 fg, 1 cancelled by the user), 2
 *  notifications, a mid-turn user message, 8 changed files (+281). */
export const SESSION_6C09 = fixture("6c096be2-0ae1-4af6-b39c-1b00255fa3d7", {
  firstUser: "run some agentic flow",
  records: 130,
  humanTurns: 7,
  agentLaunches: 6,
});

/** 156 records, 14 human turns, 11 launches (9 bg open, 1 cancelled, 1 interrupted), 3
 *  `todo_write` (turn 1 → turn 13 join by shared id "1"), 1 compression. */
export const SESSION_9388 = fixture("93888941-6933-456b-8636-4234f1afdf17", {
  firstUser: "run some agentic flow",
  records: 156,
  humanTurns: 14,
  agentLaunches: 11,
});

export const REAL_SESSIONS: ReadonlyArray<RealSessionFixture> = [
  SESSION_5EEB,
  SESSION_6C09,
  SESSION_9388,
];
