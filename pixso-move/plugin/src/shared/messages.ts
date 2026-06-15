// Typed UI <-> code message unions. Imported by BOTH the sandbox (code/) and the iframe (ui/).

export type SelectionVerdict =
  | { readonly ok: true; readonly node: { readonly id: string; readonly name: string } }
  | { readonly ok: false; readonly reason: "empty" | "multiple" };

export interface StoredSettings {
  readonly serverUrl: string;
  readonly designerId: string;
  // Theme is persisted alongside settings (clientStorage) — the plugin iframe
  // can't use localStorage. Kept as strings here; the UI coerces/validates them.
  readonly themeName: string;
  readonly themeMode: string;
}

// Messages the sandbox posts to the iframe UI.
export type CodeToUi =
  | { readonly type: "selection-state"; readonly verdict: SelectionVerdict }
  | {
      readonly type: "preview-ready";
      readonly nodeId: string;
      readonly preview: string;
      readonly rootName: string;
    }
  | {
      readonly type: "collected";
      readonly nodesJson: string;
      readonly rootName: string;
      readonly preview: string;
      readonly nodeCount: number;
    }
  | { readonly type: "settings-loaded"; readonly settings: StoredSettings }
  | { readonly type: "error"; readonly message: string };

// Messages the iframe UI posts to the sandbox.
export type UiToCode =
  | { readonly type: "request-preview" }
  | { readonly type: "collect-and-send-meta" }
  | { readonly type: "save-settings"; readonly settings: StoredSettings };
