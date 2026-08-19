// ru-code: right-slot mutual exclusion as a STATE INVARIANT maintained at the writes.
//
// The thread panel (rightPanelStore) and the global skills/agents panel (useRightGlobalPanelStore)
// share the right slot. Earlier attempts failed:
//   - a cross-store render gate (`!globalPanelOpen` in ChatView) did NOT reliably hide the thread
//     panel when a global panel opened — the thread panel kept rendering, so both showed;
//   - a surface-id watcher missed no-op re-opens (re-activating an already-active surface).
//
// Instead we keep a hard invariant with zustand subscriptions: opening ONE panel closes the OTHER, at
// the moment of the write. Each panel then renders purely from its OWN store (the mechanism that
// already reliably shows/hides it), so the two can never be visible at once.
//
// Subscriptions fire synchronously on setState, independent of React rendering — so this works even
// where a component fails to re-render on a cross-store change. It is also testable without a DOM:
// installRightSlotExclusion() wires to the real stores and can be driven in a plain node test.

import { useEffect, useRef } from "react";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { useRightGlobalPanelStore } from "./store";

const threadPanelIsOpen = (ref: ScopedThreadRef): boolean =>
  useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.isOpen ?? false;

// Hide the thread panel WITHOUT discarding its surfaces (toggleVisibility only flips isOpen), so the
// toggle button can restore it later.
const hideThreadPanel = (ref: ScopedThreadRef): void => {
  if (threadPanelIsOpen(ref)) {
    useRightPanelStore.getState().toggleVisibility(ref);
  }
};

/**
 * Wire the mutual-exclusion invariant between the two stores. Returns an unsubscribe. The React hook
 * installs this in an effect; tests install it directly against the real stores and drive them.
 */
export const installRightSlotExclusion = (
  getThreadRef: () => ScopedThreadRef | null,
): (() => void) => {
  // A) a global panel just OPENED (null → open) → hide the thread panel.
  const unsubscribeGlobal = useRightGlobalPanelStore.subscribe((state, previous) => {
    if (state.open === null || previous.open !== null) return;
    const ref = getThreadRef();
    if (ref !== null) hideThreadPanel(ref);
  });

  // B) the thread panel just became VISIBLE (isOpen false → true) → close the global panel.
  const unsubscribeThread = useRightPanelStore.subscribe((state, previous) => {
    const ref = getThreadRef();
    if (ref === null) return;
    const key = scopedThreadKey(ref);
    const nowOpen = state.byThreadKey[key]?.isOpen ?? false;
    const wasOpen = previous.byThreadKey[key]?.isOpen ?? false;
    if (nowOpen && !wasOpen) useRightGlobalPanelStore.getState().close();
  });

  return () => {
    unsubscribeGlobal();
    unsubscribeThread();
  };
};

export function useRightSlotExclusion(activeThreadRef: ScopedThreadRef | null): void {
  // Keep the latest ref in a box so the subscriptions (installed once) always see the active thread
  // without re-subscribing on every thread switch.
  const threadRefBox = useRef(activeThreadRef);
  threadRefBox.current = activeThreadRef;
  useEffect(() => installRightSlotExclusion(() => threadRefBox.current), []);
}
