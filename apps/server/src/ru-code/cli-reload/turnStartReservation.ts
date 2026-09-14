// ru-code (cli-reload): the turn-start reservation's QWEN GATE.
//
// The CLI spawn scheduler's reservation exists for one thing: a qwen session start must not
// queue behind the title generation the turn-start handler forks before it. But the handler is
// the SHARED dispatch — every provider's turn start goes through it — so reserving
// unconditionally would let a Claude/Codex turn start hold an `acp` reservation and block a
// qwen text generation. That is a real coupling, and owner ruling R1 ("Qwen adapters only.
// Other providers untouched") forbids it.
//
// So the decision lives here, in the zone, and the seam stays one line: reserve IFF the session
// this turn would start is qwen-kind.
//
// HOW THE KIND IS DECIDED — the same way `ensureSessionForThread` decides it, because that is
// the function whose session the reservation is about:
//   desired selection = the turn's own `modelSelection` if it carries one, else the THREAD's
//   (ProviderCommandReactor `ensureSessionForThread`: `requestedModelSelection ?? thread.modelSelection`),
//   then its `instanceId` → `providerService.getInstanceInfo(...).driverKind`.
// Deliberately NOT the ProviderSessionDirectory binding: a binding records the provider of the
// LAST session, and a brand-new thread — the very case the reservation exists for — has no
// binding at all. The thread row always carries a `modelSelection` (it is set at `thread.create`
// and is part of `OrchestrationThreadShell`), so the first turn of a brand-new qwen thread
// resolves correctly.
//
// Unresolvable (thread gone, instance not configured in this build) ⇒ NO reservation. That turn
// start is about to fail in `ensureSessionForThread` anyway, and refusing to reserve is the
// answer that cannot violate R1.

import { QWEN_KIND } from "@ru-code/branding";
import type { ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { withAcpSpawnReservation } from "./cliSpawnScheduler.ts";

/** What the turn-start event tells us about the session it is about to need. */
export interface TurnStartSelection {
  readonly threadId: ThreadId;
  readonly modelSelection?: ModelSelection | undefined;
}

/**
 * The two reads the decision needs, injected so the rule can be exercised without standing up
 * a projection and a provider registry (same shape as `runQwenBootSweepWith` /
 * `makeCliReloadEngineWith`). Both return `null` when the answer does not exist.
 */
export interface TurnStartProviderLookup {
  readonly readThreadInstanceId: (threadId: ThreadId) => Effect.Effect<ProviderInstanceId | null>;
  readonly readDriverKind: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>;
}

/** Would this turn start a QWEN session? */
export const turnStartsQwenSession = (
  lookup: TurnStartProviderLookup,
  selection: TurnStartSelection,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const instanceId =
      selection.modelSelection?.instanceId ??
      (yield* lookup.readThreadInstanceId(selection.threadId));
    if (instanceId === null) return false;
    const driverKind = yield* lookup.readDriverKind(instanceId);
    // Compared as a plain string against the branding constant, exactly like the boot sweep's
    // own provider filter (`String(binding.provider) === QWEN_KIND`).
    return driverKind !== null && String(driverKind) === QWEN_KIND;
  });

/** The injected-lookup form — the production entry below wires the real reads into it. */
export const withQwenTurnStartReservationUsing = <A, E, R>(
  lookup: TurnStartProviderLookup,
  selection: TurnStartSelection,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const isQwen = yield* turnStartsQwenSession(lookup, selection);
    return yield* isQwen ? withAcpSpawnReservation(effect) : effect;
  });

/**
 * Production entry — THE function the reactor's one marked line calls. Resolves the two reads
 * from the services the turn-start handler already runs with.
 */
export const withQwenTurnStartReservation = <A, E, R>(
  selection: TurnStartSelection,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const lookup: TurnStartProviderLookup = {
      readThreadInstanceId: (threadId) =>
        projection.getThreadShellById(threadId).pipe(
          Effect.map((shell) =>
            Option.match(shell, {
              onNone: () => null,
              onSome: (thread) => thread.modelSelection.instanceId,
            }),
          ),
          Effect.orElseSucceed(() => null),
        ),
      readDriverKind: (instanceId) =>
        providerService.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => String(info.driverKind)),
          Effect.orElseSucceed(() => null),
        ),
    };
    return yield* withQwenTurnStartReservationUsing(lookup, selection, effect);
  });
