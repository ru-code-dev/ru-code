// ru-code (cli-reload): THE CLI spawn scheduler — the single place that decides whether a CLI
// process may be spawned right now, and which of several contenders goes first.
//
// WHY IT EXISTS. A CLI whose cached credentials have lapsed opens an OAuth browser window at
// `authenticate`. Two CLIs starting at once therefore open TWO windows. The warm pool already
// serializes its own refills (one spawn per proof-of-health); this lifts the same discipline to
// cover cold ACP session starts and one-shot `-p` text generation.
//
// THE DECISION, in full:
//   · `authOk` true  → nothing to serialize; every caller runs unguarded.
//   · `authOk` false → ONE permit, handed out by an explicit waiter queue ordered by PRIORITY
//     CLASS: `acp` before `textgen`, FIFO within a class (owner ruling: an ACP session start
//     must never queue behind a background title generation).
//   · An ACP session start is announced BEFORE it can ask, by a RESERVATION taken at the
//     turn-start handler — the only point that precedes the fork of the first-turn title
//     generation (ProviderCommandReactor.ts:1256-1262). While a reservation stands, `textgen`
//     is not eligible even if the permit is free. A reservation is NOT a waiter: it is never
//     handed the permit, it only holds the door for the session start that is coming.
//   · A standalone regenerate-title with no reservation and no `acp` waiter therefore runs
//     IMMEDIATELY — it never waits on an ACP auth window that is not happening.
//
// WHAT IS NOT A CLIENT, and why (this is also the no-deadlock argument's load-bearing half):
//   · the warm pool's own slot spawn. A slot is spawned only by `startEagerLocked` (eager
//     prewarm, `PREWARM_ON_EXPIRED = 0` in production — ru-code/qwen/src/constants.ts:155) or
//     by a chain link armed by `ensureAfterSuccess`, i.e. AFTER a successful bind, by which
//     time `authOk` is true and this module is inert. The pool holds its own mutex across
//     `makeRuntime`, so a slot spawn that asked for the permit would be a mutex holder waiting
//     on the permit — while a session start holding the permit waits on that same mutex inside
//     `warmPool.take`. That is the cycle, and not being a client is what removes it.
//   · the CLI version probe (owner ruling R5 keeps its cache; research A-G5 — untracked by
//     design).
//
// NO SPIN LOOPS, NO ACQUIRE-THEN-RETRY: a waiter parks on its own latch and the scheduler
// hands the permit to the winner. Priority lives here and nowhere else; no caller reads this
// module's state.

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { makeChangeSignal } from "./changeSignal.ts";
import { observeIdleExpiry } from "./reloadRuntime.ts";

/**
 * The permit a client currently holds, offered to the guarded effect so it can hand the permit
 * back the moment its AUTH WINDOW closes rather than when its whole operation ends. An ACP
 * session start uses it at the `authenticate` reply (owner ruling D2); anything that does not
 * ask simply holds until it exits.
 */
export class CliSpawnPermit extends Context.Service<
  CliSpawnPermit,
  { readonly releaseEarly: Effect.Effect<void> }
>()("t3/ru-code/cli-reload/cliSpawnScheduler/CliSpawnPermit") {}

/** Release the permit this fiber holds, if it holds one. A no-op for an unguarded spawn. */
export const releaseCliSpawnPermitEarly: Effect.Effect<void> = Effect.serviceOption(
  CliSpawnPermit,
).pipe(
  Effect.flatMap((permit) => (permit._tag === "Some" ? permit.value.releaseEarly : Effect.void)),
);

/** Priority classes, lowest number first. */
export type CliSpawnKind = "acp" | "textgen";

const PRIORITY: Readonly<Record<CliSpawnKind, number>> = { acp: 0, textgen: 1 };

interface Waiter {
  readonly kind: CliSpawnKind;
  /** Arrival order — FIFO within a class. */
  readonly seq: number;
  /** Resolves `true` when this waiter HOLDS the permit, `false` when the gate went inert. */
  readonly latch: Deferred.Deferred<boolean>;
  /** Set by the scheduler at hand-off, read by an interrupted waiter's cleanup. */
  granted: boolean | null;
}

/**
 * `open` — the scheduler grants normally. `reloading` — a reload owns the CLI fleet: the grant
 * step hands out NOTHING, so every waiter (already queued or newly arriving) stays parked until
 * the reload is over. This is the ONLY place the reload is consulted; there is deliberately no
 * "read the reload latch on the way in", because a client that read it on the way in and then
 * parked on the permit would spawn INTO a running reload (adversary A-1).
 */
let state: "open" | "reloading" = "open";
/**
 * Clients that have been GRANTED (holding the permit, or waved through unguarded) and have not
 * finished yet. This is what "no outstanding spawn client" means for the reload's quiescence
 * check — `permitTaken` alone is not enough, because a client waved through while `authOk` was
 * true holds nothing and would be invisible (adversary R2-2).
 */
const inFlight = new Set<Waiter>();
/**
 * Announced on EVERY mutation of `inFlight`. The reload's fixpoint waits on this instead of
 * re-testing in a spin (adversary R3-1).
 */
const inFlightChanged = makeChangeSignal();
let authOk = false;
let permitTaken = false;
let nextSeq = 0;
let acpReservations = 0;
const queue: Waiter[] = [];

// ── the auth flag ────────────────────────────────────────────────────────────────────────

/**
 * A CLI proved the token works. From here every spawn runs unguarded.
 *
 * SET ONLY WHILE `open`. A reload owns the fleet: everything it is killing may have proven the
 * token a moment ago, and a `-p` run exiting 0 — or an `authenticate` replying — between the
 * reload's first step and its last would otherwise leave the gate DISARMED with every CLI dead
 * (adversary R2-1). Clearing the flag once, at the start of the pass, is only sound if nothing
 * can set it again during the pass; this is what makes that true. No second flag, no re-clear.
 */
export const markAuthOk: Effect.Effect<void> = Effect.suspend(() => {
  if (state === "reloading") return Effect.void;
  if (authOk) return Effect.void;
  authOk = true;
  return serve;
});

/** Idle reset, manual reload (a server restart clears it by nature). */
export const clearAuthOk: Effect.Effect<void> = Effect.sync(() => {
  authOk = false;
});

export const readAuthOk: Effect.Effect<boolean> = Effect.sync(() => authOk);

/**
 * The same read, synchronously — for callers that CANNOT suspend (a spawn-observer callback in
 * a spec). Naming follows the effect convention for a non-Effect escape hatch.
 */
export const readAuthOkUnsafe = (): boolean => authOk;

// ── the scheduler ────────────────────────────────────────────────────────────────────────

/**
 * Hand the free permit to the highest-priority eligible waiter. The ONLY place a waiter is
 * ever woken, and the only place priority is evaluated.
 */
const serve: Effect.Effect<void> = Effect.suspend(() => {
  // THE reload gate. Nothing is granted — not even "go unguarded" — while a reload owns the
  // fleet, so a spawn cannot appear behind the kill pass.
  if (state === "reloading") return Effect.void;
  if (authOk) {
    // The gate exists only while auth is unproven. Once a CLI has authenticated there is
    // nothing left to serialize, so everyone still queued goes at once, unguarded.
    const draining = queue.splice(0, queue.length);
    for (const waiter of draining) {
      waiter.granted = false;
      inFlight.add(waiter);
      inFlightChanged.signalUnsafe();
    }
    return Effect.forEach(draining, (waiter) => Deferred.succeed(waiter.latch, false), {
      discard: true,
    });
  }
  if (permitTaken || queue.length === 0) return Effect.void;
  // A standing reservation means an ACP session start is on its way but has not asked yet;
  // `textgen` must not slip in front of it.
  // THE priority decision, in two steps and nowhere else: the CLASS filter picks who is
  // eligible at all, then FIFO picks which of them. A standing reservation counts as an `acp`
  // contender even though it is not a waiter — that is what stops `textgen` slipping in front
  // of a session start that has not asked yet.
  const acpContending =
    acpReservations > 0 || queue.some((waiter) => PRIORITY[waiter.kind] === PRIORITY.acp);
  const eligible = acpContending
    ? queue.filter((waiter) => PRIORITY[waiter.kind] === PRIORITY.acp)
    : queue;
  if (eligible.length === 0) return Effect.void;
  const winner = eligible.reduce((best, candidate) =>
    candidate.seq < best.seq ? candidate : best,
  );
  queue.splice(queue.indexOf(winner), 1);
  permitTaken = true;
  winner.granted = true;
  inFlight.add(winner);
  inFlightChanged.signalUnsafe();
  return Effect.asVoid(Deferred.succeed(winner.latch, true));
});

const enterReservation = Effect.suspend(() => {
  acpReservations += 1;
  return Effect.void;
});

const leaveReservation = Effect.suspend(() => {
  acpReservations -= 1;
  // A `textgen` waiter may have become eligible.
  return serve;
});

/**
 * Announce that `effect` is about to need a CLI session, so the session takes precedence over
 * anything `textgen` that starts meanwhile. Held for exactly the duration of `effect` and
 * released by the release step — an interrupted turn start cannot strand it.
 */
export const withAcpSpawnReservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    enterReservation,
    () => effect,
    () => leaveReservation,
  );

/**
 * Run `effect` as THE spawning step of a CLI client of class `kind`.
 *
 * NO DEADLOCK. The permit is held across a bounded region — an ACP session start (bounded by
 * the adapter's own `ACP_SESSION_START_TIMEOUT_MS` start handshake ceiling) or one `-p` run
 * (bounded by `CLI_TEXT_GENERATION_TIMEOUT_MS` at its caller) — and nothing reachable inside a
 * held permit asks for the permit again (see the header for why the pool's slot spawn and the
 * version probe are not clients). A holder may wait on the pool mutex inside `warmPool.take`,
 * and no pool-mutex holder ever waits for the permit, so there is no cycle. Release is the
 * release step of `acquireUseRelease` plus the interrupt cleanup below, so an abandoned client
 * always returns what it took.
 */
export const withCliSpawnPermit = <A, E, R>(
  kind: CliSpawnKind,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  // Everything that must be true BEFORE a CLI may be spawned. The warm pool's idle edge is
  // read first (it can clear `authOk`, and with the branding flag on it cleans the profile
  // dir), with nothing held. Then the client joins the queue and waits for THE verdict.
  //
  // The edge is sampled AGAIN on the way out, and that second sample is what makes the first
  // one work: a session start turns the pool ACTIVE (`take` / `ensureAfterSuccess`), so a
  // sample taken only on the way IN would read EXPIRED both before and after an idle reset and
  // never see a transition at all.
  observeIdleExpiry.pipe(
    Effect.andThen(takePermit(kind, effect)),
    Effect.onExit(() => observeIdleExpiry),
  );

/**
 * EVERY client goes through the queue — there is no fast path that skips it. That is what makes
 * `serve` the single decision point: whether a client holds the permit, runs unguarded, or waits
 * for a reload to finish is decided in one place, never at the call site.
 */
const takePermit = <A, E, R>(
  kind: CliSpawnKind,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const waiter: Waiter = {
      kind,
      seq: nextSeq++,
      latch: Deferred.makeUnsafe<boolean>(),
      granted: null,
    };
    queue.push(waiter);
    // Interruption while parked: either we were never served (drop out of the queue) or the
    // hand-off raced the interrupt (give the permit straight back).
    const abandon = Effect.suspend(() => {
      if (waiter.granted !== null && inFlight.delete(waiter)) inFlightChanged.signalUnsafe();
      if (waiter.granted === true) {
        waiter.granted = false;
        permitTaken = false;
        return serve;
      }
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      return Effect.void;
    });
    /** The client is done: it stops being outstanding, and returns the permit if it held one. */
    const releaseIfHeld = Effect.suspend(() => {
      if (inFlight.delete(waiter)) inFlightChanged.signalUnsafe();
      if (waiter.granted !== true) return Effect.void;
      waiter.granted = false;
      permitTaken = false;
      return serve;
    });
    /**
     * NO PERMIT LEAK, by construction (adversary U-1). The whole body is uninterruptible except
     * the park itself, so the window the leak needs does not exist: the grant is recorded by
     * `serve` (`permitTaken` + `waiter.granted`) in the same synchronous step that completes the
     * latch, and the instant the park returns we are back inside the mask — `effect`'s release
     * finalizer is installed before this fiber can be interrupted again. An interrupt DURING the
     * park lands on the restored region, where `abandon` either de-queues or returns the permit.
     */
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* serve;
        yield* restore(
          Deferred.await(waiter.latch).pipe(
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : abandon)),
          ),
        );
        return yield* restore(
          effect.pipe(
            Effect.provideService(CliSpawnPermit, { releaseEarly: releaseIfHeld }),
            Effect.onExit(() => releaseIfHeld),
          ),
        );
      }),
    );
  });

/**
 * Is any client granted-but-unfinished right now? Read-only; the reload's kill pass uses it as
 * half of its quiescence test (the other half is the live-child registry being empty).
 */
export const hasOutstandingSpawnClients: Effect.Effect<boolean> = Effect.sync(
  () => inFlight.size > 0,
);

/**
 * The handle the next grant-or-release will complete. Take it BEFORE reading
 * `hasOutstandingSpawnClients`.
 */
export const nextSpawnClientsChange: Effect.Effect<Deferred.Deferred<void>> = inFlightChanged.next;

/**
 * Reload ownership. While `effect` runs, the scheduler is in `reloading` and grants nothing;
 * on the way out it returns to `open` and immediately serves whoever queued up meanwhile.
 * `acquireUseRelease` so an interrupted or failed reload cannot strand the scheduler shut.
 */
export const withSchedulerReloading = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      state = "reloading";
    }),
    () => effect,
    () =>
      Effect.suspend(() => {
        state = "open";
        return serve;
      }),
  );

/**
 * Tests only — the singletons above have no production reset (same contract as
 * `clearVersionProbeCacheForTests`). Vitest runs many adapters in one process; without this,
 * one spec's `authOk` decides the next spec's gate.
 */
export const resetCliSpawnSchedulerForTests = (): void => {
  state = "open";
  inFlight.clear();
  inFlightChanged.resetUnsafe();
  authOk = false;
  permitTaken = false;
  nextSeq = 0;
  acpReservations = 0;
  queue.splice(0, queue.length);
};
