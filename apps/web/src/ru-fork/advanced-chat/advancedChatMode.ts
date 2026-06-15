// ru-fork: advanced chat mode toggle — per-thread, persisted to localStorage so the
// view choice survives reloads. Isolated store; does not touch uiStateStore.
import { create } from "zustand";

const STORAGE_KEY = "ru-fork:advanced-chat-mode:v1";

function loadInitial(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function persist(byThread: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(byThread));
  } catch {
    // ignore quota / serialization errors
  }
}

interface AdvancedChatModeStore {
  readonly byThread: Record<string, boolean>;
  readonly toggle: (threadId: string) => void;
}

export const useAdvancedChatMode = create<AdvancedChatModeStore>((set) => ({
  byThread: loadInitial(),
  toggle: (threadId) =>
    set((state) => {
      const next = { ...state.byThread, [threadId]: !state.byThread[threadId] };
      persist(next);
      return { byThread: next };
    }),
}));
