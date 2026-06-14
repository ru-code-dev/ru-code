// ru-fork: deterministic, collision-free ServerSecretStore key for one MCP var
// value. Catalog-level secret vars are keyed by (serverId, varName); per-project
// (binding) secret values add the projectId. Mirrors the base64url compound-key
// scheme used for provider environment secrets (serverSettings.ts).

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** Shared prefix of every MCP var secret name — used by the reactor's secret GC (item 10). */
export const MCP_VAR_SECRET_PREFIX = "mcp-var-";

export function mcpVarSecretName(input: {
  readonly serverId: string;
  readonly varName: string;
  /** Present ⇒ a per-binding (per-project) secret value; absent ⇒ catalog-level. */
  readonly projectId?: string;
}): string {
  const base = `${MCP_VAR_SECRET_PREFIX}${encode(input.serverId)}-${encode(input.varName)}`;
  return input.projectId === undefined ? base : `${base}-${encode(input.projectId)}`;
}
