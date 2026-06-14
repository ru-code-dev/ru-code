# MCP management — Data Model reference

> The exhaustive catalogue of every schema, SQL table, and key-derivation function. All Effect
> `Schema` definitions live in `packages/contracts/src/ru-fork/mcp.ts` unless noted. `TrimmedNonEmptyString`,
> `IsoDateTime`, `ProjectId`, `NonNegativeInt` come from `contracts/baseSchemas.ts`. Decoding defaults use
> `Schema.withDecodingDefault(Effect.succeed(x))` (takes an Effect, not a thunk).

## 1. Identifiers & primitives

| Schema | Definition | Notes |
|---|---|---|
| `McpServerId` | `TrimmedNonEmptyString.pipe(Schema.brand("McpServerId"))` | Branded. Built-in ids are `srv-builtin-<builtinId>`; manual adds use `srv-<uuid>` (web). |
| `McpCatalogAggregateId` | `Schema.Literal("mcp-catalog")` + const `MCP_CATALOG_AGGREGATE_ID` | The singleton catalog aggregate. |
| `McpSecretRef` | `Schema.Struct({ secretRef: TrimmedNonEmptyString })` | A reference into `ServerSecretStore`. Authored vars hold these, never plaintext. |
| `McpTransport` | `Schema.Literals(["stdio","http"])` | |
| `McpTimeoutMs` | `Schema.optional(Schema.Int.check(isGreaterThanOrEqualTo(1000)))` | Connect/probe timeout (ms). |

## 2. Config (the template)

| Schema | Fields |
|---|---|
| `McpStdioConfig` | `transport:"stdio"`, `command: TrimmedNonEmptyString`, `args: Array(String)` |
| `McpHttpConfig` | `transport:"http"`, `httpUrl: TrimmedNonEmptyString`, `headers: Record(String,String)` |
| `McpServerConfig` | `Union([McpStdioConfig, McpHttpConfig])` |

`command`/`args`/`httpUrl`/`headers` values may contain `${NAME}` holes (declared vars or the builtin
`${PROJECT_CWD}`). Header values are *template strings* (e.g. `Bearer ${TOKEN}`), **not** secret refs —
the secret is the referenced var. There is **no** `env` block (every var is exported as a process env
var) and **no** `timeoutMs` (it lives on the server/binding).

## 3. Vars (the identity-lock model)

| Schema | Fields |
|---|---|
| `McpVarValue` | `Union([McpSecretRef, String])` — a stored secret ref, or a plain string. |
| `McpServerVarOrigin` | `Literals(["shipped","user"])` — `shipped` = from a built-in template (replaced wholesale on update); `user` = added by the user (preserved). |
| `McpServerVar` | `name: TrimmedNonEmptyString`, `secret: Boolean`, `perProject: Boolean`, `required: Boolean`, `value: NullOr(McpVarValue)`, `origin` (decoding default `"user"`). |
| `McpServerVarDraft` | inbound: `name, secret, perProject, required`, `value: NullOr(String)` (PLAINTEXT), `keepSecret?: Boolean` (optionalKey). |

Semantics: `secret` → stored in `ServerSecretStore` (masked write-only in UI). Every var is exported
to the spawned MCP process as an **env var** (resolver `env: resolvedVars`) and may also appear as
`${VAR}` in command/args/url/headers.

**Every var is `required: true`** — there is no longer an «обязательно» user toggle (the web
`uiVarsToDraft` always sets `required: true`). A var is one of two kinds, selected by `perProject`:

- `perProject: false` = a **catalog value** (filled in the catalog, shared by all projects). Empty
  (`value === null`) ⇒ the catalog server is incomplete («требует настройки»).
- `perProject: true` = a **per-project hole** — it has NO catalog value (`value` is always `null`;
  the editor clears + disables the value field). Filled by each project's binding. ⇒ the catalog
  can't probe its default ⇒ «шаблон».

`required` applies at **any** level (per the contract comment on `McpServerVar.required`): a
catalog-level required var with no value makes the CATALOG incomplete; a per-project required var
with no value makes the BINDING incomplete. Empty is **always** `value === null` — the form maps any
empty input to null; there is no meaningful empty-string for vars. `value`: `null` = no catalog
value; secret → `McpSecretRef`; plain → string. `keepSecret` (draft only): for a secret var,
preserve the existing stored ref instead of re-splitting `value` (so editing other fields never
wipes an untouched secret).

## 4. Tools & tool policy

| Schema | Fields |
|---|---|
| `McpToolParam` | `name: TrimmedNonEmptyString`, `type: String`, `required: Boolean`, `description: String`. (Type alias `McpToolParam` is exported.) |
| `McpTool` | `name: TrimmedNonEmptyString`, `description: String`, `params?: Array(McpToolParam)` (optional). |
| `McpToolPolicy` | `defaultDecision: Literals(["allow","deny"])`, `exceptions: Array(TrimmedNonEmptyString)`. + const `DEFAULT_TOOL_POLICY = { defaultDecision:"allow", exceptions:[] }`. |

Policy is *intent*, never a frozen allow-list: `allow` ⇒ exceptions are the *denied* names; `deny` ⇒
exceptions are the *allowed* names. qwen intersects with discovered tools at runtime.

## 5. Authored aggregates

### `McpCatalogServer` (one per catalog row)
`id: McpServerId`, `name: TrimmedNonEmptyString`, `description: NullOr(TrimmedNonEmptyString)`,
`websiteUrl: NullOr(String)` (decoding default `null` — docs/website link; authored on a built-in or
back-filled from the probe's `serverInfo.websiteUrl` when empty, built-in value wins; display-only,
never user-edited), `source: McpServerSource ("builtin"|"custom")`, `config: McpServerConfig`
(template), `vars: Array(McpServerVar)`, `extraArgs: Array(String)` (decoding default `[]` —
user-appendable args after `config.args`, the escape hatch for a locked template),
`extraHeaders: Record(String,String)` (decoding default `{}` — catalog-level extra/override HTTP
headers with `${VAR}` holes, merged OVER `config.headers`; the http escape hatch, symmetric with
extraArgs), `enabled: Boolean` (decoding default `true` — catalog-level on/off; disabled ⇒ excluded
from probes + every project overlay, but bindings are kept), `builtinId: NullOr(TrimmedNonEmptyString)`
(decoding default `null` — stable hidden reconciliation key), `builtinHash: NullOr(TrimmedNonEmptyString)`
(decoding default `null` — content hash of the shipped definition last applied), `locked: Boolean`
(decoding default `false` — command/args read-only), `timeoutMs: NullOr(Int≥1000)`,
`createdAt: IsoDateTime`, `updatedAt: IsoDateTime`.

> Status + discovered tools are **not** on this row — they live in the probe cache, keyed by `configCacheKey`.

### `McpBinding` (one per project↔server)
`projectId: ProjectId`, `serverId: McpServerId`, `enabled: Boolean`, `toolPolicy: McpToolPolicy`,
`varValues: Record(String, McpVarValue)`, `timeoutMs: NullOr(Int≥1000)`, `createdAt`, `updatedAt`.
**No config** — only the per-project var values that fill the catalog template's holes.

## 6. Probe cache & runtime snapshots

| Schema | Fields | Lifetime |
|---|---|---|
| `McpProbeStatus` | `Literals(["online","offline"])` | persisted statuses only |
| `McpProbeRecord` | `configKey: TrimmedNonEmptyString`, `transport`, `status: McpProbeStatus`, `tools: Array(McpTool)`, `lastError: NullOr(String)`, `serverDescription: NullOr(String)` (decoding default `null`), `serverWebsiteUrl: NullOr(String)` (decoding default `null`; both = `serverInfo.*` reported on connect, back-filled only-if-empty onto the catalog), `checkedAt: IsoDateTime`, `checkedAtMs: Int` | **persisted** (one row per authored config) |
| `McpRuntimeStatus` | `Literals(["unchecked","online","degraded","offline"])` | in-memory |
| `McpRuntimeSnapshot` | `projectId, serverId, status, checking: Boolean, message?, latencyMs?, discoveredTools: Array(McpTool), effectiveAllowedTools: Array(TrimmedNonEmptyString), checkedAt?` | per (project,server), streamed |
| `McpCatalogRuntimeSnapshot` | `serverId, status, checking, message?, latencyMs?, discoveredTools, checkedAt?` | per catalog server (default config), streamed |

## 7. Drafts, patches, snapshots, stream events

| Schema | Fields |
|---|---|
| `McpServerDraft` | `name`, `description?`, `config`, `vars: Array(McpServerVarDraft)`, `extraArgs?` (optionalKey), `extraHeaders?` (optionalKey Record), `timeoutMs?` (optional NullOr Int≥1000). |
| `McpServerDraftPatch` | all optionalKey: `name`, `description: NullOr`, `websiteUrl: NullOr` (reactor backfill — display-only, not user-editable), `config`, `vars`, `extraArgs`, `extraHeaders` (Record), `enabled: Boolean`, `timeoutMs: NullOr`. |
| `McpBindingPatch` | all optionalKey: `enabled`, `toolPolicy`, `varValues: Record(String,String)` (PLAINTEXT), `keepVarValues: Array(String)`, `timeoutMs: NullOr`. |
| `McpSnapshot` | `catalog: Array(McpCatalogServer)`, `bindings: Array(McpBinding)`. |
| `McpProjectionStreamEvent` | `Union`: `{snapshot}`, `{catalog-upserted, server}`, `{catalog-removed, serverId}`, `{binding-upserted, binding}`, `{binding-removed, projectId, serverId}`. **(Server only ever emits `snapshot` — see AUDIT §B5.)** |
| `McpRuntimeStreamEvent` | `{ type:"snapshot", runtimes: Array(McpRuntimeSnapshot), catalogRuntimes: Array(McpCatalogRuntimeSnapshot) }`. |
| `McpError` | `TaggedErrorClass` with `detail: String`, `cause?: Defect`. |
| payload helpers | `McpServerAddedPayload {server}`, `McpServerUpdatedPayload {server}`, `McpServerRemovedPayload {serverId, removedAt}`, `McpBindingSetPayload {binding}`, `McpBindingRemovedPayload {projectId, serverId, removedAt}`. |

## 8. Commands & events (`orchestration.ts`)

**Commands** (client-dispatchable unless noted):

| Command | Fields |
|---|---|
| `mcp.server-add` | `commandId, serverId, draft: McpServerDraft, createdAt: IsoDateTime` |
| `mcp.server-update` | `commandId, serverId, patch: McpServerDraftPatch` |
| `mcp.server-remove` | `commandId, serverId` |
| `mcp.binding-set` | `commandId, projectId, serverId, patch: McpBindingPatch` |
| `mcp.binding-remove` | `commandId, projectId, serverId` |
| `mcp.builtin-sync` | **INTERNAL** (reactor-only): `commandId, serverId, builtinId, builtinHash, name, description: NullOr, websiteUrl: NullOr(String), config: McpServerConfig, shippedVars: Array(McpServerVar), timeoutMs: NullOr(Int≥1000)` |

`mcp.server-*` are in `DispatchableClientOrchestrationCommand`; `mcp.builtin-sync` is in
`InternalOrchestrationCommand` (not client-forgeable). Aggregate routing (`OrchestrationEngine`):
`mcp.server-*` + `mcp.builtin-sync` → `mcp-catalog`; `mcp.binding-*` → `project`.

**Events** (`OrchestrationEvent` union + `OrchestrationEventType` literals): `mcp.server-added`,
`mcp.server-updated`, `mcp.server-removed`, `mcp.binding-set`, `mcp.binding-removed`. `mcp.builtin-sync`
reuses `mcp.server-added`/`mcp.server-updated` — **no dedicated event**.

## 9. SQL schema (`031_Mcp.ts`)

```sql
CREATE TABLE mcp_catalog_server (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  website_url        TEXT,
  source             TEXT NOT NULL,
  config_json        TEXT NOT NULL,
  vars_json          TEXT NOT NULL DEFAULT '[]',
  extra_args_json    TEXT NOT NULL DEFAULT '[]',
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  builtin_id         TEXT,
  builtin_hash       TEXT,
  locked             INTEGER NOT NULL DEFAULT 0,   -- 0/1 → boolean via rowToServer
  enabled            INTEGER NOT NULL DEFAULT 1,   -- 0/1 → boolean via rowToServer
  timeout_ms         INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE mcp_project_binding (
  project_id       TEXT NOT NULL,
  server_id        TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,  -- 0/1 → boolean via rowToBinding
  tool_policy_json TEXT NOT NULL DEFAULT '{"defaultDecision":"allow","exceptions":[]}',
  var_values_json  TEXT NOT NULL DEFAULT '{}',
  timeout_ms       INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (project_id, server_id)
);
CREATE INDEX idx_mcp_binding_project ON mcp_project_binding(project_id);
CREATE INDEX idx_mcp_binding_server  ON mcp_project_binding(server_id);

CREATE TABLE mcp_probe_cache (
  config_key         TEXT PRIMARY KEY,             -- = configCacheKey
  transport          TEXT NOT NULL,
  status             TEXT NOT NULL,                -- online|offline
  tools_json         TEXT NOT NULL DEFAULT '[]',
  last_error         TEXT,
  server_description TEXT,                         -- serverInfo.description (back-fill source)
  server_website_url TEXT,                         -- serverInfo.websiteUrl (back-fill source)
  checked_at         TEXT NOT NULL,                -- ISO, for display
  checked_at_ms      INTEGER NOT NULL DEFAULT 0    -- epoch ms, for the due-check
);
```

JSON columns decode via `Schema.fromJsonString(...)` in the row schema (`*DbRow = X.mapFields(Struct.assign({…}))`);
booleans are stored `? 1 : 0` and decoded via `NonNegativeInt` + a `rowToX` converter (`enabled !== 0`,
`locked !== 0`).

## 10. Settings (`settings.ts` → `ServerSettings.mcp`)

```
mcp: {
  autobindDefaults:    Boolean (default false)   // auto-attach built-ins to new projects
  recheckLocalMinutes:  Int≥0  (default 30)       // stdio auto-recheck cadence; 0 = off
  recheckRemoteMinutes: Int≥0  (default 30)       // http auto-recheck cadence;  0 = off
}   // whole block has decoding default {}
```
`ServerSettingsPatch.mcp` mirrors these as optionalKey fields.

## 11. Provider spawn input (`provider.ts` → `ProviderSessionStartInput`)

```
settingsOverlayPath?: TrimmedNonEmptyString   // highest-precedence CLI settings file (QWEN_CODE_SYSTEM_SETTINGS_PATH)
allowedMcpServers?:   Array(String)           // qwen --allowed-mcp-server-names (opaque server names)
```
Both optional, independent; absent ⇒ today's spawn behaviour. Named for what they are, not masked under a generic key.

## 12. WS RPC surface (`rpc.ts`)

| Method (`WS_METHODS`) | Payload → Success / Stream |
|---|---|
| `mcp.getSnapshot` | `{ projectId: NullOr(ProjectId) }` → `McpSnapshot` |
| `mcp.setActiveProject` | `{ projectId: NullOr(ProjectId) }` → `Void` (fire-and-forget; scopes the sweep) |
| `mcp.recheck` | `{ projectId?, serverId?, transport? }` → `Void` (force-probe) |
| `subscribeMcpProjection` | `{}` → stream `McpProjectionStreamEvent` |
| `subscribeMcpRuntime` | `{}` → stream `McpRuntimeStreamEvent` |

Mutations are **not** here — they go through `orchestration.dispatchCommand` (the 5 `mcp.*` commands).

## 13. Key-derivation functions (`mcp-core/resolver.ts`, `fingerprint.ts`, `McpBuiltins.ts`, `McpSecretNames.ts`)

| Function | Inputs | Output / purpose |
|---|---|---|
| `dedupHash(resolved)` | a `ResolvedServerConfig` (INCLUDES cwd) | `fnv1a(canonicalize(resolved))` — **registry** key. Different cwd/value ⇒ different instance. |
| `configCacheKey(config, vars, varValues, extraArgs, extraHeaders)` | authored config + effective var values + extra args/headers, **NO cwd, NO materialized secrets** | `fnv1a(canonicalize({config, vars:{name,secret,value}, extraArgs, extraHeaders}))` — **probe-cache** key. Two projects on the default share one. |
| `overlayFingerprint(entries)` | per server `{serverName, dedupHash(resolved), policy.defaultDecision, sorted exceptions}`, sorted by name | `fnv1a` — drives the turn-start restart decision. Policy-based, subsumes the allow-list. |
| `builtinHash(config, definition)` | platform-resolved config + shipped vars + name/description/websiteUrl/timeout | inline FNV-1a — drives "shipped template changed → update". |
| `mcpVarSecretName({serverId, varName, projectId?})` | | `mcp-var-<b64url(serverId)>-<b64url(varName)>[-<b64url(projectId)>]` — `ServerSecretStore` key. |

`canonicalize` recursively sorts object keys (so key order never affects a hash); `fnv1a` is 32-bit
FNV-1a → 8 hex chars.
