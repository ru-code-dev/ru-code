/**
 * MCP Manager (ru-fork) — public surface.
 *
 * Demo feature for browsing a catalog of MCP servers and enabling them per project.
 * Fake-data only. Design rationale + wiring notes live in
 * ru-fork-instrumental/changes/mcp/ (DESIGN.md, README.md).
 */

export { McpPanel } from "./components/McpPanel";
export { McpPanelInlineSidebar } from "./components/McpPanelInlineSidebar";
export {
  isToolEnabled,
  selectProjectBindings,
  selectProjectsForServer,
  selectServerById,
  useMcpManagerStore,
} from "./store";
export type {
  McpPanelTab,
  McpProject,
  McpProjectBinding,
  McpRegistryServer,
  McpServerConfig,
  McpStatus,
  McpTool,
  McpTransport,
} from "./types";
