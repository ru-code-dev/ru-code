import type { SelectionVerdict, StoredSettings } from "../../shared/messages.ts";

export type Settings = StoredSettings;

export type Screen = "main" | "settings";

export interface SendSuccess {
  readonly ok: true;
  readonly nodeId: string;
}
export interface SendFailure {
  readonly ok: false;
  readonly message: string;
}
export type SendResult = SendSuccess | SendFailure;

export interface UiState {
  readonly settings: Settings;
  readonly settingsLoaded: boolean;
  readonly screen: Screen;
  readonly selectionVerdict: SelectionVerdict;
  readonly selectedNodeId: string | null;
  readonly preview: string | null;
  readonly rootName: string;
  readonly sending: boolean;
  readonly sendError: string | null;
}
