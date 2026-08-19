// ru-code: the provision→spawn→record ORDERING contract, tested against the REAL combinator the
// reactor delegates to (provisionThenSpawn) — not a fake of it. qwen reads a worktree's
// skills/agents/commands from `<cwd>/.qwen/*` only at spawn, so the reactor MUST mirror them in
// before the CLI starts and record what it loaded after. A spy gate + spy spawn record the exact
// interleaving; the assertions prove:
//   • provisionWorktree runs BEFORE spawn (spawn never fires until provisioning has settled)
//   • record runs AFTER spawn (the next turn's change-check gets a baseline)
//   • the target's threadId / projectId / cwd are forwarded verbatim to the gate
//   • the spawn's own return value is what the sequence yields
//
// This is the fork behavior the upstream reactor harness used to assert via `sessionsStartedBefore`.
// It lives here because the sequencing is a pure Effect combinator with no dependency on the
// orchestration engine — the reactor's cwd computation and its actual call of this combinator stay
// covered by the upstream ProviderCommandReactor tests (they drive the real reactor with the no-op
// gate, so a broken wrap fails them).
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { provisionThenSpawn } from "../../skills-agents/provisionThenSpawn.ts";
import { type SessionRespawnGateShape } from "../../skills-agents/SessionRespawnGate.ts";

/** A gate that appends a labelled entry to `log` for every call, so ordering is observable. */
const spyGate = (log: Array<string>): SessionRespawnGateShape => ({
  changedForThread: () => Effect.succeed(false),
  record: (threadId, projectId) =>
    Effect.sync(() => {
      log.push(`record:${threadId}:${String(projectId)}`);
    }),
  forget: () => Effect.void,
  provisionWorktree: (threadId, projectId, cwd) =>
    Effect.sync(() => {
      log.push(`provision:${threadId}:${String(projectId)}:${String(cwd)}`);
    }),
});

it.effect("provisions the worktree, then spawns, then records — in that exact order", () =>
  Effect.gen(function* () {
    const log: Array<string> = [];
    const gate = spyGate(log);

    const session = yield* provisionThenSpawn(
      gate,
      { threadId: "thread-wt", projectId: "project-1", cwd: "/tmp/provider-worktree" },
      () =>
        Effect.sync(() => {
          log.push("spawn");
          return { threadId: "thread-wt" as const };
        }),
    );

    // The gate provisioned this thread's exact cwd/project BEFORE the spawn fired, and recorded
    // AFTER it — the whole point of the wrap (parity with the old `sessionsStartedBefore: 0`).
    assert.deepStrictEqual(log, [
      "provision:thread-wt:project-1:/tmp/provider-worktree",
      "spawn",
      "record:thread-wt:project-1",
    ]);
    // The sequence yields the spawn's own value untouched.
    assert.deepStrictEqual(session, { threadId: "thread-wt" });
  }),
);

it.effect("forwards a null projectId / null cwd (main checkout) verbatim to the gate", () =>
  Effect.gen(function* () {
    const log: Array<string> = [];
    const gate = spyGate(log);

    yield* provisionThenSpawn(gate, { threadId: "thread-main", projectId: null, cwd: null }, () =>
      Effect.sync(() => {
        log.push("spawn");
        return {};
      }),
    );

    assert.deepStrictEqual(log, [
      "provision:thread-main:null:null",
      "spawn",
      "record:thread-main:null",
    ]);
  }),
);

it.effect("does not construct the spawn effect until provisioning has settled", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const gate: SessionRespawnGateShape = {
      changedForThread: () => Effect.succeed(false),
      record: () => Effect.void,
      forget: () => Effect.void,
      // A provision that yields on a fiber tick — if `spawn` were eager, its thunk body would
      // have run during argument evaluation, before this resolves.
      provisionWorktree: () =>
        Effect.sync(() => {
          events.push("provision");
        }).pipe(Effect.andThen(Effect.yieldNow)),
    };

    yield* provisionThenSpawn(gate, { threadId: "t", projectId: "p", cwd: "/wt" }, () =>
      Effect.sync(() => {
        events.push("spawn-constructed-and-run");
        return {};
      }),
    );

    assert.deepStrictEqual(events, ["provision", "spawn-constructed-and-run"]);
  }),
);
