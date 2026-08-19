// ru-code: the (re)spawn sequence the reactor runs for EVERY provider session start.
//
// qwen reads a project's skills/agents/commands from `<cwd>/.qwen/*` only at spawn, and the
// catalogs write them only to the project's main workspaceRoot — so when the thread's cwd is a
// git worktree, its `.qwen` copies must be mirrored in BEFORE the CLI process starts, and the
// fingerprints that spawn loaded must be recorded AFTER, so the next turn's change-check has a
// baseline. That is three effects in a fixed order:
//
//   provisionWorktree(cwd)  →  spawn()  →  record()
//
// The reactor used to inline this pipe; it now delegates here so the ordering (and the arg
// plumbing) is owned + unit-tested in the ru-code zone (see provisionThenSpawn.test.ts) instead
// of only through the upstream reactor integration harness. The reactor supplies the gate, the
// target, and the spawn thunk; nothing else about the spawn changes.
import * as Effect from "effect/Effect";

import { type RespawnProjectId, type SessionRespawnGateShape } from "./SessionRespawnGate.ts";

export interface ProvisionThenSpawnTarget {
  readonly threadId: string;
  readonly projectId: RespawnProjectId;
  /** The session's effective cwd (worktree path when set, else the project root); null ⇒ none. */
  readonly cwd: string | null;
}

/**
 * Provision the thread's worktree, THEN run `spawn`, THEN record the spawned-with fingerprints —
 * returning the spawn's own value. `spawn` is a THUNK: the session-start effect must not even be
 * constructed until `provisionWorktree` has settled (this ordering is the whole contract). The
 * gate methods are best-effort and never fail, so this adds no new error channel to the spawn.
 */
export const provisionThenSpawn = <A, E, R>(
  gate: SessionRespawnGateShape,
  target: ProvisionThenSpawnTarget,
  spawn: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  gate.provisionWorktree(target.threadId, target.projectId, target.cwd).pipe(
    Effect.andThen(spawn),
    Effect.tap(() => gate.record(target.threadId, target.projectId)),
  );
