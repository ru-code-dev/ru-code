// ru-code: client-local UI state for the auto-update settings — the tiny sliver
// that is NOT on the wire. Today that is just `manualSourcesOpen` (whether the
// user expanded the manual source editor in compact mode). Kept as a module
// singleton with `useSyncExternalStore` so it survives remounts and has one home.

import { useSyncExternalStore } from "react";

interface ClientLocalState {
  manualSourcesOpen: boolean;
}

let state: ClientLocalState = { manualSourcesOpen: false };
const listeners = new Set<() => void>();

function getState(): ClientLocalState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setManualSourcesOpen(manualSourcesOpen: boolean): void {
  if (state.manualSourcesOpen === manualSourcesOpen) return;
  state = { ...state, manualSourcesOpen };
  for (const listener of listeners) listener();
}

export function useManualSourcesOpen(): boolean {
  return useSyncExternalStore(subscribe, getState, getState).manualSourcesOpen;
}
