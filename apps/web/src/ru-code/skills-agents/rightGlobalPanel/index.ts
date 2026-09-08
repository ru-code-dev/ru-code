// ru-code: global right-panel (skills/agents) public surface.
export { RightGlobalPanelHost } from "./RightGlobalPanelHost";
export { GlobalPanelNav } from "./GlobalPanelNav";
export {
  navPanels,
  useNavPanels,
  useOverlayPanels,
  overlayPanelById,
  overlayPanels,
  registerOverlayPanel,
  resetRegisteredOverlayPanels,
  OVERLAY_PANELS,
  type OverlayPanel,
  type OverlayPanelIcon,
} from "./registry";
export {
  closeGlobalPanelIfOpen,
  isGlobalPanelOpen,
  makeGlobalPanelId,
  pluginPanelId,
  useRightGlobalPanelStore,
  GLOBAL_PANEL_ID_PATTERN,
  type GlobalPanelId,
  type KnownGlobalPanelId,
  type PluginGlobalPanelId,
} from "./store";
export { installRightSlotExclusion, useRightSlotExclusion } from "./rightSlotExclusion";
export {
  decideRightPanelToggle,
  type RightPanelToggleAction,
  type RightPanelToggleState,
} from "./rightPanelToggleDecision";
