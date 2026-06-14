// Pure: turn a config TEMPLATE + its vars + a binding's per-project var values
// into a fully-resolved runtime config and a stable cache key. No Effect, no IO.
// Secret values are passed in (already materialized from the store), keeping this
// module pure and testable.
//
// Substitution rules (see mcp-vars-redesign.md §D4): only `${NAME}` (braced) is a
// placeholder; `$$` → literal `$`; single-pass (a substituted value is NOT
// re-scanned, so opaque secret values survive verbatim). A `${NAME}` resolves to
// the builtin `${PROJECT_CWD}`, else a declared var's value, else "".

import type {
  McpBinding,
  McpCatalogServer,
  McpServerConfig,
  McpServerVar,
  McpVarValue,
} from "@t3tools/contracts";

/** A config with every var + placeholder resolved to a literal string. */
export interface ResolvedServerConfig {
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  /** Every declared var as a process env var (name → resolved value). stdio only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for a stdio server (= project cwd, or the neutral probe dir). */
  readonly cwd?: string;
  readonly httpUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Connect timeout in ms (undefined ⇒ caller's default). */
  readonly timeoutMs?: number;
}

export interface ResolveContext {
  readonly projectCwd: string;
  /** ref name → plaintext, already materialized from the secret store. */
  readonly secretValues: Readonly<Record<string, string>>;
}

const PROJECT_CWD = "PROJECT_CWD";
// Braced-only `${NAME}` with `$$` escape. NAME is the var charset [A-Z0-9_]+.
const TEMPLATE_PATTERN = /\$\$|\$\{([A-Z0-9_]+)\}/g;

/** Replace `${NAME}` from `lookup` (or `${PROJECT_CWD}`); `$$`→`$`. Single-pass. */
function expandTemplate(
  value: string,
  lookup: Readonly<Record<string, string>>,
  projectCwd: string,
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name?: string) => {
    if (match === "$$") {
      return "$";
    }
    if (name === PROJECT_CWD) {
      return projectCwd;
    }
    return name !== undefined ? (lookup[name] ?? "") : match;
  });
}

/** True when a var value is a secret reference (vs a plain string). */
function isSecretRef(value: McpVarValue): value is { readonly secretRef: string } {
  return typeof value === "object";
}

/**
 * Materialize each var to its final string. The effective value is the binding's
 * override (if any) else the catalog default. Secret values are taken VERBATIM
 * (opaque — never `${}`-expanded); plain values expand `${PROJECT_CWD}` only.
 */
export function resolveVarValues(
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
  context: ResolveContext,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const declared of vars) {
    const effective: McpVarValue | null = declared.name in varValues
      ? varValues[declared.name]!
      : declared.value;
    if (effective === null) {
      resolved[declared.name] = "";
      continue;
    }
    resolved[declared.name] = isSecretRef(effective)
      ? (context.secretValues[effective.secretRef] ?? "") // opaque
      : expandTemplate(effective, {}, context.projectCwd); // plain ⇒ ${PROJECT_CWD} only
  }
  return resolved;
}

/**
 * Names of required vars (at ANY level) with no effective value — neither a binding/override value
 * nor a catalog default. A catalog-level required var makes the CATALOG incomplete; a per-project
 * required var makes the BINDING incomplete. A non-empty result ⇒ the instance must not be probed or
 * spawned (see mcp-specs/current/WORKING-LOGIC.md §8).
 */
export function missingRequiredVars(
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): ReadonlyArray<string> {
  return vars
    .filter((declared) => declared.required)
    .filter((declared) => !(declared.name in varValues) && declared.value === null)
    .map((declared) => declared.name);
}

/** Effective connect timeout: binding override → catalog default → undefined. */
export function effectiveTimeoutMs(
  server: McpCatalogServer,
  binding: McpBinding | null,
): number | undefined {
  return binding?.timeoutMs ?? server.timeoutMs ?? undefined;
}

/** Fully resolve a template + vars for probing/overlay. Pure. */
export function resolveConfig(input: {
  readonly config: McpServerConfig;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly varValues: Readonly<Record<string, McpVarValue>>;
  // User-appended args (after the locked template args). Empty for manual/http servers.
  readonly extraArgs: ReadonlyArray<string>;
  // Catalog-level extra/override headers (http only); merged OVER config.headers. Empty for stdio/manual.
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly timeoutMs: number | undefined;
  readonly context: ResolveContext;
}): ResolvedServerConfig {
  const resolvedVars = resolveVarValues(input.vars, input.varValues, input.context);
  const expand = (value: string) => expandTemplate(value, resolvedVars, input.context.projectCwd);
  const timeout = input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {};
  switch (input.config.transport) {
    case "stdio":
      return {
        transport: "stdio",
        command: expand(input.config.command),
        args: [...input.config.args, ...input.extraArgs].map(expand),
        // Every var is also handed to the process as an environment variable.
        env: resolvedVars,
        // qwen runs the stdio process in the project dir; mirror that.
        cwd: input.context.projectCwd,
        ...timeout,
      };
    case "http": {
      const headers: Record<string, string> = {};
      for (const [key, template] of Object.entries({ ...input.config.headers, ...input.extraHeaders })) {
        headers[key] = expand(template);
      }
      return {
        transport: "http",
        httpUrl: expand(input.config.httpUrl),
        headers,
        ...timeout,
      };
    }
  }
}

/**
 * Stable structural hash of a RESOLVED config. Identical resolved config ⇒ equal
 * hash; any difference (var value, ${PROJECT_CWD}) ⇒ different hash (separate
 * supervisor instances).
 */
export function dedupHash(resolved: ResolvedServerConfig): string {
  return fnv1a(JSON.stringify(canonicalize(resolved)));
}

/**
 * Probe-cache key for an AUTHORED config + vars + the effective (per-project)
 * var values — WITHOUT materializing secrets (refs are stable identifiers) and
 * INDEPENDENT of `${PROJECT_CWD}`/cwd. So two projects on the catalog default (no
 * per-project values) share ONE cache entry; a per-project value gets its own.
 */
export function configCacheKey(
  config: McpServerConfig,
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
  extraArgs: ReadonlyArray<string>,
  extraHeaders: Readonly<Record<string, string>>,
): string {
  const effectiveVars = vars.map((declared) => ({
    name: declared.name,
    secret: declared.secret,
    value: declared.name in varValues ? varValues[declared.name]! : declared.value,
  }));
  return fnv1a(JSON.stringify(canonicalize({ config, vars: effectiveVars, extraArgs, extraHeaders })));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .toSorted()
      .map((key) => [key, canonicalize(record[key])]);
  }
  return value;
}

/** ru-fork: 64-bit FNV-1a → 16 hex chars. Used for the config/dedup/overlay/builtin/identity hashes.
 * Widened from 32-bit so a collision (two different configs sharing a probe-cache row or a supervisor
 * instance) is negligible. Keys are opaque strings everywhere, so widening is transparent. */
export function fnv1a(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * ru-fork: CATALOG-level uniqueness identity. Structural + secret/value-INDEPENDENT: two catalog
 * templates collide iff they target the same transport endpoint with the same arg/header SHAPE and the
 * same declared var NAMES — regardless of credentials or per-project values. Distinct from
 * `configCacheKey` (which includes values/refs). Used only by the catalog config-uniqueness invariant.
 */
export function configIdentity(
  config: McpServerConfig,
  vars: ReadonlyArray<{ readonly name: string }>,
  extraArgs: ReadonlyArray<string>,
  extraHeaders: Readonly<Record<string, string>>,
): string {
  const varNames = vars.map((declared) => declared.name).toSorted();
  return fnv1a(JSON.stringify(canonicalize({ config, varNames, extraArgs, extraHeaders })));
}

/** ru-fork: every distinct `${NAME}` referenced by a config (excludes the builtin `${PROJECT_CWD}`). */
export function configPlaceholders(config: McpServerConfig): ReadonlySet<string> {
  const names = new Set<string>();
  const scan = (value: string): void => {
    for (const match of value.matchAll(TEMPLATE_PATTERN)) {
      const name = match[1];
      if (name !== undefined && name !== PROJECT_CWD) {
        names.add(name);
      }
    }
  };
  if (config.transport === "stdio") {
    scan(config.command);
    for (const arg of config.args) {
      scan(arg);
    }
  } else {
    scan(config.httpUrl);
    for (const headerValue of Object.values(config.headers)) {
      scan(headerValue);
    }
  }
  return names;
}
