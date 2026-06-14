# MCP management — Implementation reconstruction spec

> Goal: enough detail to recreate the feature 1:1. This document is the *how* (signatures, algorithms,
> wiring, file layout, conventions). Shapes are in [`DATA-MODEL.md`](./DATA-MODEL.md); runtime behaviour
> is in [`WORKING-LOGIC.md`](./WORKING-LOGIC.md). Where this doc says "see DATA-MODEL", the field-level
> definition is there.

## 0. Conventions (apply to every file)

- **Effect 4.x** idioms: `Effect.gen`, `Context.Service`, `Layer.effect/mergeAll/provideMerge`,
  `Ref`, `PubSub`, `Stream`, `Schedule`. Use `Effect.catch` (not `catchAll`), `Effect.catchCause`
  for background loops. `Schema.withDecodingDefault(Effect.succeed(x))` (an Effect, not a thunk).
  No `Effect.zipRight` (absent in this build — use a gen block). `.toSorted()` not `.sort()`.
- **No casts**: avoid `as` / `any` / `unknown` casts (`as const` on a literal is allowed). Narrow with
  `typeof` + `in` guards. (Existing exceptions to flag, not copy: see `AUDIT.md`.)
- **Logging**: only `Effect.logDebug` (traces) and `Effect.logError` (failures). Never info/warn.
- **ru-fork isolation**: all MCP code in `ru-fork/` folders / `Mcp*` files; mark deltas in shared files
  with `ru-fork:` comments; shared files hold thin seams only.
- **Secrets**: never in events/projections/client — only `{ secretRef }`. Plaintext only in-memory at
  probe/overlay time, and in the 0600 overlay file.
- **Single migration**: edit `031_Mcp.ts` in place; never stack `032`.

## 1. File map

```
packages/contracts/src/ru-fork/mcp.ts        — all MCP schemas/types (DATA-MODEL §1–7)
packages/contracts/src/orchestration.ts      — mcp.* commands + events (+ aggregate union membership)
packages/contracts/src/rpc.ts                — WS_METHODS.mcp* + the 5 Rpc.make + WsRpcGroup membership
packages/contracts/src/provider.ts           — ProviderSessionStartInput += settingsOverlayPath, allowedMcpServers
packages/contracts/src/settings.ts           — ServerSettings.mcp + ServerSettingsPatch.mcp
packages/contracts/src/index.ts              — re-export ./ru-fork/mcp.ts

packages/mcp-core/                            — pure logic (no Effect, no IO)
  src/resolver.ts      — resolveVarValues, resolveConfig, missingRequiredVars, effectiveTimeoutMs,
                          dedupHash, configCacheKey, canonicalize, fnv1a, (effectiveConfig*)
  src/probe.ts         — probeOnce, paramsFromInputSchema, DEFAULT_PROBE_TIMEOUT_MS, ProbeResult
  src/fingerprint.ts   — overlayFingerprint, OverlayServerEntry
  src/toolPolicy.ts    — effectiveAllowedTools, (pruneInertExceptions*)
  src/index.ts         — export * from the four
  (* = currently-unused export; see AUDIT)

apps/server/src/ru-fork/mcp/
  McpBuiltins.ts          — McpBuiltinDefinition/Var types + builtinConfigForPlatform/builtinShippedVars/
                            builtinHash/builtinServerId
  mcpBuiltinDefinitions.ts— MCP_BUILTINS (DATA ONLY — the single edit point)
  McpSecretNames.ts       — mcpVarSecretName, MCP_VAR_SECRET_PREFIX
  McpSecrets.ts           — splitServerVars, splitBindingVarValues, collectVarSecretRefs,
                            materializeSecretValues
  McpCatalogBuilders.ts   — buildAddedServer, applyServerUpdate, buildBinding, resolveBindingVarValues,
                            buildSyncedBuiltin, mergeTemplateVars
  McpInvariants.ts        — findCatalogServerById, findBinding, requireCatalogServer,
                            requireCatalogServerAbsent
  McpReadModel.ts         — pure folds: upsert/removeMcpServer, upsert/removeMcpBinding,
                            removeMcpBindingsByProject/ByServer
  McpProjectors.ts        — makeMcpCatalogProjector, makeMcpBindingProjector (SQL projector bodies)
  McpSupervisor.ts        — the registry + sweep + probe state machine
  McpReactor.ts           — authored→desired reconcile + builtin migrator + GCs
  McpRuntime.ts           — flatten registry → runtime snapshots stream
  McpOverlay.ts           — write the per-project qwen settings overlay
  McpProjectionQuery.ts   — UI read model (snapshot + change stream)
  McpLayers.ts            — McpRepositoriesLive, McpRuntimeServicesLive

apps/server/src/persistence/
  Services/McpCatalog.ts, McpBinding.ts, McpProbeCache.ts   — repo interfaces + Context.Service tags
  Layers/ProjectionMcpCatalog.ts, ProjectionMcpBinding.ts, ProjectionMcpProbeCache.ts — SQL impls
  Migrations/031_Mcp.ts                                     — the three tables

apps/server/src/ (shared seams)
  config.ts                         — MCP_ENGINE_USE_OVERLAY, mcpOverlayDir, mcpProbeCwd + mkdir
  orchestration/decider.ts          — mcp.* + mcp.builtin-sync branches
  orchestration/projector.ts        — read-model fold delegation (uses McpReadModel)
  orchestration/Layers/OrchestrationEngine.ts        — aggregate routing for mcp.builtin-sync
  orchestration/Layers/ProjectionPipeline.ts         — register the two projectors + repos
  orchestration/Layers/ProjectionSnapshotQuery.ts    — load mcpCatalog+mcpBindings into the read model
  orchestration/Layers/ProviderCommandReactor.ts     — turn-start overlay + overlayChanged gate
  provider/Layers/CliAdapter.ts, CliAcpSupport.ts    — forward overlay → env + arg
  provider/acp/AcpSessionRuntime.ts                  — mcpServers: [] (overlay is the source)
  ws.ts                             — 5 mcp handlers
  serverRuntimeStartup.ts           — start supervisor + reactor
  server.ts                         — provideMerge McpRuntimeServicesLive

apps/web/src/
  rpc/mcpState.ts                   — atoms + applyMcp*Event + startMcpStateSync
  rpc/wsRpcClient.ts                — client.mcp.{getSnapshot,subscribeProjection,subscribeRuntime,setActiveProject,recheck}
  hooks/useActiveProject.ts         — active project (drives setActiveProject)
  routes/__root.tsx                 — startMcpStateSync ; routes/_chat.tsx — setActiveProject
  ru-fork/mcp-manage/               — adapters.ts, useMcp.ts, types.ts, store.ts, visuals.ts, format.ts,
                                       serverConfigForm.ts, addMcpParsing.ts + components/*
```

---

## 2. mcp-core (pure)

### resolver.ts
- `interface ResolvedServerConfig { transport; command?; args?; env?; cwd?; httpUrl?; headers?; timeoutMs? }`
- `interface ResolveContext { projectCwd: string; secretValues: Record<string,string> }`
- `expandTemplate(value, lookup, projectCwd)`: regex `/\$\$|\$\{([A-Z0-9_]+)\}/g`. `$$`→`$`;
  `${PROJECT_CWD}`→projectCwd; `${NAME}`→`lookup[NAME] ?? ""`. **Single-pass** (substituted values are
  not re-scanned — opaque secrets survive verbatim).
- `resolveVarValues(vars, varValues, ctx) → Record<string,string>`: for each declared var, the effective
  value is `varValues[name]` if present else `declared.value`; `null`→`""`; secret ref → `ctx.secretValues[ref] ?? ""`
  (verbatim, NOT expanded); plain string → `expandTemplate(value, {}, cwd)` (only `${PROJECT_CWD}`).
- `missingRequiredVars(vars, varValues)`: `vars.filter(required).filter(no override && value===null).map(name)`.
- `effectiveTimeoutMs(server, binding|null)`: `binding?.timeoutMs ?? server.timeoutMs ?? undefined`.
- `resolveConfig({config, vars, varValues, extraArgs, extraHeaders, timeoutMs, context}) →
  ResolvedServerConfig`: resolves vars; `expand = v => expandTemplate(v, resolvedVars, cwd)`. stdio →
  `{command: expand, args: [...config.args, ...extraArgs].map(expand), env: resolvedVars, cwd:
  ctx.projectCwd, timeoutMs?}`. http → `{httpUrl: expand, headers: each value of {...config.headers,
  ...extraHeaders} expanded, timeoutMs?}` (extraHeaders merged OVER config.headers).
- `dedupHash(resolved) = fnv1a(JSON.stringify(canonicalize(resolved)))`.
- `configCacheKey(config, vars, varValues, extraArgs, extraHeaders)`: `effectiveVars = vars.map({name,
  secret, value: varValues[name] ?? declared.value})`; `fnv1a(canonicalize({config, vars: effectiveVars,
  extraArgs, extraHeaders}))`.
- `canonicalize(v)`: arrays mapped; objects → `Object.keys(v).toSorted().map(k=>[k, canonicalize(v[k])])`;
  else `v`. `fnv1a(s)`: 32-bit FNV-1a → `(h>>>0).toString(16).padStart(8,"0")`.

### probe.ts (the one non-Effect IO boundary; reuses MCP SDK)
- Header: `// @effect-diagnostics nodeBuiltinImport:off` + `globalTimers:off`.
- `DEFAULT_PROBE_TIMEOUT_MS = 30_000`; backstop margin `5_000`.
- `interface ProbeResult { status:"online"|"offline"; tools: McpTool[]; latencyMs; message?; timedOut?;
  serverDescription?; serverWebsiteUrl? }`. The two server* fields carry `serverInfo.description` /
  `serverInfo.websiteUrl` reported by the server on connect (back-filled onto the catalog by the reactor).
- `probeOnce(resolved, timeoutMs)`: build transport (`StdioClientTransport` with cwd + piped stderr, or
  `StreamableHTTPClientTransport` with headers); `client.connect(transport as Transport, {timeout})` (the
  one justified `as Transport`); capture `serverInfo = client.getServerVersion()` after connect;
  `listTools()`; map each tool `{name, description: description ?? "", params:
  paramsFromInputSchema(inputSchema) when non-empty}`. `Promise.race([connectAndList, backstop])`
  where backstop rejects after `timeoutMs + 5s`. On success `{status:"online", tools, latencyMs,
  serverDescription? (when serverInfo.description is a string), serverWebsiteUrl? (likewise)}`; on
  error `{status:"offline", tools:[], latencyMs, message: failureMessage(err, stderrTail), timedOut?}`.
  Mirrors qwen's `McpClient.connect()/discoverTools()` exactly (same transport construction, roots
  capability + ListRoots handler, `connect({timeout})`, `listTools()`).
- `paramsFromInputSchema(inputSchema: {properties?: Record<string,object>; required?: string[]}) →
  McpToolParam[]`: for each `[name, prop]` in `properties` → `{name, type: typeLabel(prop), required:
  required.has(name), description: schemaDescription(prop)}`. `schemaType(node)`: `"type" in node &&
  typeof node.type==="string" ? node.type : undefined`. `schemaDescription`: same for `"description"`,
  default `""`. `typeLabel`: base `schemaType ?? "any"`; `"array"` with object `items` whose
  `schemaType` known → `"<item>[]"`, else `"array"`. **All cast-free** (literal-key `in` + `typeof`).

### fingerprint.ts
- `overlayFingerprint(entries: {serverName, resolved, toolPolicy}[])`: map to `{serverName, configHash:
  dedupHash(resolved), defaultDecision, exceptions: exceptions.toSorted()}`, `toSorted` by serverName,
  then `dedupHash({transport:"stdio", args:[JSON.stringify(canonicalEntries)]})`.

### toolPolicy.ts
- `effectiveAllowedTools(policy, discoveredTools)`: discovered names filtered by `isToolAllowed`
  (`allow` ⇒ keep non-exceptions; `deny` ⇒ keep exceptions).

---

## 3. Persistence

Each repo = a `Context.Service` tag + a `*RepositoryShape` interface (in `Services/Mcp*.ts`) and a
`Layer.effect` SQL impl (in `Layers/ProjectionMcp*.ts`). Pattern: `SqlSchema.void/findAll/findOneOption`,
`*DbRow = Schema.mapFields(Struct.assign({json cols: Schema.fromJsonString(...), bool: NonNegativeInt}))`,
`rowToX` converts 0/1 → boolean; methods `.pipe(Effect.mapError(toPersistenceSqlError("X.op")))`.

- **McpCatalogRepository**: `upsert`, `listAll`, `remove`. Row decodes `config/vars/extraArgs/extraHeaders`
  from JSON, `locked`/`enabled` via `NonNegativeInt`; `rowToServer(row)=>{...row, locked: row.locked!==0,
  enabled: row.enabled!==0}`; `listAll` maps through it. Upsert columns: id,name,description,website_url,
  source,config_json,vars_json,extra_args_json,extra_headers_json,builtin_id,builtin_hash,locked(`?1:0`),
  enabled(`?1:0`),timeout_ms,created_at,updated_at.
- **McpBindingRepository**: `upsert`, `remove`, `listByProject`, `removeByProject`, `removeByServer`,
  `listAll`. `enabled` via `NonNegativeInt` + `rowToBinding`. PK (project_id, server_id).
- **McpProbeCacheRepository**: `upsert`, `getByKey`(→`Option`), `deleteKeysNotIn(keys)`
  (`keys.length===0 ? DELETE all : DELETE WHERE config_key NOT IN sql.in(keys)`). Upsert/select thread
  `server_description`/`server_website_url` (the back-fill source) alongside the existing columns.
- **ServerSecretStore** (existing, extended): added `pruneByPrefix(prefix, keep: ReadonlySet<string>): Effect<void>` —
  readDirectory, for each `.bin` whose name starts with `prefix` and ∉ `keep` →
  `fileSystem.remove(..., { force: true }).pipe(Effect.catchCause(c => Effect.logDebug(...)))`. Best-effort
  per file: `force` makes a missing file a no-op, a real failure is logged at debug and the loop continues,
  so the call never fails (error channel `never`). (The earlier dead outer `Effect.catch → fail` was removed.)

---

## 4. Server engine (`ru-fork/mcp/`)

### McpSecretNames.ts / McpSecrets.ts — see DATA-MODEL §13 + WORKING-LOGIC §9 for the algorithms.
`splitServerVars(serverId, draftVars, existingVars) → Effect<McpServerVar[], SecretStoreError, ServerSecretStore>`;
`splitBindingVarValues({projectId, serverId, vars, draftVarValues, keepNames, existing}) →
Effect<Record<string,McpVarValue>, …>`; `collectVarSecretRefs(vars, varValues) → string[]`;
`materializeSecretValues(vars, varValues) → Effect<Record<string,string>, …>`.

### McpBuiltins.ts / mcpBuiltinDefinitions.ts
- `interface McpBuiltinVar { name; secret; perProject; required; value: string|null }`.
- `interface McpBuiltinDefinition { builtinId; name; description?; websiteUrl?; config:
  Partial<Record<NodeJS.Platform, McpServerConfig>> & { default?: McpServerConfig }; vars:
  McpBuiltinVar[]; timeoutMs? }`. `websiteUrl` = shipped docs link (wins over the probe-reported one).
- `builtinConfigForPlatform(def, platform) = def.config[platform] ?? def.config.default ?? null`.
- `builtinShippedVars(def)`: map vars to `McpServerVar` with `origin:"shipped"`.
- `builtinHash(config, def)`: inline FNV-1a over `JSON.stringify({name, description ?? null, websiteUrl
  ?? null, config, vars: builtinShippedVars(def), timeoutMs ?? null})`.
- `builtinServerId(builtinId) = "srv-builtin-" + builtinId`.
- `mcpBuiltinDefinitions.ts` exports `MCP_BUILTINS: McpBuiltinDefinition[]` (imports the *type* from
  McpBuiltins.ts — one-way, no cycle). Editing this list is the only thing needed to add/remove a built-in.
  Shipped: `filesystem` (stdio `npx -y @modelcontextprotocol/server-filesystem ${PROJECT_CWD}`, no vars),
  `context7` (http `https://mcp.context7.com/mcp`, no vars), `atlassian` (stdio `uvx mcp-atlassian`, 6
  catalog vars — all `perProject:false`, `required:true`: `JIRA_URL`/`CONFLUENCE_URL` non-secret with a
  placeholder value; `JIRA_USERNAME`/`CONFLUENCE_USERNAME` non-secret `value:null`;
  `JIRA_API_TOKEN`/`CONFLUENCE_API_TOKEN` secret `value:null`).

### McpCatalogBuilders.ts (pure builders)
- `buildAddedServer(serverId, draft, vars, occurredAt)`: `{id, name, description ?? null, websiteUrl:null
  (manual ⇒ no shipped link; fills from its own probe), source:"custom", config: draft.config, vars,
  extraArgs: draft.extraArgs ?? [], extraHeaders: draft.extraHeaders ?? {}, builtinId:null,
  builtinHash:null, locked:false, enabled:true, timeoutMs: draft.timeoutMs ?? null, createdAt: occurredAt,
  updatedAt: occurredAt}`.
- `applyServerUpdate(existing, patch, vars, occurredAt)`: never forks (`source: existing.source`);
  `config: existing.locked ? existing.config : (patch.config ?? existing.config)`; carries
  `websiteUrl: patch.websiteUrl ?? existing.websiteUrl` (never user-cleared), `extraArgs: patch.extraArgs
  ?? existing.extraArgs`, `extraHeaders: patch.extraHeaders ?? existing.extraHeaders`, `enabled:
  patch.enabled ?? existing.enabled`, `builtinId/builtinHash/locked` from existing;
  `name/description/timeoutMs` patched; `updatedAt: occurredAt`.
- `buildBinding({projectId, serverId, patch, existing, varValues, occurredAt})`: enabled/toolPolicy/timeout
  fall back existing→default; `varValues`; createdAt preserved.
- `resolveBindingVarValues({patch, keepNames, existing, vars, projectId, serverId})`: `patch===undefined ?
  Effect.succeed({...existing}) : splitBindingVarValues({…, keepNames: keepNames ?? []})`.
- `buildSyncedBuiltin({serverId, builtinId, builtinHash, name, description, websiteUrl, config, shippedVars,
  timeoutMs, existing, occurredAt})`: 3-way merge (WORKING-LOGIC §11) → `source:"builtin", locked:true`.
  `description`/`websiteUrl` = shipped value wins, else preserve the existing (probe-backfilled) value;
  `extraArgs/extraHeaders/enabled` carried from `existing` (`?? []`/`?? {}`/`?? true`, so a user disable
  survives a template re-sync).
- `mergeTemplateVars(serverId, existing, draftVars) → Effect<McpServerVar[], …>`: WORKING-LOGIC §11.

### McpInvariants.ts
`findCatalogServerById(readModel, serverId) → McpCatalogServer|undefined`;
`findBinding(readModel, projectId, serverId)`; `requireCatalogServer({readModel, command, serverId}) →
Effect<server, OrchestrationCommandInvariantError>`; `requireCatalogServerAbsent(...)`.

### McpReadModel.ts (pure folds) / McpProjectors.ts (SQL bodies)
Folds: `upsertMcpServer`, `removeMcpServer`, `upsertMcpBinding`, `removeMcpBinding`,
`removeMcpBindingsByProject`, `removeMcpBindingsByServer` (all `(collection, …) => newCollection`).
`makeMcpCatalogProjector(catalogRepo, bindingRepo)`: on `server-added|updated`→`catalog.upsert`; on
`server-removed`→`catalog.remove` + `binding.removeByServer`. `makeMcpBindingProjector(bindingRepo)`:
`binding-set`→`upsert`; `binding-removed`→`remove`; `project.deleted`→`removeByProject`.

### McpSupervisor.ts — see WORKING-LOGIC §3–4 for the algorithms. Service shape:
`reconcile(desired) → Effect<addedHashes[]>` (returns hashes that are brand-new OR newly-referenced
this reconcile — F1), `setWatchedProjects(ids)`, `recheck(filter)`, `probeHashes(hashes)`,
`currentInstances`, `currentInFlight`, `changes: Stream<void>`, `start()`.
Constants `SWEEP_INTERVAL=Duration.seconds(60)`, `OFFLINE_THRESHOLD=3`, `MINUTE_MS=60_000`. State:
`registryRef: Ref<Map<hash, SupervisorInstance>>`, `watchedProjectsRef: Ref<Set|null>` (null=all),
`inFlightRef: Ref<Set<hash>>`, `changesPubSub`. `SupervisorInstance` = `{hash, configKey, resolved,
refs:Set, status, message, latencyMs, checkedAt, checkedAtMs, discoveredTools, consecutiveFailures}`.
Pure exports `instanceInWatched`, `isSweepDue`, `isProbeDue`, `instanceMatchesRecheck`, `parseRef`,
`nextStatus(result, previousFailures) → {status, consecutiveFailures}` (B1): online→`{online, 0}`;
offline→`consecutiveFailures+1` and a HARD failure (`!result.timedOut`) is `offline` immediately,
while a TIMEOUT stays `degraded` until `consecutiveFailures >= OFFLINE_THRESHOLD` then flips `offline`.
`probeInstance` claims in-flight (coalesce), publishes change, `runProbe` (probe → applyProbeResult →
probeCache.upsert with `serverDescription`/`serverWebsiteUrl` from the result) `.ensuring(release + publish)`.

### McpReactor.ts — see WORKING-LOGIC §2,5,10,11. Service: `start()`, `drain`. Deps: catalog/binding/probe-cache
repos, supervisor, OrchestrationEngineService, ServerSettingsService, ServerConfig, McpOverlay,
ServerSecretStore. `mergeDesired` resolves at `serverConfig.mcpProbeCwd` and threads `server.extraArgs`
+ `server.extraHeaders` into both `resolveConfig` and `configCacheKey`. `computeDesired` skips
`!server.enabled` in BOTH loops (⑬ catalog-disabled ⇒ never probed; the binding loop also re-checks the
server's `enabled`). `processSignal`: pruneOrphanedVarValues → reconcileNow → if eager
probeHashes(added). `reconcileNow` ends with `gcOrphanedSecrets` then `backfillServerMetadata`.
- `backfillServerMetadata` (B3 ②): for each catalog server with a null `description` and/or `websiteUrl`,
  read its default-config probe-cache row and dispatch a metadata-only `mcp.server-update` filling only
  the empty field(s) from `row.serverDescription`/`row.serverWebsiteUrl` (trimmed, only when non-empty).
  Idempotency comes from the reactor's own guard (skip when the field is already non-null), NOT the
  commandId — the commandId is a fresh `crypto.randomUUID()` per dispatch (`mkReconcileCommandId`). A stable
  id would be permanently deduped by the engine's receipt store and block a legitimate re-backfill after a
  field is re-cleared (the original bug). Converges: once filled, the next pass produces no patch.
`start()`: **reconcileBuiltins → forkScoped(subscribe) → enqueue{eager:false}** (order is load-bearing,
WORKING-LOGIC §5). In the subscribe loop, `project.deleted` ⇒ `overlay.removeOverlay(projectId)` THEN
`enqueue{reconcile, eager:true}` (B4 ③: GC the orphaned overlay dir); `project.created` ⇒
`enqueue{project-created}`; any other `isReconcileRelevant` ⇒ `enqueue{reconcile, eager:true}`. The
`reconcileBuiltins` dispatch forwards `websiteUrl: definition.websiteUrl ?? null` on `mcp.builtin-sync`.
`isReconcileRelevant(e)`: `e.type.startsWith("mcp.") || project.deleted || project.meta-updated`.

### McpRuntime.ts
`subscriptionStream = Stream.concat(fromEffect(snapshot), supervisor.changes.debounce(200ms).mapEffect(snapshot))`.
`currentSnapshot`: index instances by ref + by configKey; for each enabled binding with a matching
ref-instance → `McpRuntimeSnapshot` (status, `checking: inFlight.has(hash)`, message/latency/checkedAt
when non-null, discoveredTools, `effectiveAllowedTools(binding.toolPolicy, tools)`); for each catalog
server, look up the instance by `configCacheKey(config, vars, {}, extraArgs, extraHeaders)` →
`McpCatalogRuntimeSnapshot`.
`.catch(() => empty)`.

### McpOverlay.ts — see WORKING-LOGIC §12. Service: `writeOverlay(projectId) → Effect<OverlayResult, McpError>`
+ `removeOverlay(projectId) → Effect<void>` (B4 ③: `fileSystem.remove(<mcpOverlayDir>/<projectId>,
{recursive:true, force:true})` `.pipe(Effect.catchCause(c => logDebug(...)))` — best-effort, never fails the
project.deleted chain, but a real removal failure is now logged at debug). `writeOverlay` skips a binding
when `!binding.enabled`, `!server` (missing), or `!server.enabled` (⑬ catalog-disabled), then resolves
via `resolveConfig` threading `server.extraArgs` + `server.extraHeaders`.
`OverlayResult = {overlayPath, allowedServerNames, fingerprint}`. `buildServerEntry(resolved, policy)`:
toolFilter from policy (`deny`→`includeTools:exceptions`; `allow` with exceptions→`excludeTools`; else
`{}`); stdio→`{command, args, env, cwd?, timeout, ...toolFilter}`; http→`{httpUrl, headers, timeout,
...toolFilter}`; `timeout = resolved.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS`. Write
`{security:{folderTrust:{enabled:false}}, mcpServers}` to `<mcpOverlayDir>/<projectId>/system.json`
via `writeFileStringAtomically({mode:0o600, dirMode:0o700})`.

### McpProjectionQuery.ts
`getSnapshot(projectId|null)`: `{catalog: listAll, bindings: projectId ? listByProject : listAll}`.
`subscriptionStream = concat(fromEffect(getSnapshot(null) → {type:"snapshot"}), streamDomainEvents
.filter(isProjectionRelevant).mapEffect(() => getSnapshot(null) → {type:"snapshot"}))`.
`isProjectionRelevant`: `mcp.* || project.deleted`.

### McpLayers.ts
`McpRepositoriesLive = mergeAll(McpCatalogRepositoryLive, McpBindingRepositoryLive, McpProbeCacheRepositoryLive)`.
`McpRuntimeServicesLive = mergeAll(McpRuntimeLive, McpProjectionQueryLive, McpReactorLive)
  .pipe(provideMerge McpOverlayLive, provideMerge McpSupervisorLive, provideMerge McpRepositoriesLive,
        provideMerge ServerSecretStoreLive)`.

---

## 5. Decider branches (`orchestration/decider.ts`)

```
 case "mcp.server-add":
   requireCatalogServerAbsent ; vars = splitServerVars(serverId, draft.vars, [])
   emit mcp.server-added { server: buildAddedServer(serverId, draft, vars, createdAt) }   aggregate: mcp-catalog
 case "mcp.server-update":
   existing = requireCatalogServer ; occurredAt = nowIso
   if existing.locked && patch.config !== undefined → throw OrchestrationCommandInvariantError
   vars = patch.vars ? mergeTemplateVars(serverId, existing, patch.vars) : existing.vars
   emit mcp.server-updated { server: applyServerUpdate(existing, patch, vars, occurredAt) }
 case "mcp.server-remove":
   requireCatalogServer ; emit mcp.server-removed { serverId, removedAt: occurredAt }
 case "mcp.builtin-sync":
   existing = findCatalogServerById(readModel, serverId)   // undefined ⇒ add
   emit (existing ? mcp.server-updated : mcp.server-added) { server: buildSyncedBuiltin({serverId,
     builtinId, builtinHash, name, description, websiteUrl: command.websiteUrl, config, shippedVars,
     timeoutMs, existing, occurredAt}) }
 case "mcp.binding-set":
   requireProject ; requireCatalogServer ; existing = findBinding ; server = requireCatalogServer
   varValues = resolveBindingVarValues({patch: patch.varValues, keepNames: patch.keepVarValues, existing,
                                        vars: server.vars, projectId, serverId})
   emit mcp.binding-set { binding: buildBinding({...}) }   aggregate: project
 case "mcp.binding-remove":
   emit mcp.binding-removed { projectId, serverId, removedAt }
```
Error channel: `OrchestrationCommandInvariantError | SecretStoreError`. `withEventBase` stamps
`aggregateKind/aggregateId/occurredAt/commandId`.

`OrchestrationEngine.commandToAggregateRef`: add `case "mcp.builtin-sync"` to the `mcp-catalog` arm
(its `default` reads `command.threadId`, which the command lacks — required to compile).

`projector.ts`: the read-model switch delegates to the `McpReadModel` folds for the 5 mcp events +
`project.deleted` (binding cascade).

---

## 6. Session plane wiring — see WORKING-LOGIC §12.

`config.ts`: `MCP_ENGINE_USE_OVERLAY = true`; `ServerDerivedPaths += mcpOverlayDir = join(stateDir,
"mcp","overlays")`, `mcpProbeCwd = join(stateDir,"mcp","probe-cwd")`; create both in
`ensureServerDirectories`.

`ProviderCommandReactor`: `sessionOverlayFingerprintRef: Ref<Map<threadId, fingerprint>>`. At
turn-start: `mcpOverlayResult = MCP_ENGINE_USE_OVERLAY ? writeOverlay(projectId).catch(()=>null) : null`;
`currentOverlayFingerprint = result?.fingerprint`. `startProviderSession` adds `settingsOverlayPath +
allowedMcpServers` when result present. Reuse gate adds `overlayChanged = currentFP!==undefined &&
spawnFP!==undefined && spawnFP!==currentFP` to the `if (!cwdChanged && !instanceChanged &&
!shouldRestartForModelChange && !overlayChanged) return existing`. `bindSessionToThread` records the FP.

`CliAdapter`: build `settingsOverlay` from `input.settingsOverlayPath/allowedMcpServers`, pass to
`makeCliAcpRuntime`. `CliAcpSupport.buildCliAcpSpawnInput(cliJs, cliSettings, cwd, env, settingsOverlay?)`:
set `env.QWEN_CODE_SYSTEM_SETTINGS_PATH = settingsOverlayPath`; args `[...launchArgs,
...(allowedMcpServers.length ? ["--allowed-mcp-server-names", names.join(",")] : []), "--acp"]`.
`AcpSessionRuntime`: every NewSession/LoadSession payload `mcpServers: []`.

`CliAcpSettingsOverlay` interface = `{ settingsOverlayPath?; allowedMcpServers? }` (provider-neutral).

---

## 7. Pipeline / snapshot / startup / server wiring

- `ProjectionPipeline`: import `McpCatalogRepository`, `McpBindingRepository`, the two projector
  factories, `McpRepositoriesLive`; add `ORCHESTRATION_PROJECTOR_NAMES.mcpCatalog/mcpBindings`; build
  `applyMcpCatalogProjection`/`applyMcpBindingProjection`; insert both into the `projectors` array
  (after `projects`); `provideMerge(McpRepositoriesLive)`.
- `ProjectionSnapshotQuery`: load `mcpCatalog = mcpCatalogRepository.listAll()` + `mcpBindings =
  mcpBindingRepository.listAll()` into the returned `OrchestrationReadModel` (switch the building
  `Effect.sync` to `Effect.gen`); `provideMerge(McpRepositoriesLive)`. (`OrchestrationReadModel` must
  have `mcpCatalog`/`mcpBindings` fields.)
- `serverRuntimeStartup`: `yield* mcpSupervisor.start().pipe(Scope.provide(reactorScope))` then
  `mcpReactor.start()` — inside the reactor-scope `Effect.gen`, after the orchestration reactor.
- `server.ts`: `RuntimeCoreDependenciesLive` `provideMerge(McpRuntimeServicesLive)`.
- `ws.ts`: resolve `McpProjectionQuery`, `McpRuntime`, `McpSupervisor`; handlers for `mcpGetSnapshot`
  (→`getSnapshot`), `subscribeMcpProjection`/`subscribeMcpRuntime` (→ the streams), `mcpSetActiveProject`
  (→`setWatchedProjects(projectId ? [projectId] : [])`), `mcpRecheck` (→`recheck(filter)`).

---

## 8. Web

- `wsRpcClient.ts`: `client.mcp = {getSnapshot, subscribeProjection, subscribeRuntime, setActiveProject,
  recheck}` bound to the WS methods.
- `rpc/mcpState.ts`: four `Atom.make(...).pipe(keepAlive, withLabel)` atoms (`mcpCatalogAtom`,
  `mcpBindingsAtom`, `mcpRuntimeAtom`, `mcpCatalogRuntimeAtom`). `applyMcpProjectionEvent` (snapshot →
  set catalog+bindings; granular cases also handled but unused, see AUDIT). `applyMcpRuntimeEvent` →
  index runtimes by `mcpRuntimeKey(projectId, serverId)` and catalogRuntimes by serverId; replace atoms.
  `startMcpStateSync(client)`: subscribe both streams + eager `getSnapshot({projectId:null})` if catalog
  empty; returns a disposer. Hooks: `useMcpCatalog/useMcpBindings/useMcpRuntimeMap/useMcpCatalogRuntimeMap`.
- `__root.tsx`: call `startMcpStateSync(getPrimaryEnvironmentConnection().client.mcp)`.
  `_chat.tsx`: `client.mcp.setActiveProject({ projectId: activeProjectId })` whenever the active project
  changes (via `useActiveProject`).
- `ru-fork/mcp-manage/`:
  - `types.ts` — UI view-types (`McpRegistryServer`, `McpProjectBinding`, `McpVar`, `McpTool`,
    `McpStatus = unchecked|checking|connected|connecting|degraded|error|disabled`, `McpPanelTab`).
    `McpVar` carries `hasStoredSecret` + `origin`. `McpRegistryServer` carries `message?/checking/
    incomplete/missingVars/templateOnly/locked/enabled/extraArgs/extraHeaders/builtinId/docsUrl?` (docsUrl
    populated from `server.websiteUrl`).
  - `adapters.ts` — `catalogServerToRegistry` (maps `enabled`, `extraHeaders`, `templateOnly =
    hasPerProjectHole`, `docsUrl` from `websiteUrl`), `bindingToUi`, `runtimeStatusToUi(enabled, status,
    checking)`, `catalogVarToUi` (sets `hasStoredSecret`, `origin`), `uiVarsToDraft` (forces
    `required:true` for every var; emits `keepSecret`), `catalogMissingVars` (`!perProject && required &&
    value===null`), `computeMissingVars`, `hasPerProjectHole` (`perProject && required && value===null`),
    `bindingSecretVarNames`, `toggleToolPolicy`, config converters.
  - `useMcp.ts` — `AddServerInput {name, description, config, vars, extraArgs, extraHeaders, locked?,
    timeoutMs?}`, `ProjectBindingInput {varValues, keepVarValues, timeoutMs}`; hooks (`useMcpRegistry`,
    `useMcpProjectBindings`, `useMcpProjects`, `useMcpMutations`); mutations dispatch the `mcp.*` commands
    (addServer always sends `extraArgs`+`extraHeaders`; updateServer omits `config` when `locked`, sends
    `extraArgs`+`extraHeaders`; `removeServer` → `mcp.server-remove`; `setServerEnabled` →
    `mcp.server-update {enabled}` (⑬); setProjectBinding sends `keepVarValues` when non-empty); `recheck`
    → `client.mcp.recheck`.
  - `store.ts` — zustand `{panelOpen, activeTab, selectedServerId, selectedProjectId}` + setters; pure
    selectors (`selectServerById`, `selectProjectBindings`, `selectProjectsForServer`, `isToolEnabled`).
  - `serverConfigForm.ts` — `ServerConfigDraft`, `draftFromConfig/configFromDraft`, `parseTimeout`,
    `validateVars`, `varWarnings`, `describeEditImpact` (→ `EditImpact{removedVars, newRequiredProjects}`).
  - `components/` —
    - `McpServerItemCard` — the ONE unified card shell for BOTH the catalog list and the project list
      (so they look identical). Status dot top-aligned (`mt-1.5`); line 1 = transport badge · source tag
      (`встроенный`/`мой`) · name; line 2 = colored status word + counts; lines 3–4 = description / error
      (full-width `pl-4`, `line-clamp-2`). Body activates on mouse-up (skipped if the user has a text
      selection, so the description stays copyable); catalog cards `navigate` to the detail, project cards
      are `collapsible` (drive `aria-expanded`, render `children` below). `dimmed` opacity for disabled.
    - `McpItemActions` — the right-side control cluster in ONE fixed order/look everywhere (catalog card,
      project card, detail header): `RecheckButton` → `editTrigger` (dialog-wrapped pencil slot) → delete
      (optional — omitted for built-ins) → enable/disable `Switch` → collapse arrow (optional). Icons are
      neutral-ghost; only delete tints red on hover. `recheckDisabled` propagates to the RecheckButton.
    - `ExtraHeadersField` — `Key: Value`-per-line editor for a LOCKED http template's extra/override
      headers (⑲); manual http edits headers directly so this is template-only.
    - `McpServerDialog` (add/edit; template mode when `server.locked` ⇒ `isTemplate`: locks name +
      description, passes `disabled`+`hideTransport` to `ServerConfigFields`, gates `ExtraArgsField` to
      locked-stdio and `ExtraHeadersField` to locked-http; warn-on-impact AlertDialog).
    - `ServerConfigFields` (`disabled` + `hideTransport` props), `VarsEditor` (`lockedDeclarations` prop;
      dropped the «обязательно» toggle — every var is required: `perProject:false` ⇒ catalog value, empty
      ⇒ «требует настройки»; `perProject:true` ⇒ per-project hole, value field cleared+disabled ⇒
      «шаблон»), `ExtraArgsField`, `SecretAwareInput` (saved/needs-value/editing states).
    - `ProjectConfigDialog` (per-project values), `ProjectBindingRow` (collapse shows «Ответ получен за: N
      ms»; right-click via `readLocalApi().contextMenu.show`), `RegistryDetail`/`RegistryTab` (catalog card
      line-2 is 3-way: «требует настройки» / «шаблон» / status+counts; «Используется `inProjectsLabel(N)`»
      = prepositional «в N проектах»; Tools section hidden when 0; right-click via `contextMenu.show`),
      `ProjectsTab` (check-all `RecheckButton`, disabled when 0 bindings or none enabled — moved off the
      `McpPanel` header), `ConfigSummary`, `RecheckButton`, `TimeoutField`, `AddToProjectControl`,
      `McpPanel*`, `McpPanelMount` (hoisted into `_chat`). `fakeData.ts` is **deleted** (data from the backend).

---

## 9. Tests (server; web has no test target — validate via typecheck+lint)

`apps/server/tests/ru-fork/mcp/`: `mcpCore.test.ts` (resolver/cacheKey/dedup/required/policy/fingerprint/
`paramsFromInputSchema`), `supervisorDecisions.test.ts` (`isSweepDue`/`isProbeDue`/`instanceMatchesRecheck`/
`instanceInWatched` — pure), `secretsKeep.test.ts` (`splitServerVars` keepSecret + `splitBindingVarValues`
keepNames with a Map-backed fake `ServerSecretStore`), `builtins.test.ts` (`builtinConfigForPlatform`/
`builtinHash`/`builtinShippedVars`/`buildSyncedBuiltin`/`mergeTemplateVars`). `tests/persistence/Layers/
McpProbeCache.test.ts`. Gate: `pnpm typecheck` 10/10, `pnpm lint` 0/0, `pnpm test:fast` (the 4 preexisting
`bin.test.ts` failures are an env baseline).
