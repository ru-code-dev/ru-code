// Minimal Pixso/Figma plugin API subset — only what code.ts actually uses.
// Offline-safe: we do NOT install @figma/plugin-typings. Pixso mirrors the Figma API.

interface ExportSettingsImage {
  readonly format: "PNG";
  readonly constraint?: { readonly type: "SCALE" | "WIDTH" | "HEIGHT"; readonly value: number };
}

interface SceneNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly children?: ReadonlyArray<SceneNode>;
  exportAsync(settings: ExportSettingsImage): Promise<Uint8Array>;
  readonly [key: string]: unknown;
}

interface PixsoClientStorage {
  getAsync(key: string): Promise<unknown>;
  setAsync(key: string, value: unknown): Promise<void>;
}

interface PixsoUi {
  postMessage(message: unknown): void;
  onmessage: ((message: unknown) => void) | null;
}

interface PixsoApi {
  showUI(html: string, options?: { width?: number; height?: number }): void;
  readonly ui: PixsoUi;
  on(event: "selectionchange", callback: () => void): void;
  readonly currentPage: { readonly selection: ReadonlyArray<SceneNode> };
  readonly clientStorage: PixsoClientStorage;
}

declare const pixso: PixsoApi;
declare const __html__: string;
