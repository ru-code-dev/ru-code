// ru-code: the auto-update live-state atoms, fed by the `subscribeAutoUpdate`
// stream RPC. Mirrors the MCP zone's state atom (ru-code/mcp/mcpState.ts) exactly:
// one subscription atom family (latest stream event per environment) → a derived
// atom keyed off the primary environment → `AutoUpdateWireState | null`.
//
// Every stream event carries a FULL snapshot, so the wire atom is a pure replace
// (no reconciliation). ONE further derived atom maps that wire through `wireToUi`
// against a shared time tick (`autoUpdateNowAtom`) — issue #23: the mapping runs
// once per emission (or per tick), not per subscriber per render, so every
// component reads the same object and the same relative times in a frame.
//
// `null` means "no environment connected yet OR the first snapshot hasn't
// arrived" — the store is REAL-ONLY, so consumers render a "not connected" state
// while this is null (no mock fallback).

import type { AutoUpdateWireState } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import type { AutoUpdateUiState } from "../model";
import { wireToUi } from "./wireToUi";

const autoUpdateSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ru-code:auto-update:subscription",
  tag: "subscribeAutoUpdate",
});

/** The latest auto-update wire state for the primary environment, or null before it connects. */
export const autoUpdateWireStateAtom = Atom.make((get): AutoUpdateWireState | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(get(autoUpdateSubscription({ environmentId, input: {} }))),
  );
}).pipe(Atom.withLabel("ru-code:auto-update:state"));

/**
 * The shared relative-time tick. A single mount (the store's mirror-sync hook)
 * drives this every second via `useRelativeTimeTick`; the derived UI atom reads
 * it so all relative labels advance together. Seeded from the wall clock so the
 * very first render is truthful before the first tick.
 */
export const autoUpdateNowAtom = Atom.make(Date.now()).pipe(
  Atom.withLabel("ru-code:auto-update:now"),
);

/** The single derived, fully-localized UI projection (issue #23). */
export const autoUpdateUiStateAtom = Atom.make((get): AutoUpdateUiState | null => {
  const wire = get(autoUpdateWireStateAtom);
  if (wire === null) return null;
  return wireToUi(wire, get(autoUpdateNowAtom));
}).pipe(Atom.withLabel("ru-code:auto-update:ui-state"));

/**
 * Is the PRIMARY environment's transport connected right now?
 *
 * The restart handover needs the transport's own verdict: `wireState === null` never becomes true
 * after the first snapshot, because `AsyncResult.value` falls back to `previousSuccess` when the
 * stream fails — a dying server leaves its last snapshot in place forever.
 *
 * Derived to a BOOLEAN on purpose. The pill that mounts the driver is on screen at all times, so
 * subscribing it to the presentation map itself would re-render the sidebar on every connection
 * event; a boolean only notifies when connectedness actually flips.
 */
export const autoUpdateConnectedAtom = Atom.make((get): boolean => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  return (
    get(environmentPresentations.presentationsAtom).get(environmentId)?.connection.phase ===
    "connected"
  );
}).pipe(Atom.withLabel("ru-code:auto-update:connected"));

/** Imperative read of the raw wire at mutation time (settings open ⇒ the subscription is live). */
export function getAutoUpdateWireState(): AutoUpdateWireState | null {
  return appAtomRegistry.get(autoUpdateWireStateAtom);
}

/** Imperative read of the localized UI state (e.g. status pages reading `run`). */
export function getAutoUpdateState(): AutoUpdateUiState | null {
  return appAtomRegistry.get(autoUpdateUiStateAtom);
}
