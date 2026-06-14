// ru-fork: built-in MCP templates — TYPES + pure helpers (the "engine"). The migrator (McpReactor)
// reconciles the shipped definitions against the installed catalog by `builtinId` on every startup:
// add new, update changed (by content hash), remove deleted. Command/args are LOCKED; the user
// configures var VALUES + `extraArgs`. Per-platform variants; a platform with no variant is skipped.
//
// The actual shipped list lives in `./mcpBuiltinDefinitions.ts` (DATA ONLY) — edit that file to add /
// remove / change a built-in; nothing here changes. This file holds only the shape + the functions
// that operate on any `McpBuiltinDefinition`.

import type { McpServerConfig, McpServerVar } from "@t3tools/contracts";
import { fnv1a } from "@ru-fork/mcp-core";

/** A var DECLARATION shipped by a template (no secret value — value is null for secrets). */
export interface McpBuiltinVar {
  readonly name: string;
  readonly secret: boolean;
  readonly perProject: boolean;
  readonly required: boolean;
  /** A non-secret default; null = a hole the user fills. Secrets are always null here. */
  readonly value: string | null;
}

/** A built-in template. `config` is per-platform; the migrator picks `process.platform`. */
export interface McpBuiltinDefinition {
  readonly builtinId: string; // stable hidden reconciliation key — NEVER rename
  readonly name: string;
  readonly description?: string;
  /** Shipped docs/website link — wins over the probe-reported one (B3 ②). Display-only. */
  readonly websiteUrl?: string;
  /** Per-platform locked command/args. A missing key for the current platform ⇒ skip the built-in. */
  readonly config: Partial<Record<NodeJS.Platform, McpServerConfig>> & {
    readonly default?: McpServerConfig;
  };
  readonly vars: ReadonlyArray<McpBuiltinVar>;
  readonly timeoutMs?: number;
}

/** Pick the platform-specific config (current OS, else `default`); null ⇒ unsupported ⇒ skip. */
export function builtinConfigForPlatform(
  definition: McpBuiltinDefinition,
  platform: NodeJS.Platform,
): McpServerConfig | null {
  return definition.config[platform] ?? definition.config.default ?? null;
}

/** Shipped vars as domain `McpServerVar`s (origin:"shipped"; secrets carry value:null). */
export function builtinShippedVars(definition: McpBuiltinDefinition): ReadonlyArray<McpServerVar> {
  return definition.vars.map((variable) => ({
    name: variable.name,
    secret: variable.secret,
    perProject: variable.perProject,
    required: variable.required,
    value: variable.value,
    origin: "shipped",
    // A non-null shipped value is author-fixed ⇒ locked (read-only; the shipped value wins on re-sync).
    // Holes (value:null — credentials/secrets) stay user-fillable.
    valueLocked: variable.value !== null,
  }));
}

/**
 * Content hash of the SHIPPED parts (platform-resolved config + shipped var declarations + timeout +
 * name/description). Drives "shipped template changed → update". Excludes user data by construction
 * (user vars/values/extraArgs are not part of the definition). Stable JSON of sorted keys.
 */
export function builtinHash(config: McpServerConfig, definition: McpBuiltinDefinition): string {
  return fnv1a(
    JSON.stringify({
      name: definition.name,
      description: definition.description ?? null,
      websiteUrl: definition.websiteUrl ?? null,
      config,
      vars: builtinShippedVars(definition),
      timeoutMs: definition.timeoutMs ?? null,
    }),
  );
}

/** The catalog serverId for a built-in (stable, derived from builtinId). */
export function builtinServerId(builtinId: string): string {
  return `srv-builtin-${builtinId}`;
}
