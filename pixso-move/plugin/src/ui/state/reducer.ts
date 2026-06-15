import type { CodeToUi } from "../../shared/messages.ts";
import { DEFAULT_SERVER_URL } from "../api.ts";
import { DEFAULT_THEME_MODE, DEFAULT_THEME_NAME } from "../theme.ts";
import type { SendResult, Settings, UiState } from "./types.ts";

// Local UI actions (dispatched by App) plus incoming sandbox messages (CodeToUi).
export type UiAction =
  | CodeToUi
  | { readonly type: "open-settings" }
  | { readonly type: "close-settings" }
  | { readonly type: "edit-settings"; readonly settings: Settings }
  | { readonly type: "send-start" }
  | { readonly type: "send-result"; readonly result: SendResult };

export { DEFAULT_SERVER_URL };

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  designerId: "",
  themeName: DEFAULT_THEME_NAME,
  themeMode: DEFAULT_THEME_MODE,
};

export const initialState: UiState = {
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  screen: "main",
  selectionVerdict: { ok: false, reason: "empty" },
  selectedNodeId: null,
  preview: null,
  rootName: "",
  sending: false,
  sendError: null,
};

// Pure state machine. Each message/action produces the next UiState.
export const reduce = (state: UiState, action: UiAction): UiState => {
  switch (action.type) {
    case "settings-loaded":
      return {
        ...state,
        settings: action.settings,
        settingsLoaded: true,
        // First run (no key yet) opens settings so the designer can set up.
        screen: action.settings.designerId.length === 0 ? "settings" : state.screen,
      };
    case "selection-state": {
      // Reset the preview whenever the selected node changes (or becomes invalid)
      // so a fresh request is armed. Keep it when the same node is re-reported.
      const nodeId = action.verdict.ok ? action.verdict.node.id : null;
      const sameNode = nodeId !== null && nodeId === state.selectedNodeId;
      return {
        ...state,
        selectionVerdict: action.verdict,
        selectedNodeId: nodeId,
        preview: sameNode ? state.preview : null,
        rootName: sameNode ? state.rootName : "",
        sendError: null,
      };
    }
    case "preview-ready":
      // Ignore a late preview for a node that is no longer selected.
      return action.nodeId === state.selectedNodeId
        ? { ...state, preview: action.preview, rootName: action.rootName }
        : state;
    case "collected":
      return { ...state, rootName: action.rootName, preview: action.preview };
    case "error":
      return { ...state, sendError: action.message, sending: false };
    case "open-settings":
      return { ...state, screen: "settings" };
    case "close-settings":
      return { ...state, screen: "main" };
    case "edit-settings":
      return { ...state, settings: action.settings };
    case "send-start":
      return { ...state, sending: true, sendError: null };
    case "send-result":
      return action.result.ok
        ? { ...state, sending: false, sendError: null }
        : { ...state, sending: false, sendError: action.result.message };
  }
};
