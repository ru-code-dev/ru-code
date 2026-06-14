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
export type McpStatus =
  | "unchecked"
  | "checking"
  | "connected"
  | "connecting"
  | "degraded"
  | "error"
  | "disabled";

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

/**
 * stdio transport configuration — a pure TEMPLATE. `command`/`args` may contain
 * `${NAME}` holes referencing declared {@link McpVar}s or the builtin
 * `${PROJECT_CWD}`. No `env` here — every var is exported as a process env var by
 * the runtime (see {@link McpVar}). No `timeoutMs` here — it lives on the server.
 */
export interface McpStdioConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Streamable-HTTP transport configuration — a pure TEMPLATE. `httpUrl`/`headers`
 * values may contain `${NAME}` holes (e.g. `Bearer ${TOKEN}`); the referenced var
 * is where the secret lives, the header value itself is a plain template string.
 */
export interface McpHttpConfig {
  readonly transport: "http";
  readonly httpUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/**
 * A named value that parameterizes the catalog template (the identity-lock model).
 * Every var is exported to a stdio process as an env var named {@link name} AND is
 * usable as `${NAME}` in command/args/url/headers.
 *  - `secret`     → value stored server-side (masked, write-only here: "" on read).
 *  - `perProject` → a hole filled per project binding; reveals `required`.
 *  - `required`   → (only meaningful when `perProject`) must resolve to a value or
 *                   the binding is "incomplete" (see {@link McpProjectBinding}).
 * `value` is the catalog-level value: the fixed/shared value, the per-project
 * default, or "" for an empty per-project hole. Secret values read back masked.
 */
export interface McpVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly perProject: boolean;
  readonly required: boolean;
  /** A secret is already stored server-side for this var (value is masked/write-only here). */
  readonly hasStoredSecret: boolean;
  /** shipped = declared by a managed template (declaration read-only); user = added by the user. */
  readonly origin: "shipped" | "user";
  /** The template author shipped a FIXED value for this var (e.g. the company URL) ⇒ value read-only. */
  readonly valueLocked: boolean;
}

/** How a registry entry got into the catalog. */
export type McpServerSource = "builtin" | "custom";

/**
 * A definition in the user's catalog. `tools` and `status` come from the probe
 * of this server's DEFAULT config (cwd-independent), so the Каталог tab reflects
 * what the server actually exposes — shared across every project that uses it.
 */
export interface McpRegistryServer {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: McpServerSource;
  readonly config: McpServerConfig;
  /** Declared vars: secrets, fixed/shared values, and per-project holes. */
  readonly vars: readonly McpVar[];
  /** Default connect/probe timeout in ms; a binding may override. Undefined ⇒ 30s. */
  readonly timeoutMs?: number;
  readonly tools: readonly McpTool[];
  /** Catalog-level probe status; undefined until the default config is first probed. */
  readonly status?: McpStatus;
  /** Last probe failure message (offline) — shown in the list + detail (⑪/⑫). */
  readonly message?: string;
  /** A catalog-default probe is in flight (drives «проверка…» + edit-lock). */
  readonly checking: boolean;
  /** The catalog default cannot be probed — a required, valueless CATALOG-level var exists (item 7). */
  readonly incomplete: boolean;
  /** Required catalog-level var names with no value (tooltip for «требует настройки»). */
  readonly missingVars: readonly string[];
  /**
   * Has a required per-project hole («для проекта» var, no catalog value) ⇒ a «шаблон»: the catalog
   * default is never probed; the server only comes alive once a project supplies the values.
   */
  readonly templateOnly: boolean;
  /** A managed template: command/args read-only; user edits only var values + extraArgs. */
  readonly locked: boolean;
  /** Catalog-level on/off (⑬). Disabled ⇒ not probed, excluded from overlays, rows grayed. */
  readonly enabled: boolean;
  /** ru-fork #6: «Доверять серверу» — true ⇒ qwen auto-approves this server's tools. */
  readonly trust: boolean;
  /** User-appendable args (with `${VAR}` holes), appended to the locked command. */
  readonly extraArgs: readonly string[];
  /** Catalog-level extra/override HTTP headers for a locked http template (B6/⑲). */
  readonly extraHeaders: Readonly<Record<string, string>>;
  /** Non-null ⇒ a managed built-in (hidden id). */
  readonly builtinId: string | null;
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
 * The same `serverId` can appear in multiple projects with different var values.
 * The binding holds NO config — only the per-project values that fill the catalog
 * template's holes, so identity is the catalog's, un-overridable by construction.
 */
export interface McpProjectBinding {
  readonly projectId: string;
  readonly serverId: string;
  /** Master enable switch for this server in this project. */
  readonly enabled: boolean;
  readonly status: McpStatus;
  /** A probe of this binding is in flight (drives «проверка…» + edit-lock). */
  readonly checking: boolean;
  readonly health: McpHealth;
  /**
   * Per-tool enablement override, keyed by tool name. Tools default to enabled;
   * an entry set to `false` disables that single tool for this project only.
   */
  readonly toolOverrides: Readonly<Record<string, boolean>>;
  /**
   * Tools the monitor actually discovered from the live server for THIS binding.
   * Empty until the first probe — the catalog's cached tool list is the fallback.
   */
  readonly discoveredTools: readonly McpTool[];
  /**
   * Per-project values for the catalog's `[для проекта]` vars, keyed by var name.
   * Secret values read back masked (""). A name absent here ⇒ the catalog default
   * applies. Edited only through the project config dialog.
   */
  readonly varValues: Readonly<Record<string, string>>;
  /** Per-project var names that already have a stored secret (masked here). */
  readonly secretVarNames: readonly string[];
  /**
   * `true` when a required per-project var has no value (neither here nor a catalog
   * default). The runtime never spawns an incomplete binding; the UI flags it.
   */
  readonly incomplete: boolean;
  /** Names of the required vars still missing a value (drives the «требует настройки» marker). */
  readonly missingVars: readonly string[];
  /** Per-project connect/probe timeout override in ms. Undefined ⇒ catalog default. */
  readonly timeoutMs?: number;
}

/** Which panel tab is active. */
export type McpPanelTab = "registry" | "projects";
