import type { CodeToUi, UiToCode } from "../shared/messages.ts";
import { bytesToBase64 } from "./base64.ts";
import { validateSelection } from "./selection.ts";
import { serializeNode } from "./serialize.ts";
import { loadSettings, saveSettings } from "./settings.ts";

// pixso.ui.postMessage is the Pixso plugin bridge (not window.postMessage); no targetOrigin.
// oxlint-disable-next-line require-post-message-target-origin
const post = (message: CodeToUi): void => pixso.ui.postMessage(message);

const selectedNode = (): SceneNode | undefined => pixso.currentPage.selection[0];

const postSelectionState = (): void => {
  post({ type: "selection-state", verdict: validateSelection(pixso.currentPage.selection) });
};

// Display preview: capped width — cheap to rasterize + encode, enough for the panel.
const PREVIEW_MAX_WIDTH = 640;

const exportPng = async (
  node: SceneNode,
  constraint: { readonly type: "SCALE" | "WIDTH"; readonly value: number },
): Promise<string> => {
  const bytes = await node.exportAsync({ format: "PNG", constraint });
  return bytesToBase64(bytes);
};

const handlePreviewRequest = async (): Promise<void> => {
  const node = selectedNode();
  if (!node) return postSelectionState();
  const preview = await exportPng(node, { type: "WIDTH", value: PREVIEW_MAX_WIDTH });
  post({ type: "preview-ready", nodeId: node.id, preview, rootName: node.name });
};

const handleCollect = async (): Promise<void> => {
  const node = selectedNode();
  const verdict = validateSelection(pixso.currentPage.selection);
  if (!verdict.ok || !node) return postSelectionState();
  const { nodesJson, nodeCount } = serializeNode(node);
  // Full 1× preview only on send — the server keeps a pixel-perfect copy.
  const preview = await exportPng(node, { type: "SCALE", value: 1 });
  post({ type: "collected", nodesJson, rootName: node.name, preview, nodeCount });
};

const route = (message: UiToCode): void => {
  const run =
    message.type === "request-preview"
      ? handlePreviewRequest()
      : message.type === "collect-and-send-meta"
        ? handleCollect()
        : saveSettings(pixso.clientStorage, message.settings);
  void run.catch((error: unknown) => post({ type: "error", message: String(error) }));
};

pixso.showUI(__html__, { width: 380, height: 560 });
pixso.on("selectionchange", postSelectionState);
// pixso.ui.onmessage is the Pixso bridge callback slot, not a DOM EventTarget.
// oxlint-disable-next-line prefer-add-event-listener
pixso.ui.onmessage = (message) => route(message as UiToCode);

void loadSettings(pixso.clientStorage)
  .then((settings) => post({ type: "settings-loaded", settings }))
  .catch((error: unknown) => post({ type: "error", message: String(error) }));
postSelectionState();
