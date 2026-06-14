// ru-fork: pure builders that turn MCP commands + (already split) vars into the
// catalog/binding records the events carry. Kept out of the shared decider so the
// decider branches stay thin (validate → split secrets → build → emit).

import {
  DEFAULT_TOOL_POLICY,
  type McpBinding,
  type McpBindingPatch,
  type McpCatalogServer,
  type McpServerConfig,
  type McpServerDraft,
  type McpServerDraftPatch,
  type McpServerId,
  type McpServerVar,
  type McpServerVarDraft,
  type McpVarValue,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type SecretStoreError, ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { splitBindingVarValues, splitServerVars } from "./McpSecrets.ts";

/**
 * A catalog server from a manual add command (config = template; vars already split). Manual servers
 * are always `source:"custom"`, never locked, with no built-in identity — managed templates come in
 * only via the migrator's `buildSyncedBuiltin` (never the user draft path), so editing never forks.
 */
export function buildAddedServer(
  serverId: McpServerId,
  draft: McpServerDraft,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: serverId,
    name: draft.name,
    description: draft.description ?? null,
    websiteUrl: null, // a manual server has no shipped link; fills from its own probe (B3 ②)
    source: "custom",
    config: draft.config,
    vars,
    extraArgs: draft.extraArgs ?? [],
    extraHeaders: draft.extraHeaders ?? {},
    builtinId: null,
    builtinHash: null,
    locked: false,
    enabled: true,
    trust: draft.trust ?? true, // ru-fork #6: default «доверять» (auto-approve)
    timeoutMs: draft.timeoutMs ?? null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

// undefined ⇒ keep existing; otherwise the patch wins (null clears, string sets).
function applyDescriptionPatch(
  existing: McpCatalogServer["description"],
  patch: McpServerDraftPatch["description"],
): McpCatalogServer["description"] {
  return patch === undefined ? existing : patch;
}

/**
 * Apply an update patch to an existing server. Never forks: a managed template keeps its
 * `source:"builtin"`, locked command, and built-in identity (the decider rejects a config patch for a
 * locked template); a manual server stays `custom`. `extraArgs` is the user's escape hatch on a
 * locked template.
 */
export function applyServerUpdate(
  existing: McpCatalogServer,
  patch: McpServerDraftPatch,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: existing.id,
    name: patch.name ?? existing.name,
    description: applyDescriptionPatch(existing.description, patch.description),
    // websiteUrl: backfilled (only-if-empty) or shipped — never user-cleared, so `?? existing` is safe.
    websiteUrl: patch.websiteUrl ?? existing.websiteUrl,
    source: existing.source,
    // A locked template keeps its shipped command; the decider rejects a config patch for it.
    config: existing.locked ? existing.config : (patch.config ?? existing.config),
    vars,
    extraArgs: patch.extraArgs ?? existing.extraArgs,
    extraHeaders: patch.extraHeaders ?? existing.extraHeaders,
    builtinId: existing.builtinId,
    builtinHash: existing.builtinHash,
    locked: existing.locked,
    enabled: patch.enabled ?? existing.enabled,
    trust: patch.trust ?? existing.trust, // ru-fork #6
    timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs,
    createdAt: existing.createdAt,
    updatedAt: occurredAt,
  };
}

/** A binding from a binding-set command, merged over any existing binding. */
export function buildBinding(input: {
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
  readonly patch: McpBindingPatch;
  readonly existing: McpBinding | undefined;
  readonly varValues: Readonly<Record<string, McpVarValue>>;
  readonly occurredAt: string;
}): McpBinding {
  return {
    projectId: input.projectId,
    serverId: input.serverId,
    enabled: input.patch.enabled ?? input.existing?.enabled ?? true,
    toolPolicy: input.patch.toolPolicy ?? input.existing?.toolPolicy ?? DEFAULT_TOOL_POLICY,
    varValues: input.varValues,
    timeoutMs:
      input.patch.timeoutMs !== undefined ? input.patch.timeoutMs : (input.existing?.timeoutMs ?? null),
    createdAt: input.existing?.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

/**
 * Resolve a binding's per-project var-values patch, splitting secret vars into the
 * store. undefined ⇒ keep existing; otherwise replace with the split draft values.
 */
export function resolveBindingVarValues(input: {
  readonly patch: Readonly<Record<string, string>> | undefined;
  readonly keepNames: ReadonlyArray<string> | undefined;
  readonly existing: Readonly<Record<string, McpVarValue>>;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> {
  if (input.patch === undefined) {
    return Effect.succeed({ ...input.existing });
  }
  return splitBindingVarValues({
    projectId: input.projectId,
    serverId: input.serverId,
    vars: input.vars,
    draftVarValues: input.patch,
    keepNames: input.keepNames ?? [],
    existing: input.existing,
  });
}

/**
 * Build the catalog row for a managed built-in from its shipped definition, merged over any existing
 * row: shipped command/vars REPLACE; user data (origin:"user" vars, var VALUES by name, extraArgs)
 * is PRESERVED. Source is always "builtin", command locked. No secret-store interaction (shipped
 * vars carry value:null; user values are kept verbatim by name).
 */
export function buildSyncedBuiltin(input: {
  readonly serverId: McpServerId;
  readonly builtinId: string;
  readonly builtinHash: string;
  readonly name: string;
  readonly description: string | null;
  readonly websiteUrl: string | null;
  readonly config: McpServerConfig;
  readonly shippedVars: ReadonlyArray<McpServerVar>;
  readonly timeoutMs: number | null;
  readonly existing: McpCatalogServer | undefined;
  readonly occurredAt: string;
}): McpCatalogServer {
  const existingByName = new Map((input.existing?.vars ?? []).map((variable) => [variable.name, variable]));
  const shipped = input.shippedVars.map((variable): McpServerVar => {
    const prior = existingByName.get(variable.name);
    // Keep a value across a re-sync ONLY when it was USER-supplied: a hole the user filled (prior is
    // not author-fixed and holds a value). Otherwise take the shipped value — so an author-fixed
    // (valueLocked) var re-adopts a changed URL, and a var the author turns into a hole (value→null)
    // clears the old author value instead of stranding it. A prior with no valueLocked (pre-bit data)
    // counts as user-supplied if it has a value.
    const keptValue =
      variable.valueLocked !== true &&
      prior !== undefined &&
      prior.value !== null &&
      prior.valueLocked !== true
        ? prior.value
        : variable.value;
    return { ...variable, value: keptValue };
  });
  // User-added vars (origin:"user") survive a template update verbatim.
  const userVars = (input.existing?.vars ?? []).filter((variable) => variable.origin === "user");
  return {
    id: input.serverId,
    name: input.name,
    // Shipped value wins; else preserve a probe-backfilled value so a re-sync never clobbers it (B3 ②).
    description: input.description ?? input.existing?.description ?? null,
    websiteUrl: input.websiteUrl ?? input.existing?.websiteUrl ?? null,
    source: "builtin",
    config: input.config,
    vars: [...shipped, ...userVars],
    extraArgs: input.existing?.extraArgs ?? [],
    extraHeaders: input.existing?.extraHeaders ?? {},
    builtinId: input.builtinId,
    builtinHash: input.builtinHash,
    locked: true,
    enabled: input.existing?.enabled ?? true, // preserve a user's disable across template syncs
    trust: input.existing?.trust ?? true, // ru-fork #6: preserve a user's trust choice across syncs
    timeoutMs: input.timeoutMs,
    createdAt: input.existing?.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

/**
 * Vars for a server-update. An unlocked server: every draft is a user var. A locked template: the
 * shipped DECLARATION SET (which names exist + their secret/perProject/required flags) is immutable
 * — re-stamped from `existing` — but the shipped VALUES are settable (so the user can fill a shipped
 * secret/required at the catalog level), and user-added vars are fully editable. A shipped var the
 * draft omits is preserved untouched.
 */
export function mergeTemplateVars(
  serverId: McpServerId,
  existing: McpCatalogServer,
  draftVars: ReadonlyArray<McpServerVarDraft>,
): Effect.Effect<ReadonlyArray<McpServerVar>, SecretStoreError, ServerSecretStore> {
  return Effect.gen(function* () {
    const split = yield* splitServerVars(serverId, draftVars, existing.vars);
    if (!existing.locked) {
      return split;
    }
    const shippedByName = new Map(
      existing.vars.filter((variable) => variable.origin === "shipped").map((variable) => [variable.name, variable]),
    );
    // Take the new VALUE from the split draft but keep the shipped declaration (origin + flags) for
    // any row matching a shipped name; everything else stays a user var.
    const merged = split.map((variable) => {
      const shipped = shippedByName.get(variable.name);
      return shipped ? { ...shipped, value: variable.value } : variable;
    });
    // Preserve shipped declarations the draft did not include at all.
    const draftNames = new Set(split.map((variable) => variable.name));
    const untouchedShipped = existing.vars.filter(
      (variable) => variable.origin === "shipped" && !draftNames.has(variable.name),
    );
    return [...merged, ...untouchedShipped];
  });
}
