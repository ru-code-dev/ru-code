// ru-fork: MCP (Model Context Protocol) management contracts. Lives in this
// ru-fork-only folder so upstream re-syncs never conflict; consumed by
// orchestration.ts (events/commands), rpc.ts (subscriptions), the server
// subsystem, and @ru-fork/mcp-core. Mirrors ru-fork/skills.ts style.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";

// ── identifiers ──────────────────────────────────────────────────────────────
export const McpServerId = TrimmedNonEmptyString.pipe(Schema.brand("McpServerId"));
export type McpServerId = typeof McpServerId.Type;

/** Singleton aggregate id for the global catalog stream (server-* events). */
export const McpCatalogAggregateId = Schema.Literal("mcp-catalog");
export type McpCatalogAggregateId = typeof McpCatalogAggregateId.Type;
export const MCP_CATALOG_AGGREGATE_ID: McpCatalogAggregateId = "mcp-catalog";

// ── secret-bearing values ────────────────────────────────────────────────────
/** A reference into ServerSecretStore. Authored vars hold these, never plaintext. */
export const McpSecretRef = Schema.Struct({ secretRef: TrimmedNonEmptyString });
export type McpSecretRef = typeof McpSecretRef.Type;

export const McpTransport = Schema.Literals(["stdio", "http"]);
export type McpTransport = typeof McpTransport.Type;

// Connect/probe timeout in ms. Written to BOTH our probe and qwen's overlay so
// the monitor and the real session use the identical value. Optional ⇒ default.
export const McpTimeoutMs = Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)));

// ── config v2: a pure TEMPLATE (no secrets here — those live in `vars`). ───────
// command/args/url/headers may contain `${NAME}` holes referencing declared vars
// or the builtin `${PROJECT_CWD}`. headers values are template strings (e.g.
// `Bearer ${TOKEN}`), NOT secret refs — the secret is the referenced var. The
// authored config == the inbound draft (both are plain templates).
export const McpStdioConfig = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
});
export type McpStdioConfig = typeof McpStdioConfig.Type;

export const McpHttpConfig = Schema.Struct({
  transport: Schema.Literal("http"),
  httpUrl: TrimmedNonEmptyString,
  headers: Schema.Record(Schema.String, Schema.String),
});
export type McpHttpConfig = typeof McpHttpConfig.Type;

export const McpServerConfig = Schema.Union([McpStdioConfig, McpHttpConfig]);
export type McpServerConfig = typeof McpServerConfig.Type;

// ── vars: named values that parameterize the template (the identity-lock model) ─
// Each var is exported as a process env var (stdio) AND usable as `${NAME}` in the
// template. `secret` → value stored in ServerSecretStore (masked, write-only);
// `perProject` → a hole filled per binding (reveals `required`); `required` (only
// meaningful when perProject) → must resolve to a value or the binding is incomplete.
// Authored `value`: null = no catalog value (per-project hole); secret → McpSecretRef;
// plain → string.
export const McpVarValue = Schema.Union([McpSecretRef, Schema.String]);
export type McpVarValue = typeof McpVarValue.Type;

// shipped = declared by a built-in template (replaced wholesale on a template update);
// user = added by the user (preserved across updates). Manual servers: all vars are "user".
export const McpServerVarOrigin = Schema.Literals(["shipped", "user"]);
export type McpServerVarOrigin = typeof McpServerVarOrigin.Type;

export const McpServerVar = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  // "must resolve to a non-empty value" at ANY level: a catalog-level required var with no value
  // makes the CATALOG server incomplete; a per-project required var with no value makes the BINDING
  // incomplete.
  required: Schema.Boolean,
  value: Schema.NullOr(McpVarValue),
  origin: McpServerVarOrigin.pipe(Schema.withDecodingDefault(Effect.succeed<McpServerVarOrigin>("user"))),
  // ru-fork: the template author shipped a FIXED value for this var (a built-in var whose definition
  // value is non-null, e.g. the company Jira URL) ⇒ read-only for the user, and a re-sync re-applies
  // the shipped value (the author owns it). Absent/false ⇒ a user-fillable var (hole or custom). Narrow
  // by nature, so optionalKey like `keepSecret` (NOT a defaulted field like `origin`). Stored in vars_json.
  valueLocked: Schema.optionalKey(Schema.Boolean),
});
export type McpServerVar = typeof McpServerVar.Type;

// Inbound draft var: same flags, plaintext `value` (decider splits secrets → refs).
export const McpServerVarDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  required: Schema.Boolean,
  value: Schema.NullOr(Schema.String),
  // ru-fork: when true for a secret var, the decider PRESERVES the server's existing stored secret
  // ref instead of re-splitting `value` — so editing other fields doesn't wipe a secret the client
  // never had in plaintext. Ignored for non-secret vars / on add (no existing ref).
  keepSecret: Schema.optionalKey(Schema.Boolean),
});
export type McpServerVarDraft = typeof McpServerVarDraft.Type;

// ── tools ────────────────────────────────────────────────────────────────────
export const McpToolParam = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: Schema.String,
  required: Schema.Boolean,
  description: Schema.String,
});
export type McpToolParam = typeof McpToolParam.Type;
export const McpTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  params: Schema.optional(Schema.Array(McpToolParam)),
});
export type McpTool = typeof McpTool.Type;

// ── tool policy (intent, never a frozen allow-list) ──────────────────────────
export const McpToolPolicy = Schema.Struct({
  defaultDecision: Schema.Literals(["allow", "deny"]),
  // Tool names that flip the default (deny-some when allow, allow-some when deny).
  exceptions: Schema.Array(TrimmedNonEmptyString),
});
export type McpToolPolicy = typeof McpToolPolicy.Type;
export const DEFAULT_TOOL_POLICY: McpToolPolicy = { defaultDecision: "allow", exceptions: [] };

// ── authored: catalog server + binding ───────────────────────────────────────
export const McpServerSource = Schema.Literals(["builtin", "custom"]);
export type McpServerSource = typeof McpServerSource.Type;

export const McpCatalogServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  // DB-backed nullable columns use NullOr (matches the projection repos).
  description: Schema.NullOr(TrimmedNonEmptyString),
  // ru-fork: docs/website link. Authored on a built-in (shipped) or auto-filled from the probe's
  // serverInfo.websiteUrl when empty (built-in shipped value wins). Display-only (never user-edited).
  websiteUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  source: McpServerSource,
  config: McpServerConfig, // pure template (command/args LOCKED for templates)
  vars: Schema.Array(McpServerVar), // named values (secrets, fixed, per-project holes)
  // ru-fork: user-appendable args (with `${VAR}` holes), appended after `config.args`. Empty for
  // manual servers (their whole command is editable). The escape hatch for a LOCKED template.
  extraArgs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed<ReadonlyArray<string>>([]))),
  // ru-fork: catalog-level extra/override HTTP headers (with `${VAR}` holes), merged over
  // `config.headers`. The http escape hatch for a LOCKED template, symmetric with extraArgs.
  extraHeaders: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed<Readonly<Record<string, string>>>({})),
  ),
  // ru-fork: catalog-level on/off. Disabled ⇒ excluded from probes + every project overlay, but
  // bindings are kept (re-enable restores them); project rows show it grayed, not removed.
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // ru-fork #6: «Доверять серверу» — true ⇒ qwen runs this server's tools without confirmation (the
  // folder is trusted; emitted as `trust` in the overlay); false ⇒ write tools prompt (read-only tools
  // are always auto-allowed by qwen). Catalog-level — a change respawns every project's session via the
  // overlay fingerprint.
  trust: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // ru-fork: managed-built-in identity. builtinId = stable hidden reconciliation key (null for
  // manual). builtinHash = content hash of the shipped definition last applied. locked = the
  // command/args are read-only (a template).
  builtinId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  builtinHash: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  locked: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Default connect/probe timeout (a binding may override). NullOr for the DB column.
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
  // Status + discovered tools live in the probe cache (McpProbeRecord), keyed by
  // configCacheKey — surfaced to the UI via McpCatalogRuntimeSnapshot, not here.
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type McpCatalogServer = typeof McpCatalogServer.Type;

// A binding holds NO config — only the per-project var values (fills the holes),
// an optional timeout override, the tool policy, and the enable flag. Identity is
// the catalog's, un-overridable by construction.
export const McpBinding = Schema.Struct({
  projectId: ProjectId,
  serverId: McpServerId,
  enabled: Schema.Boolean,
  toolPolicy: McpToolPolicy,
  varValues: Schema.Record(Schema.String, McpVarValue),
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type McpBinding = typeof McpBinding.Type;

// ── probe cache (persisted; one row per AUTHORED config, keyed by configCacheKey) ─
// The single source for status + discovered tools. Shared by all bindings that
// use the same authored config (catalog default); a per-project override gets
// its own row. Written by the prober on every probe; read by the UI.
export const McpProbeStatus = Schema.Literals(["online", "offline"]);
export type McpProbeStatus = typeof McpProbeStatus.Type;

export const McpProbeRecord = Schema.Struct({
  configKey: TrimmedNonEmptyString,
  transport: McpTransport,
  status: McpProbeStatus,
  tools: Schema.Array(McpTool),
  lastError: Schema.NullOr(Schema.String),
  // ru-fork: serverInfo.description / serverInfo.websiteUrl reported by the server on connect.
  // Back-filled (only-if-empty) onto the catalog by the reactor; null when the server reports none.
  serverDescription: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  serverWebsiteUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  checkedAt: IsoDateTime,
  /** Epoch ms of the probe — used by the supervisor's due check on hydration. */
  checkedAtMs: Schema.Int,
});
export type McpProbeRecord = typeof McpProbeRecord.Type;

// ── derived runtime (in-memory; one row per (project,server)) ─────────────────
export const McpRuntimeStatus = Schema.Literals([
  "unchecked", // never probed and no cache row — idle, awaiting a manual/change-driven probe
  "online",
  "degraded",
  "offline",
]);
export type McpRuntimeStatus = typeof McpRuntimeStatus.Type;

export const McpRuntimeSnapshot = Schema.Struct({
  projectId: ProjectId,
  serverId: McpServerId,
  status: McpRuntimeStatus,
  // true while a probe of this instance is in flight (sweep / manual / change-driven), independent
  // of `status` so the UI shows «проверка…» without losing the last result.
  checking: Schema.Boolean,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  effectiveAllowedTools: Schema.Array(TrimmedNonEmptyString),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpRuntimeSnapshot = typeof McpRuntimeSnapshot.Type;

// Catalog-level runtime: one row per catalog server (keyed by serverId), surfaced
// from the probe of that server's DEFAULT config. cwd-independent, so it is shared
// by every project on the default and shown in the Каталог tab even when unbound.
export const McpCatalogRuntimeSnapshot = Schema.Struct({
  serverId: McpServerId,
  status: McpRuntimeStatus,
  checking: Schema.Boolean,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpCatalogRuntimeSnapshot = typeof McpCatalogRuntimeSnapshot.Type;

// ── command drafts/patches (inbound; plaintext var values allowed) ───────────
// Optional timeout (ms; null clears) lives on the draft/patch, not the config.
const McpTimeoutMsDraft = Schema.optional(
  Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
);

export const McpServerDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  config: McpServerConfig,
  vars: Schema.Array(McpServerVarDraft),
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
  extraHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // ru-fork #6: «Доверять серверу» (default true). Omitted ⇒ buildAddedServer defaults to true.
  trust: Schema.optionalKey(Schema.Boolean),
  timeoutMs: McpTimeoutMsDraft,
});
export type McpServerDraft = typeof McpServerDraft.Type;

export const McpServerDraftPatch = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  // ru-fork: docs link backfill (reactor) — display-only, not user-editable.
  websiteUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  config: Schema.optionalKey(McpServerConfig),
  vars: Schema.optionalKey(Schema.Array(McpServerVarDraft)),
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
  extraHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // ru-fork: catalog-level on/off toggle (⑬).
  enabled: Schema.optionalKey(Schema.Boolean),
  // ru-fork #6: «Доверять серверу» (catalog-level auto-approve).
  trust: Schema.optionalKey(Schema.Boolean),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
export type McpServerDraftPatch = typeof McpServerDraftPatch.Type;

// Per-project values for the catalog's `[для проекта]` vars (plaintext; the
// decider splits secret vars → refs). enabled/toolPolicy/timeout are per-project.
export const McpBindingPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  toolPolicy: Schema.optionalKey(McpToolPolicy),
  varValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // ru-fork: per-project secret var names whose stored ref must be PRESERVED (the client left the
  // masked field untouched). Kept from the existing binding even though they are absent from /
  // blank in `varValues`. Also used by the orphaned-varValues prune (item 11).
  keepVarValues: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
export type McpBindingPatch = typeof McpBindingPatch.Type;

// ── read-model snapshot + stream events (used by rpc.ts) ─────────────────────
export const McpSnapshot = Schema.Struct({
  catalog: Schema.Array(McpCatalogServer),
  bindings: Schema.Array(McpBinding),
});
export type McpSnapshot = typeof McpSnapshot.Type;

// The server pushes a full snapshot on every authored change (low-frequency admin edits), so the
// client is a pure replace — no per-row delta reconciliation needed.
export const McpProjectionStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: McpSnapshot,
});
export type McpProjectionStreamEvent = typeof McpProjectionStreamEvent.Type;

// One full runtime snapshot per change (debounced server-side). Carrying the
// whole set keeps the client a pure replace — no per-row delta reconciliation —
// and lets project rows + catalog rows update from a single event.
export const McpRuntimeStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  runtimes: Schema.Array(McpRuntimeSnapshot),
  catalogRuntimes: Schema.Array(McpCatalogRuntimeSnapshot),
});
export type McpRuntimeStreamEvent = typeof McpRuntimeStreamEvent.Type;

export class McpError extends Schema.TaggedErrorClass<McpError>()("McpError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `MCP error: ${this.detail}`;
  }
}

// ── command payload helper types (consumed by orchestration.ts) ──────────────
// Re-declared here so orchestration.ts can import draft/patch/id types from one
// ru-fork module without widening @t3tools/contracts' public surface elsewhere.
export const McpServerAddedPayload = Schema.Struct({ server: McpCatalogServer });
export const McpServerUpdatedPayload = Schema.Struct({ server: McpCatalogServer });
export const McpServerRemovedPayload = Schema.Struct({
  serverId: McpServerId,
  removedAt: IsoDateTime,
});
export const McpBindingSetPayload = Schema.Struct({ binding: McpBinding });
export const McpBindingRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  serverId: McpServerId,
  removedAt: IsoDateTime,
});
