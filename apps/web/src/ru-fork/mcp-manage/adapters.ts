// ru-fork: pure mappers between the wire contracts (@t3tools/contracts) and the
// panel's UI view-types (./types). The UI types are richer/flatter than the
// contracts on purpose — components stay decoupled from the wire shape.
//
// Identity-lock model (mcp-vars-redesign.md): the catalog server is a config
// TEMPLATE + a `vars` block; a binding holds only per-project var VALUES (the
// holes). Secrets never reach the client as plaintext — authored secret vars hold
// a server-side ref, so reads mask their value to "" (write-only): editing a
// secret means re-entering it, and there is no plaintext to leak.

import type {
  McpBinding,
  McpCatalogRuntimeSnapshot,
  McpCatalogServer,
  McpRuntimeSnapshot,
  McpServerConfig as ContractServerConfig,
  McpServerVar as ContractVar,
  McpServerVarDraft,
  McpTool as ContractTool,
  McpToolPolicy,
  McpVarValue,
} from "@t3tools/contracts";

import type {
  McpHealth,
  McpProjectBinding,
  McpRegistryServer,
  McpServerConfig as UiServerConfig,
  McpStatus,
  McpTool,
  McpVar,
} from "./types";

// ── config (pure template — no secrets, no env, no timeout) ──────────────────
export function contractConfigToUi(config: ContractServerConfig): UiServerConfig {
  switch (config.transport) {
    case "stdio":
      return { transport: "stdio", command: config.command, args: [...config.args] };
    case "http":
      return { transport: "http", httpUrl: config.httpUrl, headers: { ...config.headers } };
  }
}

/** UI config (already template-shaped) → command config. Structural pass-through. */
export function uiConfigToContract(config: UiServerConfig): ContractServerConfig {
  return config.transport === "stdio"
    ? { transport: "stdio", command: config.command, args: [...config.args] }
    : { transport: "http", httpUrl: config.httpUrl, headers: { ...config.headers } };
}

// ── vars ─────────────────────────────────────────────────────────────────────
/** A var has a catalog-level value unless it is an empty per-project hole (`value === null`). */
function varValueToUi(value: McpVarValue | null): string {
  if (value === null) {
    return ""; // per-project hole — no catalog value
  }
  // secret → server-side ref → masked (write-only); plain → the literal string.
  return typeof value === "string" ? value : "";
}

/** Contract var → UI var (masks secret values to ""; flags whether a secret is already stored). */
function catalogVarToUi(variable: ContractVar): McpVar {
  return {
    name: variable.name,
    value: varValueToUi(variable.value),
    secret: variable.secret,
    perProject: variable.perProject,
    required: variable.required,
    // A secret whose catalog value is a stored ref ⇒ there IS a saved secret (write-only here).
    hasStoredSecret: variable.secret && variable.value !== null && typeof variable.value === "object",
    origin: variable.origin,
    // Author-fixed shipped value ⇒ read-only in the editor (the URL the deployer locked).
    valueLocked: variable.valueLocked === true,
  };
}

/** UI var rows → inbound draft vars (plaintext; the decider splits secrets → refs). */
export function uiVarsToDraft(vars: ReadonlyArray<McpVar>): McpServerVarDraft[] {
  return vars.map((variable): McpServerVarDraft => {
    // A per-project var has NO catalog value (a pure hole, filled per binding); a catalog var keeps
    // its typed value. So an empty catalog var ⇒ null ⇒ «требует настройки»; a per-project var ⇒ null
    // ⇒ «шаблон».
    const value = variable.perProject ? "" : variable.value.trim();
    // A catalog secret left blank but already stored ⇒ keep the existing ref (don't wipe). Never for a
    // per-project var (no catalog secret).
    const keepSecret =
      !variable.perProject && variable.secret && variable.hasStoredSecret && value.length === 0;
    return {
      name: variable.name,
      secret: variable.secret,
      perProject: variable.perProject,
      // Every var must resolve to a value (catalog-level here, or per-project in the binding).
      required: true,
      ...(keepSecret ? { keepSecret: true } : {}),
      // Empty stays null; when keepSecret is set the decider reuses the stored ref.
      value: value.length > 0 ? value : null,
    };
  });
}

/**
 * Required per-project vars the binding has not filled (no value AND no catalog
 * default). Mirrors `missingRequiredVars` in @ru-fork/mcp-core — recomputed here
 * so the web stays free of a server dependency.
 */
function computeMissingVars(
  vars: ReadonlyArray<ContractVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): string[] {
  return vars
    .filter(
      (variable) =>
        variable.perProject &&
        variable.required &&
        variable.value === null &&
        !(variable.name in varValues),
    )
    .map((variable) => variable.name);
}

/**
 * Required CATALOG-level vars with no value — the catalog config itself is incomplete and the user
 * must fill it HERE (item 7). Per-project required holes are NOT counted (they're filled per project;
 * that's the «шаблон» case, see `hasPerProjectHole`).
 */
function catalogMissingVars(vars: ReadonlyArray<ContractVar>): string[] {
  return vars
    .filter((variable) => !variable.perProject && variable.required && variable.value === null)
    .map((variable) => variable.name);
}

/**
 * True when the server has a required PER-PROJECT hole (a «для проекта» var, no catalog value) — its
 * catalog default can never be probed (the reactor skips it), so it's a «шаблон» usable only once a
 * project supplies the values. Distinct from `catalogMissingVars` (fixable at the catalog level).
 */
function hasPerProjectHole(vars: ReadonlyArray<ContractVar>): boolean {
  return vars.some(
    (variable) => variable.perProject && variable.required && variable.value === null,
  );
}

/** Binding var values → UI map (secret values masked to ""). */
function bindingVarValuesToUi(
  varValues: Readonly<Record<string, McpVarValue>>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(varValues)) {
    masked[name] = typeof value === "string" ? value : "";
  }
  return masked;
}

/** Names whose per-project value is a stored secret ref (a saved secret exists for the project). */
function bindingSecretVarNames(varValues: Readonly<Record<string, McpVarValue>>): string[] {
  return Object.entries(varValues)
    .filter(([, value]) => value !== null && typeof value === "object")
    .map(([name]) => name);
}

/** Contract tools → UI tools. Drops the optional `params` key when absent. */
function toUiTools(tools: ReadonlyArray<ContractTool>): McpTool[] {
  return tools.map((tool): McpTool =>
    tool.params
      ? { name: tool.name, description: tool.description, params: [...tool.params] }
      : { name: tool.name, description: tool.description },
  );
}

export function catalogServerToRegistry(
  server: McpCatalogServer,
  runtime: McpCatalogRuntimeSnapshot | undefined,
): McpRegistryServer {
  const missingVars = catalogMissingVars(server.vars);
  const checking = runtime?.checking ?? false;
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    source: server.source,
    config: contractConfigToUi(server.config),
    vars: server.vars.map(catalogVarToUi),
    ...(server.timeoutMs !== null ? { timeoutMs: server.timeoutMs } : {}),
    // Live tools + status from the probe of the default config (cwd-independent).
    tools: toUiTools(runtime?.discoveredTools ?? []),
    ...(runtime ? { status: runtimeStatusToUi(true, runtime.status, checking) } : {}),
    ...(runtime?.message ? { message: runtime.message } : {}),
    checking,
    incomplete: missingVars.length > 0,
    missingVars,
    templateOnly: hasPerProjectHole(server.vars),
    locked: server.locked,
    enabled: server.enabled,
    trust: server.trust,
    extraArgs: [...server.extraArgs],
    extraHeaders: { ...server.extraHeaders },
    builtinId: server.builtinId,
    // Derive a single transport tag so existing filters keep working.
    tags: [server.config.transport],
    // Docs link: shipped on a built-in or back-filled from the probe (B3 ②).
    ...(server.websiteUrl !== null ? { docsUrl: server.websiteUrl } : {}),
  };
}

export function runtimeStatusToUi(
  enabled: boolean,
  status: McpRuntimeSnapshot["status"] | undefined,
  checking: boolean,
): McpStatus {
  if (!enabled) {
    return "disabled";
  }
  if (checking) {
    return "checking"; // a probe is in flight — show «проверка…» over any prior status
  }
  switch (status) {
    case "online":
      return "connected";
    case "unchecked":
      return "unchecked";
    case undefined: // bound, but the monitor hasn't reported yet
      return "connecting";
    case "degraded":
      return "degraded";
    case "offline":
      return "error";
  }
}

function runtimeDetail(runtime: McpRuntimeSnapshot): string {
  switch (runtime.status) {
    case "online":
      return `Подключено · ${runtime.discoveredTools.length} инструментов`;
    case "unchecked":
      return "Не проверено — нажмите «Проверить»";
    // degraded/offline carry the real probe failure (timeout, npm error,
    // DNS/401, …) — show it so the user sees exactly what went wrong.
    case "degraded":
      return runtime.message ?? "Нестабильное соединение, повторная проверка…";
    case "offline":
      return runtime.message ?? "Не удалось подключиться";
  }
}

function runtimeHealth(runtime: McpRuntimeSnapshot | undefined, enabled: boolean): McpHealth {
  if (!enabled) {
    return { detail: "Отключён в этом проекте" };
  }
  if (!runtime) {
    return { detail: "Подключение…" };
  }
  const detail = runtimeDetail(runtime);
  return runtime.latencyMs !== undefined ? { latencyMs: runtime.latencyMs, detail } : { detail };
}

/**
 * Tool policy + discovered tools → the UI's per-tool override map. A tool is
 * "enabled" unless its entry is explicitly `false` (see `isToolEnabled`).
 *  - default-allow: only the named exceptions are disabled.
 *  - default-deny: every discovered tool except the exceptions is disabled.
 */
function policyToToolOverrides(
  policy: McpToolPolicy,
  discoveredToolNames: ReadonlyArray<string>,
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  const exceptions = new Set(policy.exceptions);
  if (policy.defaultDecision === "allow") {
    for (const name of exceptions) {
      overrides[name] = false;
    }
  } else {
    for (const name of discoveredToolNames) {
      if (!exceptions.has(name)) {
        overrides[name] = false;
      }
    }
  }
  return overrides;
}

export function bindingToUi(
  binding: McpBinding,
  server: McpCatalogServer | undefined,
  runtime: McpRuntimeSnapshot | undefined,
): McpProjectBinding {
  const discovered = runtime?.discoveredTools ?? [];
  const discoveredNames = discovered.map((tool) => tool.name);
  const missingVars = server ? computeMissingVars(server.vars, binding.varValues) : [];
  const checking = runtime?.checking ?? false;
  return {
    projectId: binding.projectId,
    serverId: binding.serverId,
    enabled: binding.enabled,
    // F2: an incomplete binding has no runtime row, so it would otherwise read «Подключение» (blue).
    // Show the neutral «Не проверено» dot instead — the amber «требует настройки» marker carries the why.
    status:
      binding.enabled && missingVars.length > 0
        ? "unchecked"
        : runtimeStatusToUi(binding.enabled, runtime?.status, checking),
    checking,
    health: runtimeHealth(runtime, binding.enabled),
    toolOverrides: policyToToolOverrides(binding.toolPolicy, discoveredNames),
    // Live tools from the probe — what the UI tool list + counts should reflect.
    discoveredTools: toUiTools(discovered),
    varValues: bindingVarValuesToUi(binding.varValues),
    secretVarNames: bindingSecretVarNames(binding.varValues),
    incomplete: missingVars.length > 0,
    missingVars,
    ...(binding.timeoutMs !== null ? { timeoutMs: binding.timeoutMs } : {}),
  };
}

/**
 * One tool toggle → a new tool policy. Normalizes to default-allow with
 * `exceptions` = the disabled tool set, so the on-wire policy is always the
 * simplest representation regardless of how it arrived.
 */
export function toggleToolPolicy(
  binding: McpBinding,
  runtime: McpRuntimeSnapshot | undefined,
  toolName: string,
  enabled: boolean,
): McpToolPolicy {
  const overrides = policyToToolOverrides(
    binding.toolPolicy,
    (runtime?.discoveredTools ?? []).map((tool) => tool.name),
  );
  const disabled = new Set(Object.keys(overrides).filter((name) => overrides[name] === false));
  if (enabled) {
    disabled.delete(toolName);
  } else {
    disabled.add(toolName);
  }
  return { defaultDecision: "allow", exceptions: [...disabled] };
}
