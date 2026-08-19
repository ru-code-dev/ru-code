// ru-code: the session-respawn gate. qwen reads skills and subagents ONLY at spawn, so
// when a thread's EFFECTIVE skill or agent set changes, the live `qwen --acp` session must
// re-spawn on the next user message (with the prior resumeCursor, history preserved).
//
// This service is the reactor's single seam for that decision: the reactor imports ONLY
// `SessionRespawnGate` (never SkillCatalog / AgentCatalog directly). Per turn it asks
// `changedForThread(threadId, projectId)` — true ⇒ OR it into the restart decision — and
// on each (re)spawn calls `record(threadId, projectId)` to remember what that spawn loaded.
// `forget(threadId)` drops a thread's record on session stop (see the tracker for why the
// store's lifetime is the session's, not a TTL).
//
// The gate owns one SessionFingerprintTracker instance (skills + agents), fingerprints the
// effective sets best-effort (a catalog read failure ⇒ that source is skipped this turn, so
// a transient failure never triggers a spurious respawn), and provides its own SkillCatalog
// + AgentCatalog dependencies — the reactor only provides `SessionRespawnGateLive`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SkillCatalog } from "@smart-tools/qwen-cli-skill-manager/server";
import { AgentCatalog } from "@smart-tools/qwen-cli-agents-manager/server";
import { CommandCatalog } from "@smart-tools/qwen-cli-commands-manager/server";

import {
  SkillCatalogHostLayer,
  AgentCatalogHostLayer,
  CommandCatalogHostLayer,
} from "./catalogLayers.ts";
import {
  makeSessionFingerprintTracker,
  type CurrentFingerprints,
} from "./SessionFingerprintTracker.ts";

// ru-code: leak backstop for the tracker (skills + agents). Not a TTL — entries live as long
// as the process / until this many distinct threads accumulate, whichever comes first; a
// process restart resets it. Effectively unreachable for a single user, and eviction is safe
// (an evicted entry ⇒ one harmless respawn next turn).
const SESSION_FINGERPRINT_CAPACITY = 10_000;

/**
 * `projectId` type matches what the catalogs' `fingerprintForProject` expects — `string |
 * null` (`null` ⇒ globals only). The reactor's `thread.projectId` (a branded ProjectId) is
 * assignable here.
 */
export type RespawnProjectId = string | null;

export interface SessionRespawnGateShape {
  /**
   * Fingerprint this thread's effective skill + agent sets and report whether either now
   * differs from what the live session spawned with. Best-effort: a catalog read failure is
   * logged and treated as "unchanged for that source" (no spurious respawn). Never fails.
   */
  readonly changedForThread: (
    threadId: string,
    projectId: RespawnProjectId,
  ) => Effect.Effect<boolean>;
  /**
   * Record the effective skill + agent fingerprints this (re)spawn loaded, so the next
   * turn's `changedForThread` compares against them. Best-effort per source; never fails.
   */
  readonly record: (threadId: string, projectId: RespawnProjectId) => Effect.Effect<void>;
  /** Drop a thread's record on session stop / teardown. Idempotent; never fails. */
  readonly forget: (threadId: string) => Effect.Effect<void>;
  /**
   * Mirror the project's skills/agents/commands into `cwd` when it is a git worktree.
   * qwen reads project items from `<cwd>/.qwen/*` at spawn, but the catalogs only ever
   * write the project's main workspaceRoot — so a worktree session would see a stale git
   * snapshot (or nothing). Called right before every (re)spawn; the engines detect per
   * item (write only missing/stale) and no-op when `cwd` IS the main workspaceRoot.
   * Best-effort: a failure is logged and the session spawns with the checkout's snapshot.
   * Never fails.
   */
  readonly provisionWorktree: (
    threadId: string,
    projectId: RespawnProjectId,
    cwd: string | null,
  ) => Effect.Effect<void>;
}

export class SessionRespawnGate extends Context.Service<
  SessionRespawnGate,
  SessionRespawnGateShape
>()("t3/ru-code/skills-agents/SessionRespawnGate") {}

const makeSessionRespawnGate = Effect.gen(function* () {
  // ru-code: the Skills Manager catalog. qwen reads skills at spawn, so a skill
  // add/remove/sync respawns the live session on the next turn.
  const skillCatalog = yield* SkillCatalog;
  // ru-code: the Agents Manager catalog — same role for subagents, also read at spawn.
  const agentCatalog = yield* AgentCatalog;
  // ru-code: the Commands Manager catalog — qwen reads custom slash commands at spawn too.
  const commandCatalog = yield* CommandCatalog;

  const tracker = makeSessionFingerprintTracker({ capacity: SESSION_FINGERPRINT_CAPACITY });

  // ru-code: fingerprint the effective skill + agent sets for a thread's project. Each read
  // is best-effort — a failure is logged and yields `undefined`, which the tracker ignores
  // (no spurious respawn, no poisoning of the recorded set). Global scope ⇒ `projectId: null`.
  const fingerprintForThread = (
    threadId: string,
    projectId: RespawnProjectId,
  ): Effect.Effect<CurrentFingerprints> =>
    Effect.gen(function* () {
      const skills = yield* skillCatalog
        .fingerprintForProject({ projectId })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError(
              "[ru-code-skillCatalog] skill fingerprint failed — skipping respawn gate",
              { threadId, cause },
            ).pipe(Effect.as(undefined)),
          ),
        );
      const agents = yield* agentCatalog
        .fingerprintForProject({ projectId })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError(
              "[ru-code-agentCatalog] agent fingerprint failed — skipping respawn gate",
              { threadId, cause },
            ).pipe(Effect.as(undefined)),
          ),
        );
      const commands = yield* commandCatalog
        .fingerprintForProject({ projectId })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError(
              "[ru-code-commandCatalog] command fingerprint failed — skipping respawn gate",
              { threadId, cause },
            ).pipe(Effect.as(undefined)),
          ),
        );
      return { skills, agents, commands };
    });

  const changedForThread: SessionRespawnGateShape["changedForThread"] = (threadId, projectId) =>
    Effect.gen(function* () {
      const current = yield* fingerprintForThread(threadId, projectId);
      const changed = tracker.changedSources(threadId, current);
      // ru-code: surface WHY a respawn was triggered — which sources changed (skills / agents) and the
      // spawned-with vs current fingerprints — so a catalog-driven respawn is visible in the logs
      // (parity with the prior project's restart log). Debug level: it's a per-turn trace.
      if (changed.length > 0) {
        yield* Effect.logDebug("[ru-code-respawn] catalog change → provider session respawn", {
          threadId,
          projectId, // null ⇒ globals only
          changedSources: changed, // e.g. ["skills"] / ["agents"] / ["skills","agents"]
          spawnedWith: tracker.peek(threadId), // fingerprints the live session spawned with (undefined ⇒ none)
          current, // this turn's effective fingerprints
        });
      }
      return changed.length > 0;
    });

  const record: SessionRespawnGateShape["record"] = (threadId, projectId) =>
    fingerprintForThread(threadId, projectId).pipe(
      Effect.map((current) => {
        tracker.record(threadId, current);
      }),
    );

  const forget: SessionRespawnGateShape["forget"] = (threadId) =>
    Effect.sync(() => {
      tracker.forget(threadId);
    });

  // ru-code: worktree provisioning. One catalog's failure must not block the others (or the
  // spawn), so each call is caught + logged individually — same best-effort policy as the
  // fingerprint reads above. The engines guard the main-cwd case themselves (skipped: true),
  // so this is safe to call on EVERY spawn; the real work happens only for worktree cwds.
  const provisionWorktree: SessionRespawnGateShape["provisionWorktree"] = (
    threadId,
    projectId,
    cwd,
  ) =>
    Effect.gen(function* () {
      if (projectId === null || cwd === null) return;
      const provisionOne = <E>(
        label: string,
        run: Effect.Effect<
          { readonly written: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
          E
        >,
      ) =>
        run.pipe(
          Effect.tap((result) =>
            result.written.length > 0 || result.removed.length > 0
              ? Effect.logDebug("[ru-code-respawn] worktree provisioned", {
                  threadId,
                  source: label,
                  cwd,
                  written: result.written.length,
                  removed: result.removed.length,
                })
              : Effect.void,
          ),
          Effect.catch((cause) =>
            Effect.logError(
              `[ru-code-${label}Catalog] worktree provisioning failed — session spawns with the checkout's snapshot`,
              { threadId, cwd, cause },
            ),
          ),
          Effect.asVoid,
        );
      yield* Effect.all(
        [
          provisionOne("skill", skillCatalog.provisionInto({ projectId, targetCwd: cwd })),
          provisionOne("agent", agentCatalog.provisionInto({ projectId, targetCwd: cwd })),
          provisionOne("command", commandCatalog.provisionInto({ projectId, targetCwd: cwd })),
        ],
        { concurrency: 3 },
      );
    });

  return {
    changedForThread,
    record,
    forget,
    provisionWorktree,
  } satisfies SessionRespawnGateShape;
});

/**
 * The SessionRespawnGate service with its SkillCatalog + AgentCatalog dependencies provided.
 * The reactor provides ONLY this layer; the ambient FileSystem + Path + ServerConfig the
 * host catalog layers need are already present where the ws rpc layer is provided.
 */
export const SessionRespawnGateLive = Layer.effect(SessionRespawnGate, makeSessionRespawnGate).pipe(
  Layer.provide(SkillCatalogHostLayer),
  Layer.provide(AgentCatalogHostLayer),
  Layer.provide(CommandCatalogHostLayer),
);

// ru-code: a no-op gate (never respawns, no catalog/fs/sql deps) for reactor unit-test harnesses that
// exercise the OTHER restart triggers. Keeps those tests free of the catalog infrastructure.
export const SessionRespawnGateNoop = Layer.succeed(SessionRespawnGate, {
  changedForThread: () => Effect.succeed(false),
  record: () => Effect.void,
  forget: () => Effect.void,
  provisionWorktree: () => Effect.void,
});
