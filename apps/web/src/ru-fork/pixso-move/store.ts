/**
 * Pixso Move — UI + settings store (zustand). Mirrors the MCP manager store: a small
 * master→detail view machine, plus the designer's settings persisted to localStorage
 * (the web app is not sandboxed, so localStorage is safe here). Panel open/close (and
 * MCP⊕Pixso mutual exclusion) lives in the shared right-panel coordinator
 * (ru-fork/rightPanel), not here.
 */

import { create } from "zustand";

export interface PixsoSettings {
  readonly serverUrl: string;
  readonly designerId: string;
  /** Auto-sync cadence in minutes — stored for later; refresh is manual for now. Min 5. */
  readonly syncIntervalMin: number;
}

export type PixsoView = "gallery" | "detail" | "settings";

export const MIN_SYNC_INTERVAL_MIN = 5;
export const DEFAULT_SETTINGS: PixsoSettings = {
  serverUrl: "http://127.0.0.1:7787",
  designerId: "",
  syncIntervalMin: 30,
};

const STORAGE_KEY = "pixso_move_settings";

function loadSettings(): PixsoSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PixsoSettings>;
    return {
      serverUrl: parsed.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
      designerId: parsed.designerId ?? DEFAULT_SETTINGS.designerId,
      syncIntervalMin: Math.max(
        MIN_SYNC_INTERVAL_MIN,
        parsed.syncIntervalMin ?? DEFAULT_SETTINGS.syncIntervalMin,
      ),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(settings: PixsoSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Non-fatal: settings simply won't survive a reload.
  }
}

interface PixsoStore {
  readonly view: PixsoView;
  readonly selectedNodeId: string | null;
  /** Bumped by the refresh button; gates the gallery query (manual refresh only). */
  readonly refreshNonce: number;
  readonly settings: PixsoSettings;

  readonly openSettings: () => void;
  readonly openNode: (nodeId: string) => void;
  readonly backToGallery: () => void;
  readonly refresh: () => void;
  readonly updateSettings: (patch: Partial<PixsoSettings>) => void;
}

export const usePixsoStore = create<PixsoStore>()((set) => ({
  view: "gallery",
  selectedNodeId: null,
  refreshNonce: 0,
  settings: loadSettings(),

  openSettings: () => set({ view: "settings" }),
  openNode: (nodeId) => set({ selectedNodeId: nodeId, view: "detail" }),
  backToGallery: () => set({ view: "gallery" }),
  refresh: () => set((state) => ({ refreshNonce: state.refreshNonce + 1, view: "gallery" })),
  updateSettings: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      persist(next);
      return { settings: next };
    }),
}));
