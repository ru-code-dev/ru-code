// ru-code v2 (S28 V2-35, S33 A9): `ctx.connection` is ONE derived atom over the app's own state.
//
// Before S28 the value was pushed from a React commit of `PluginSignalBridge` — one step behind the
// supervisor it described (S24 §3.2). S28 replaced that with a hand-rolled follower
// (`connectionSource.ts`: subscribe the primary atom, re-subscribe the state atom on every change,
// push into a signal whose `get` was rebound to a second reader). S33 A9 replaces the follower with
// what the codebase already uses for "one value derived from others": `Atom.make((get) => …)`,
// exactly as `primaryEnvironmentIdAtom` is derived from the catalog. The registry does the
// following, the re-subscribing and the teardown; `get()` and `subscribe()` read the same atom, so
// they can never disagree.
//
// Kept out of `signals.ts` (which has no app imports, on purpose). The inputs are a parameter so
// the unit suite derives the same atom over two plain writable atoms in a fresh registry.

import type { PluginConnection, Signal } from "@smart-tools/plugin-sdk/host";
import { connectionProjectionPhase } from "@t3tools/client-runtime/connection";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { toPluginConnection } from "./signals";

/** The two atoms the value is derived from. */
export interface PluginConnectionAtomInputs {
  readonly primaryEnvironmentId: Atom.Atom<EnvironmentId | null>;
  readonly environmentState: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>;
}

/** The plugin-facing value of one environment state result: `connecting` until the atom has one. */
const phaseOf = (
  result: AsyncResult.AsyncResult<SupervisorConnectionState, unknown>,
): PluginConnection => {
  const value = AsyncResult.value(result);
  return value._tag === "Some"
    ? toPluginConnection(connectionProjectionPhase(value.value))
    : "connecting";
};

/**
 * `"connecting"` until a primary environment is chosen, then that environment's projection phase
 * narrowed to the SDK's three values — recomputed by the registry whenever either input moves.
 */
export const makePluginConnectionAtom = (
  inputs: PluginConnectionAtomInputs,
): Atom.Atom<PluginConnection> =>
  Atom.make((get): PluginConnection => {
    const environmentId = get(inputs.primaryEnvironmentId);
    if (environmentId === null) return "connecting";
    return phaseOf(get(inputs.environmentState(environmentId)));
  });

export const pluginConnectionAtom: Atom.Atom<PluginConnection> = makePluginConnectionAtom({
  primaryEnvironmentId: primaryEnvironmentIdAtom,
  environmentState: (environmentId) => environmentCatalog.stateAtom(environmentId),
}).pipe(Atom.withLabel("plugin-connection"));

/**
 * A `Signal<T>` over one atom in one registry — `get` reads it, `subscribe` is the registry's own.
 *
 * `subscribe` READS the atom first, deliberately: a derived node links its inputs when it is first
 * built, and the registry's `subscribe` does not build it — so a plugin that subscribes before it
 * ever calls `get()` would otherwise never be told of a change.
 */
export const makePluginConnectionSignal = (
  registry: () => AtomRegistry.AtomRegistry,
  atom: Atom.Atom<PluginConnection>,
): Signal<PluginConnection> => ({
  get: () => registry().get(atom),
  subscribe: (listener) => {
    const current = registry();
    current.get(atom);
    // `() => listener()` and not `listener`: the registry calls a subscriber with the atom's
    // VALUE, and `Signal.subscribe` promises "the listener takes no arguments — read `get()`".
    // What leaks here is only a `PluginConnection` string, not a store — but the sentence has to
    // be true of every Signal or it is true of none, and a plugin written against an argument
    // that is documented not to exist breaks the day the seam is re-wired. Same adapter as
    // `composerAttach.ts` · `subscribe`, where the leak was the app's whole draft store.
    return current.subscribe(atom, () => listener());
  },
});

/**
 * The `connection` member of every plugin's ctx, in the app's own registry — read at CALL time,
 * because the registry is replaced between unit tests.
 */
export const pluginConnectionSignal = (): Signal<PluginConnection> =>
  makePluginConnectionSignal(() => appAtomRegistry, pluginConnectionAtom);
