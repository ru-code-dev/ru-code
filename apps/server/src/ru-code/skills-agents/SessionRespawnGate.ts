// ru-code: the session-respawn gate. qwen reads skills, subagents and custom commands ONLY at
// spawn, so when a thread's EFFECTIVE set changes, the live `qwen --acp` session must re-spawn on
// the next user message (with the prior resumeCursor, history preserved).
//
// This service is the reactor's single seam for that decision: the reactor imports ONLY
// `SessionRespawnGate`. Per turn it asks `changedForThread(threadId, projectId)` — true ⇒ OR it
// into the restart decision — and on each (re)spawn calls `record(threadId, projectId)` to
// remember what that spawn loaded. `forget(threadId)` drops a thread's record on session stop
// (see the tracker for why the store's lifetime is the session's, not a TTL).
//
// The gate owns one SessionFingerprintTracker instance and is a pure AGGREGATOR over the `session`
// SEAM of whichever loaded plugins export one (decision V2-5; v1 had the plugin call
// `registerSessionHook` from `activate`, v2 reads `plugin.session` off the object the host
// imported). It names no plugin: a seam call that fails, throws or overruns its budget is logged
// and treated as the safe answer, so a transient failure never triggers a spurious respawn and
// never blocks a spawn.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  makeSessionFingerprintTracker,
  type CurrentFingerprints,
} from "./SessionFingerprintTracker.ts";
// ru-code: plugins — (V2-5) the gate is an AGGREGATOR over the loaded plugins' `session` seams,
// and it names no plugin. It is the ONLY source of fingerprints and worktree provisioning: with no
// such plugin installed the gate never respawns and provisions nothing, which is the documented
// no-plugin behaviour.
import { PluginHost, PluginHostLayer } from "../plugins/PluginHost.ts";

// ru-code: leak backstop for the tracker. Not a TTL — entries live as long
// as the process / until this many distinct threads accumulate, whichever comes first; a
// process restart resets it. Effectively unreachable for a single user, and eviction is safe
// (an evicted entry ⇒ one harmless respawn next turn).
const SESSION_FINGERPRINT_CAPACITY = 10_000;

/**
 * ru-code (decision V2-5): the budget on ONE plugin `session` seam call.
 *
 * Deliberately tighter than the plugin host's 15 s per-step budget: THAT one is paid once, at
 * boot, where the user is already waiting for the app to start. THIS one is paid on every turn,
 * inside the delay between the user pressing Enter and the assistant answering, and it is paid
 * per hook. Five seconds is far more than a correct hook needs (the compiled-in equivalent
 * fingerprints three catalogs off the filesystem in single-digit milliseconds) and short enough
 * that a wedged plugin costs one visible pause rather than a hung session.
 *
 * A hook that overruns it is ABANDONED, not awaited: `Effect.timeoutOption` interrupts the fiber
 * and the gate proceeds with the safe answer.
 */
const PLUGIN_SESSION_HOOK_TIMEOUT = Duration.seconds(5);
const PLUGIN_SESSION_HOOK_TIMEOUT_LABEL = "5s";

/** Whatever a plugin hook rejected or threw, in the error channel where it can be handled. */
class PluginSessionHookError extends Data.TaggedError("PluginSessionHookError")<{
  readonly cause: unknown;
}> {}

/**
 * Run one plugin hook call under the budget, with the failure policy the SDK documents.
 *
 * `safe` is what the caller gets when the hook throws, rejects, or overruns — `null` for a
 * fingerprint (counts as "nothing changed": a failing plugin must not respawn the user's session
 * every turn) and `undefined` for a provision (counts as done: the session spawns with whatever
 * the checkout already had). NEVER a failure: the whole point of O1-B's policy is that no plugin
 * can stop a spawn.
 */
/**
 * Run one plugin hook call under the budget, with the failure policy the SDK documents.
 *
 * `safe` is what the caller gets when the hook throws, rejects, or overruns — `null` for a
 * fingerprint (counts as "nothing changed": a failing plugin must not respawn the user's session
 * every turn) and `undefined` for a provision (counts as done: the session spawns with whatever
 * the checkout already had). NEVER a failure: the whole point of O1-B's policy is that no plugin
 * can stop a spawn.
 *
 * WHAT THE BUDGET DOES AND DOES NOT DO. It stops the GATE waiting; it cannot stop the plugin's
 * promise, because the SDK boundary is promise-shaped (D6) and a promise has no cancellation. An
 * overrunning hook is therefore ABANDONED — it may settle later, into nothing — and the turn goes
 * on. That is the whole contract, and it is why the SDK tells authors to fingerprint inputs rather
 * than read every file.
 */
const runHook = <A>(input: {
  readonly pluginId: string;
  readonly what: string;
  readonly threadId: string;
  readonly safe: A;
  readonly call: () => Promise<A>;
}): Effect.Effect<A> =>
  Effect.tryPromise({
    // Inside the async body so a SYNCHRONOUS throw in the hook becomes a rejected promise rather
    // than escaping into the gate — the same shape `PluginHost` uses around `activate`.
    try: async () => await input.call(),
    // A TAGGED wrapper rather than the bare cause: the error channel is what the `Effect.catch`
    // below reads, and an untyped `unknown` there is exactly the shape the house lint refuses —
    // for the good reason that it makes "did we handle everything" unanswerable.
    catch: (cause) => new PluginSessionHookError({ cause }),
  }).pipe(
    Effect.timeoutOption(PLUGIN_SESSION_HOOK_TIMEOUT),
    // `Option.isNone`, NOT `getOrNull() === null`: `null` is a hook's own legitimate answer to
    // `changedForThread` ("nothing to contribute / could not tell"), so a nullish test would
    // report a timeout on every turn for a correct plugin. Only the OPTION tells "answered null"
    // apart from "never answered".
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.logError(
            `[ru-code-respawn] plugin session hook ${input.what} timed out after ${PLUGIN_SESSION_HOOK_TIMEOUT_LABEL} — treated as no-op`,
            { pluginId: input.pluginId, threadId: input.threadId },
          ).pipe(Effect.as(input.safe))
        : Effect.succeed(option.value),
    ),
    Effect.catch((cause) =>
      Effect.logError(
        `[ru-code-respawn] plugin session hook ${input.what} failed — treated as no-op`,
        { pluginId: input.pluginId, threadId: input.threadId, cause: cause.cause },
      ).pipe(Effect.as(input.safe)),
    ),
    // A DEFECT (a hook that threw something exotic, an interrupt) lands here rather than in
    // `Effect.catch`, and it must be just as harmless: a plugin cannot fail a spawn by any route.
    Effect.catchCause((cause) =>
      Effect.logError(`[ru-code-respawn] plugin session hook ${input.what} defect — ignored`, {
        pluginId: input.pluginId,
        threadId: input.threadId,
        cause,
      }).pipe(Effect.as(input.safe)),
    ),
  );

/**
 * The tracker source name for one plugin's fingerprint.
 *
 * Namespaced so two plugins can never collide, and so a fingerprint recorded by one plugin is
 * never compared against another's (a plugin that is uninstalled simply stops contributing a
 * source, which the tracker ignores rather than reading as a change).
 */
export const pluginFingerprintSource = (pluginId: string): string => `plugin:${pluginId}`;

/**
 * `projectId` is `string | null` (`null` ⇒ globals only) — the shape the session hooks receive.
 * The reactor's `thread.projectId` (a branded ProjectId) is assignable here.
 */
export type RespawnProjectId = string | null;

export interface SessionRespawnGateShape {
  /**
   * Ask every `session.fingerprint` seam to fingerprint this thread and report whether any source now differs
   * from what the live session spawned with. Best-effort: a hook failure is logged and treated as
   * "unchanged for that source" (no spurious respawn). Never fails.
   */
  readonly changedForThread: (
    threadId: string,
    projectId: RespawnProjectId,
  ) => Effect.Effect<boolean>;
  /**
   * Record the fingerprints this (re)spawn loaded, so the next turn's `changedForThread`
   * compares against them. Best-effort per source; never fails.
   */
  readonly record: (threadId: string, projectId: RespawnProjectId) => Effect.Effect<void>;
  /** Drop a thread's record on session stop / teardown. Idempotent; never fails. */
  readonly forget: (threadId: string) => Effect.Effect<void>;
  /**
   * Let every `session.provision` seam mirror the project's items into `cwd` when it is a git worktree.
   * qwen reads project items from `<cwd>/.qwen/*` at spawn, but a catalog only ever writes the
   * project's main workspaceRoot — so a worktree session would see a stale git snapshot (or
   * nothing). Called right before every (re)spawn; a hook is expected to detect per item (write
   * only missing/stale) and no-op when `cwd` IS the main workspaceRoot. Best-effort: a failure is
   * logged and the session spawns with the checkout's snapshot. Never fails.
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

/**
 * ru-code (A22): exported so a test can compose the gate over a FAKE `PluginHost`.
 *
 * `SessionRespawnGateLive` self-provides `PluginHostLayer` (memo hit onto the app's one instance),
 * and an inner `Layer.provide` cannot be overridden from outside — so the aggregation policy
 * (a throwing hook, a hanging hook, no hooks at all) is only reachable by building the gate from
 * this effect. Production still goes through the layer below.
 */
export const makeSessionRespawnGate = Effect.gen(function* () {
  // ru-code: plugins — (V2-5) the whole aggregation. Read ONCE here; `sessions` is a synchronous read off
  // the host's own table, so an install with no such plugin pays a Map iteration per turn.
  const pluginHost = yield* PluginHost;

  const tracker = makeSessionFingerprintTracker({ capacity: SESSION_FINGERPRINT_CAPACITY });

  // ru-code: plugins — (V2-5) fingerprint a thread's project through every plugin `session` seam, in order,
  // under its own budget. A hook that answers `null` — its own "nothing to contribute / could not
  // tell" — is recorded as `undefined`, which the tracker IGNORES: it never counts as a change and
  // never poisons the recorded set. Global scope ⇒ `projectId: null`.
  //
  // Concurrency 1, deliberately. These run on the user's critical path and a plugin's hook is
  // usually filesystem work; three plugins racing each other's disk reads buys nothing and makes
  // the worst case harder to reason about than "at most one budget at a time".
  const fingerprintForThread = (
    threadId: string,
    projectId: RespawnProjectId,
  ): Effect.Effect<CurrentFingerprints> =>
    Effect.gen(function* () {
      const seams = yield* pluginHost.sessions;
      const pluginFingerprints: Record<string, string | undefined> = {};
      for (const { pluginId, session, ctx } of seams) {
        const fingerprint = session.fingerprint;
        if (fingerprint === undefined) continue;
        const value = yield* runHook<string | null>({
          pluginId,
          what: "session.fingerprint",
          threadId,
          safe: null,
          call: () => fingerprint.call(session, threadId, projectId, ctx),
        });
        pluginFingerprints[pluginFingerprintSource(pluginId)] =
          typeof value === "string" ? value : undefined;
      }
      return pluginFingerprints;
    });

  const changedForThread: SessionRespawnGateShape["changedForThread"] = (threadId, projectId) =>
    Effect.gen(function* () {
      const current = yield* fingerprintForThread(threadId, projectId);
      const changed = tracker.changedSources(threadId, current);
      // ru-code: surface WHY a respawn was triggered — which sources changed and the spawned-with
      // vs current fingerprints — so a hook-driven respawn is visible in the logs (parity with the
      // prior project's restart log). Debug level: it's a per-turn trace.
      if (changed.length > 0) {
        yield* Effect.logDebug("[ru-code-respawn] catalog change → provider session respawn", {
          threadId,
          projectId, // null ⇒ globals only
          changedSources: changed, // e.g. ["plugin:catalogs"]
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

  // ru-code: plugins — worktree provisioning, through every plugin hook in load order. One hook's failure
  // must not block the others (or the spawn), so each call carries the same best-effort policy as
  // the fingerprint reads above. A hook is expected to guard the main-cwd case itself, so this is
  // safe to call on EVERY spawn; the real work happens only for worktree cwds. Sequential for the
  // same reason the fingerprints are.
  const provisionWorktree: SessionRespawnGateShape["provisionWorktree"] = (
    threadId,
    projectId,
    cwd,
  ) =>
    Effect.gen(function* () {
      if (projectId === null || cwd === null) return;
      const seams = yield* pluginHost.sessions;
      for (const { pluginId, session, ctx } of seams) {
        const provision = session.provision;
        if (provision === undefined) continue;
        yield* runHook<void>({
          pluginId,
          what: "session.provision",
          threadId,
          safe: undefined,
          call: () => provision.call(session, projectId, cwd, ctx),
        });
      }
    });

  return {
    changedForThread,
    record,
    forget,
    provisionWorktree,
  } satisfies SessionRespawnGateShape;
});

/**
 * The SessionRespawnGate service with its only dependency — the plugin host — provided.
 * The reactor provides ONLY this layer.
 */
export const SessionRespawnGateLive = Layer.effect(SessionRespawnGate, makeSessionRespawnGate).pipe(
  // ru-code: plugins — (V2-5) the plugin host, for `sessions`. `PluginHostLayer` is a module-level
  // const and layer memoization keys on layer identity, so this is a memo HIT onto the instance
  // `server.ts` builds for the boot phase and `ws.ts` provides to the RPC table — the one whose
  // `start` filled the status and hook tables. A second one would have neither.
  Layer.provide(PluginHostLayer),
);

// ru-code: a no-op gate (never respawns, no catalog/fs/sql deps) for reactor unit-test harnesses that
// exercise the OTHER restart triggers. Keeps those tests free of the catalog infrastructure.
/**
 * ru-code (V2-5): the aggregation, spelled out for the reader of `SessionRespawnGateShape`.
 *
 * `changedForThread` is TRUE when any plugin's `session.fingerprint` changed; `provisionWorktree`
 * runs every `session.provision`. A seam that throws, rejects or overruns its 5 s budget is logged
 * and treated as the safe answer ("unchanged" / "done"), so no plugin can fail or delay a spawn
 * past that budget. With NO `session` seam installed the gate never respawns and provisions
 * nothing, which is what `sessionRespawnGateAggregate.test.ts` pins.
 */

// ru-code: a no-op gate (never respawns, no catalog/fs/sql deps) for reactor unit-test harnesses that
export const SessionRespawnGateNoop = Layer.succeed(SessionRespawnGate, {
  changedForThread: () => Effect.succeed(false),
  record: () => Effect.void,
  forget: () => Effect.void,
  provisionWorktree: () => Effect.void,
});
