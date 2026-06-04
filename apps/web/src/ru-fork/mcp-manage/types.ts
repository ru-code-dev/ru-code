/**
 * MCP Manager — domain types (ru-fork, demo / fake-data).
 *
 * Two concepts are kept deliberately separate:
 *  - {@link McpRegistryServer}: an inert *definition* in the user's catalog.
 *  - {@link McpProjectBinding}: that definition *attached to a project*, with its own
 *    enable flag, per-tool overrides and a live connection status (monitored).
 *
 * See ./DESIGN.md for the rationale.
 */

/** Transports the product targets. stdio = local child process; http = streamable HTTP. */
export type McpTransport = "stdio" | "http";

/** Live connection status for a project binding. Catalog definitions are never "live". */
export type McpStatus = "connected" | "connecting" | "degraded" | "error" | "disabled";

/** A single input parameter of an MCP tool (from its JSON schema, when advertised). */
export interface McpToolParam {
  readonly name: string;
  /** JSON-schema-ish type label, e.g. "string", "number", "string[]". */
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

/** A single tool exposed by an MCP server (as discovered from its catalog). */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** Input parameters, when the server advertises a schema. */
  readonly params?: readonly McpToolParam[];
}

/** stdio transport configuration. */
export interface McpStdioConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  /** Environment variables; values may contain `${VAR}` placeholders. */
  readonly env: Readonly<Record<string, string>>;
}

/** Streamable-HTTP transport configuration. */
export interface McpHttpConfig {
  readonly transport: "http";
  readonly httpUrl: string;
  /** Request headers; values may contain `${VAR}` placeholders (e.g. Bearer tokens). */
  readonly headers: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** How a registry entry got into the catalog. */
export type McpServerSource = "builtin" | "custom";

/**
 * A definition in the user's catalog. Inert until bound to a project.
 * `tools` is the *advertised* catalog used for browsing — not a live probe.
 */
export interface McpRegistryServer {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: McpServerSource;
  readonly config: McpServerConfig;
  readonly tools: readonly McpTool[];
  readonly tags: readonly string[];
  readonly docsUrl?: string;
}

/** A project the user can bind MCP servers to. */
export interface McpProject {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
}

/** Lightweight health telemetry shown on a live binding. */
export interface McpHealth {
  /** Round-trip latency of the last successful ping, in ms (undefined when not connected). */
  readonly latencyMs?: number;
  /** Human-readable uptime / last-checked hint. */
  readonly detail: string;
}

/**
 * A registry server attached to a project. This is the monitored, live instance.
 * The same `serverId` can appear in multiple projects with different overrides.
 */
export interface McpProjectBinding {
  readonly projectId: string;
  readonly serverId: string;
  /** Master enable switch for this server in this project. */
  readonly enabled: boolean;
  readonly status: McpStatus;
  readonly health: McpHealth;
  /**
   * Per-tool enablement override, keyed by tool name. Tools default to enabled;
   * an entry set to `false` disables that single tool for this project only.
   */
  readonly toolOverrides: Readonly<Record<string, boolean>>;
  /**
   * Project-specific config that overrides the catalog default for this binding only.
   * `undefined` means "use the registry server's config as-is".
   */
  readonly configOverride?: McpServerConfig;
}

/** Which panel tab is active. */
export type McpPanelTab = "registry" | "projects";
