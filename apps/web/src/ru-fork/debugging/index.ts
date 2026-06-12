// ru-fork: lightweight, gated client-side debug logging shared across layers.
//
// Enable in the browser DevTools console with:
//   localStorage.debugging = "ws"       (then reload)
// The value is a comma/space-separated list of layers, so combine as needed:
//   localStorage.debugging = "ws,mcp"
// Disable with:
//   delete localStorage.debugging       (then reload)
//
// When a layer is not listed, its logs are a no-op with zero console noise. The
// value is read once and cached, so toggling requires a reload — intentional, so
// hot paths (e.g. per-RPC `rpc →`/`rpc ←`) cost nothing in normal use.
//
// WS instrumentation context: ru-fork-instrumental/connection-stability/networking.md §7.

export const DebuggingLayer = {
  ws: "ws",
  mcp: "mcp",
} as const;

export type DebuggingLayer = (typeof DebuggingLayer)[keyof typeof DebuggingLayer];

let activeLayers: ReadonlySet<string> | undefined;

function getActiveLayers(): ReadonlySet<string> {
  if (activeLayers === undefined) {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem("debugging") : null;
      activeLayers = new Set(raw ? raw.split(/[\s,]+/).filter(Boolean) : []);
    } catch {
      activeLayers = new Set<string>();
    }
  }
  return activeLayers;
}

export function isDebugEnabled(layer: DebuggingLayer): boolean {
  return getActiveLayers().has(layer);
}

export function debugLog(
  layer: DebuggingLayer,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!isDebugEnabled(layer)) {
    return;
  }
  const prefix = `[${layer}] ${message}`;
  if (data === undefined) {
    console.debug(prefix);
  } else {
    console.debug(prefix, data);
  }
}

// Convenience wrapper for the WS layer (used by the rpc transport instrumentation).
export function wsDebug(message: string, data?: Record<string, unknown>): void {
  debugLog(DebuggingLayer.ws, message, data);
}
