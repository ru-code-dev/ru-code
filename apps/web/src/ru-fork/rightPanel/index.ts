/**
 * Right-panel coordinator (ru-fork) — single source of truth for which global
 * overlay panel is open, plus the panel registry. See ./store for the diff contract.
 */

export { useRightPanelStore } from "./store";
export { OverlayPanelHost } from "./OverlayPanelHost";
export { OVERLAY_PANELS, type OverlayPanel } from "./registry";
