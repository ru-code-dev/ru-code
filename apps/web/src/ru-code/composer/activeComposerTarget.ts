// ru-code: THE active composer target, lifted out of the Pixso host so more than one surface
// can reach it (mvp-plan §1.4 "active-target hook lifted from pixso-assistant/host.tsx").
//
// «Which composer does an attached context card land on?» has exactly one answer in this app:
// the thread (or draft) the ROUTE is on. Pixso's "+" already resolved it that way; a plugin's
// `host.composer.attach(card)` needs the same answer, so the resolution lives here and both
// import it.
//
// Two readers, two shapes:
//   * `useActiveComposerTarget()` — the HOOK, for a component that must re-render when the
//     route changes (the Pixso port, the SDK's `composer.useActiveTarget`).
//   * `getActiveComposerTarget()` — a NON-HOOK read, for an imperative caller: a plugin calls
//     `attach(card)` from its own click handler, which is not a render. Router params are only
//     reachable through a hook, so `useActiveComposerTargetSync()` (installed once by
//     `RightGlobalPanelHost`, which is mounted above the routes and outlives every thread —
//     the `useExtendedViewPanelBinding` precedent) mirrors the hook's value into a tiny store
//     that the non-hook read consults.

import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { create } from "zustand";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

/** The route's thread or draft, or `null` when the route is not on one. */
export function useActiveComposerTarget(): ComposerThreadTarget | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // Structural narrowing (no tag-string comparison — the L() compare-guard stays quiet).
  if (routeTarget === null || routeTarget === undefined) return null;
  if ("threadRef" in routeTarget) return routeTarget.threadRef;
  if ("draftId" in routeTarget) return routeTarget.draftId;
  return null;
}

interface ActiveComposerTargetState {
  readonly target: ComposerThreadTarget | null;
}

const useActiveComposerTargetStore = create<ActiveComposerTargetState>(() => ({ target: null }));

/** Value equality, so a fresh `select` object per render does not churn the store. */
export function sameComposerTarget(
  a: ComposerThreadTarget | null,
  b: ComposerThreadTarget | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return false;
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

/**
 * Installed ONCE, by the global panel host. Keeps `getActiveComposerTarget()` current.
 * Returns the value it wrote so a caller that wants both pays for one hook.
 */
export function useActiveComposerTargetSync(): ComposerThreadTarget | null {
  const target = useActiveComposerTarget();
  useEffect(() => {
    if (sameComposerTarget(useActiveComposerTargetStore.getState().target, target)) return;
    useActiveComposerTargetStore.setState({ target });
  }, [target]);
  return target;
}

/** Non-hook read — `null` when no thread/draft route is active (or before the sync mounts). */
export function getActiveComposerTarget(): ComposerThreadTarget | null {
  return useActiveComposerTargetStore.getState().target;
}

/** Test seam (and the only writer besides the sync hook). */
export function setActiveComposerTarget(target: ComposerThreadTarget | null): void {
  useActiveComposerTargetStore.setState({ target });
}
