/**
 * MCP Manager (ru-fork) — public surface.
 *
 * Browse the MCP catalog and enable servers per project. Backed by real,
 * persistent server state: reads via the `mcp` RPC atoms (rpc/mcpState) + the
 * app's projects, mutations via the mcp.* orchestration commands (see ./useMcp).
 * Design rationale + wiring notes live in ru-fork-instrumental/changes/mcp/.
 */

export { McpPanel } from "./components/McpPanel";
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
