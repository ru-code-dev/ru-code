import type { DesignerId, NodeId } from "@pixso-move/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { runOneJob } from "./drain.ts";
import type { ProcessorShape } from "./processor.ts";
import { computeReconcileRows, configuredDesignerIds, resolvePrompt } from "./reconcile.ts";
import type { ProcessorDeps, ProcessorOptions } from "./types.ts";

const DEFAULT_POLL_MS = 2000;

// Serializes ticks: at most one drive loop runs; a request arriving mid-drive flags a re-run.
type DriveState = "idle" | "running" | "rerun";

// Build the processor over injected deps. Returns its shape; the embed layer publishes it as
// the `Processor` service. Requires a Scope (the timer + notify forks live in it).
export const makeProcessor = (
  deps: ProcessorDeps,
  options: ProcessorOptions,
): Effect.Effect<ProcessorShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const config = options.config;
    const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const scope = yield* Effect.scope;
    const stateRef = yield* Ref.make<DriveState>("idle");
    const timerRef = yield* Ref.make<Fiber.Fiber<unknown> | undefined>(undefined);

    // Ensure a `pending` row exists for every (configured node × tag).
    const reconcileAll = Effect.gen(function* () {
      const entries: Array<readonly [DesignerId, ReadonlyArray<NodeId>]> = [];
      for (const designerId of configuredDesignerIds(config)) {
        entries.push([designerId, yield* deps.listNodeIds(designerId)]);
      }
      const inserted = yield* deps.reconcile(computeReconcileRows(config, new Map(entries)));
      yield* Effect.logDebug("reconciled", { inserted });
    });

    // Claim and run pending jobs until the queue is empty.
    const drainAll = Effect.gen(function* () {
      for (;;) {
        const job = yield* deps.claimNextPending;
        if (job === undefined) break;
        const promptText = resolvePrompt(config, job.designerId, job.resultTag);
        if (promptText === undefined) {
          yield* deps.fail(job.id, "no configured prompt");
          continue;
        }
        yield* runOneJob(deps, job, promptText);
      }
    });

    // One full tick. Contained: a defect can't kill the timer or the process.
    const runTickOnce: Effect.Effect<void> = reconcileAll.pipe(
      Effect.flatMap(() => drainAll),
      Effect.catchCause((cause) =>
        Effect.logError("tick failed", { cause: Cause.pretty(cause) }),
      ),
    );

    // Run ticks back-to-back while re-runs are requested, then go idle. Atomic via Ref.modify.
    const driveLoop: Effect.Effect<void> = Effect.gen(function* () {
      yield* runTickOnce;
      const again = yield* Ref.modify(stateRef, (state): [boolean, DriveState] =>
        state === "rerun" ? [true, "running"] : [false, "idle"],
      );
      if (again) yield* driveLoop;
    });

    // Non-blocking: start a drive if idle, else flag a re-run. Never fails its caller.
    const notify: Effect.Effect<void> = Ref.modify(
      stateRef,
      (state): [boolean, DriveState] =>
        state === "idle" ? [true, "running"] : [false, "rerun"],
    ).pipe(
      Effect.flatMap((shouldStart) =>
        shouldStart ? Effect.asVoid(Effect.forkIn(driveLoop, scope)) : Effect.void,
      ),
    );

    // Recover interrupted work, then arm a fixed-interval poll (re-discovers nodes, retries).
    const start = Effect.gen(function* () {
      const recovered = yield* deps.recoverInFlight;
      yield* Effect.logDebug("recovered", { count: recovered });
      const timer = yield* Effect.forkIn(
        Effect.schedule(notify, Schedule.fixed(pollMs)),
        scope,
      );
      yield* Ref.set(timerRef, timer);
    });

    const stop = Effect.gen(function* () {
      const timer = yield* Ref.get(timerRef);
      if (timer !== undefined) yield* Fiber.interrupt(timer);
    });

    return { start, notify, stop, runTickOnce } satisfies ProcessorShape;
  });
