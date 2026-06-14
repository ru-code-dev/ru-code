> ⏭️ **NEXT WORK = config-model v2 (vars/template redesign).** Full plan + every decision +
> build order + STATUS table live in **`mcp-vars-redesign.md`** (worktree root). Start there.
> Everything below is the v1 work that is DONE/green and must not regress.

# MCP Implementation — resume anchor

## ✅ SESSION: unified neutral-cwd probe + manual recheck + panel hoist + cleanup (DONE, all gates green)
The probe model is now **project-independent**. `${PROJECT_CWD}` resolves to a fixed neutral dir
(`config.mcpProbeCwd` = `<stateDir>/mcp/probe-cwd`, created at startup) for ALL probes → one probe + one
cache row per AUTHORED config (`configCacheKey`), shared across projects; two projects on the catalog
default collapse to ONE instance. qwen still gets the REAL project cwd at overlay-write time (`McpOverlay`
unchanged). Probe online ⇒ qwen can connect + discover tools (catalog-level); cwd only matters at tool-call.
- **Reactor** (`McpReactor.computeDesired`): resolves probe configs with neutral cwd; desired set = every
  catalog server's DEFAULT (ref `catalog:<id>`, so the Каталог tab shows status/tools even unbound) ∪ every
  enabled binding's EFFECTIVE config (ref `<project>:<id>`; no-override merges into the catalog instance).
  Cache **GC** after reconcile: `probeCache.deleteKeysNotIn(liveConfigKeys)` (only runs on a fully-successful
  computeDesired → empty set = genuinely empty authored set).
- **Supervisor**: `recheck(filter)` force-probes matching instances bypassing the due-gate (returns void);
  in-flight coalescing via `inFlightRef` (sweep + manual never double-connect); pure exported decision helpers
  `isSweepDue`/`isProbeDue`/`instanceInWatched`/`instanceMatchesRecheck` (mandatory-FIRST probe bypasses watch
  scope; recurring = watched project only). `monitoring` settings flag REMOVED (replaced by the two interval
  fields; 0/0 = no recurring probing).
- **Catalog status/tools**: `toolsCache`/`toolsCacheAt` deleted end-to-end (contract + migration 031 cols +
  ProjectionMcpCatalog + service + builders). Replaced by `McpCatalogRuntimeSnapshot` (per-serverId, matched
  to its instance by configKey) on a **single full-snapshot** runtime stream (`runtime-updated` delta removed).
- **Manual recheck UI**: RPC `mcp.recheck` (`WsMcpRecheckRpc`, success Void) → ws handler → `wsRpcClient.mcp.recheck`
  → `useMcpMutations.recheck`. Shared `RecheckButton` in catalog `RegistryDetail` (`{serverId}`), each
  `ProjectBindingRow` (`{projectId,serverId}`), and the panel header refresh icon (`{projectId}` of the active
  project; tooltip shows its name). Catalog now shows a `StatusBadge`.
- **Universal active-project hook**: `apps/web/src/hooks/useActiveProject.ts` — `useActiveProjectRef(): ProjectId|null`
  + `useActiveProject(): Project|null` (with cwd), unifies draft + thread. `useActiveRouteProjectId` deleted,
  callers repointed.
- **Panel hoist**: single `McpPanelMount` (desktop inline sidebar + mobile sheet, global store + own media query)
  mounted once in `_chat.tsx` beside `<Outlet/>`. Removed the per-route mounts from BOTH the thread route AND
  the draft route (the draft route had its own mount → would have double-mounted). Fixes draft→thread jump.
- **Tests added** (server-only): `supervisorDecisions.test.ts` (16 — sweep/due/watched/recheck-filter), cache
  `deleteKeysNotIn` GC (2), mcpCore neutral-cwd collapse (1). Gates: typecheck 10/10, lint 0, test:fast 722 pass
  (only the 4 preexisting `bin.test.ts`). Reviewed by a sub-agent; fixed the draft double-mount + dead recheck
  return + GC doc. Everything left uncommitted.

---

# (earlier) MCP Implementation — IN-PROGRESS notes

> Written mid-build before a context compression. This is the source of truth for resuming.
> Plan docs: `ru-fork-instrumental/changes/mcp/implementation-plan.md` + `final-flow.md` (in the
> MAIN checkout, not this worktree). Probe: `mcp-probe/` (18/18 GO — qwen contract proven).

## ACTIVE BUILD: monitoring redesign — per-config cache + event-driven prober (LOCKED with user)
M1–M7 + M5 are DONE/green and MCP works end-to-end (qwen used context7 live). The constant 15s
sweep (re-spawning `npx` forever) is being replaced. **Locked spec:**
- **Cache keyed by CONFIG, not server.** `configCacheKey(authoredConfig)` (NEW in mcp-core resolver.ts,
  DONE) = fnv1a of the authored McpServerConfig (command/args/env-refs/url/headers/timeout), IGNORES
  `${PROJECT_CWD}`/cwd → two projects on the catalog default share one entry; a per-project override
  splits it. Persist in a SQLite table `mcp_probe_cache(config_key PK, status, tools_json, last_error,
  checked_at)` + migration. This cache is the single source for status+tools (fixes "2-in-log/0-in-UI").
- **Prober** replaces the sweep: `probe(config)→write cache→broadcast`, with DEDUP (one config = one
  probe even if N bindings share it) + IN-FLIGHT coalescing.
- **Mandatory triggers (server/reactor):** catalog add→probe · catalog config change→probe · APP START→
  probe only catalog configs whose cache is MISSING · add-to-project→reuse cache, re-probe only if older
  than `RECHECK_ON_ADD_IF_STALE = 5 min` · per-project override change (override≠catalog)→probe it.
- **`mcp.recheck` RPC:** probe a project's configs (filter local/remote) or one config → cache+broadcast.
- **Settings (2 fields, minutes, default 30 each, 0=off):** `settings.mcp.recheckLocalMinutes`,
  `recheckRemoteMinutes` — REPLACE the `monitoring` boolean. Drive AUTO recheck of the ACTIVE project's
  servers (client-driven off app active-project/draft state — NOT panel-open).
- **Client:** periodic recheck timer (reads the 2 settings) targeting the active project → `mcp.recheck`;
  re-targets on active-project change. **Refresh icon** (recheck all active project's configs). **"Проверить"
  button per server** in catalog (RegistryDetail) AND project (ProjectBindingRow). UI reads cache.
- **Panel jump (draft→dialog) fix:** hoist `McpPanelInlineSidebar` into the shared `_chat.tsx` layout
  (beside `<Outlet/>`) → single mount point, no remount on draft→thread. Remove per-route mounts.
- **Also:** drop catalog `toolsCache`/`toolsCacheAt` (cache supersedes); stale-while-revalidate UX;
  cache GC of orphaned keys. **NO probe-at-spawn** (each dialog spawns its own `qwen --acp` + respawns
  on stop/error → would spam; overlay FILE write on spawn stays, it's cheap). Probing is ONLY: the
  mandatory triggers + settings-interval auto-recheck of the active project + manual buttons.
- **Build order / status:**
  - ✅ configCacheKey (mcp-core resolver.ts).
  - ✅ probe_cache table in single 031 migration (tools_cache cols kept until cache supersedes).
  - ✅ Cache persistence: `McpProbeRecord` contract + `McpProbeCacheRepository` (Services/McpProbeCache.ts)
    + `ProjectionMcpProbeCacheLive` (Layers) + wired into `McpRepositoriesLive`. NOT yet written-to.
  - ✅ Settings `recheckLocalMinutes`/`recheckRemoteMinutes` (default 30) in ServerSettings + patch.
  - ✅ **SPAM FIXED**: McpSupervisor sweep now DUE-gated (per-transport interval, 0=off; 60s tick; added
    `checkedAtMs` to SupervisorInstance + `isProbeDue`). Local probed once→every recheckLocalMinutes,
    remote→every recheckRemoteMinutes. No more every-15s npx.
  - ✅ Tools-display fixed: `discoveredTools` on UI `McpProjectBinding` (adapters bindingToUi) +
    ProjectBindingRow renders it (server.tools fallback).
  - ✅ Log levels → debug/error only ([[log-levels-error-or-debug]]).
  - ✅ Settings UI: 2 minute fields in `GeneralSettingsPanel` ("MCP-серверы" section), read via
    `useServerSettings().mcp`, write `updateSettings({ mcp: { ...mcpSettings, [field]: minutes } })`.
  - ✅ **#4 cache write-through + hydrate — DONE (compiles):** migration `031` mcp_probe_cache gained
    `checked_at_ms INTEGER`; `McpProbeRecord` gained `checkedAtMs: Schema.Int`; ProjectionMcpProbeCache
    upsert/select include checked_at_ms. Supervisor: `SupervisorInstance`+`DesiredInstance` gained
    `configKey`; injects `McpProbeCacheRepository`; `reconcile` rewritten to Effect.gen that HYDRATES new
    instances from cache (status/tools/checkedAt/checkedAtMs via `cachedSeed`); `probeInstance` WRITES
    THROUGH (`probeCache.upsert({configKey, transport, status, tools, lastError, checkedAt:IsoDateTime.make,
    checkedAtMs})`). Reactor computeDesired sets `configKey: configCacheKey(config)` (imported configCacheKey).
  - ✅ **#3 active-project scoping — DONE (build green).** Supervisor `watchedProjectsRef: Ref<Set<string>|null>`
    (null=probe all), `setWatchedProjects`, `instanceInWatched`, sweep filter `(watched===null ||
    instanceInWatched) && isProbeDue`. rpc.ts: `WS_METHODS.mcpSetActiveProject` + `WsMcpSetActiveProjectRpc`
    (payload `{projectId: NullOr(ProjectId)}`, Void/McpError) in WsRpcGroup. ws.ts: `import { McpSupervisor }`
    + `const mcpSupervisor = yield* McpSupervisor;` (after mcpRuntime) + `mcpSetActiveProject` handler.
    wsRpcClient.ts: `mcp.setActiveProject` on interface + factory. `_chat.tsx`: NEW `McpActiveProjectSync`
    component (mounted beside `ChatRouteGlobalShortcuts`) — `useActiveRouteProjectId()` → `client.mcp.
    setActiveProject({projectId: ProjectId.make(...)|null})` on change, guarded by `getPrimaryKnownEnvironment()`.
    `useActiveRouteProjectId` re-exported from `ru-fork/mcp-manage/index.ts`. NO casts (ProjectId.make).
  - ✅ **TESTS WRITTEN (server-side, all green):**
    - `apps/server/tests/ru-fork/mcp/mcpCore.test.ts` (11 tests) — `configCacheKey` stability/key-order-
      independence/override-differs/cwd-independence; `resolveConfig`+`dedupHash` (${PROJECT_CWD}→cwd, secret
      materialization, dedupHash differs by cwd while cacheKey matches); `effectiveAllowedTools` allow/deny;
      `overlayFingerprint` order-independence + policy-flip.
    - `apps/server/tests/persistence/Layers/McpProbeCache.test.ts` (3 tests) — upsert→read decoded round-trip,
      upsert-overwrites-same-key (1 row), getByKey→None for unknown. Via `SqlitePersistenceMemory`.
  - ✅ **GATES GREEN:** typecheck 10/10, lint 0/0, test:fast 703 pass (only the 4 preexisting bin.test.ts fail).
  - ⬜ STILL TODO (not started): `mcp.recheck` manual RPC + per-server "Проверить" buttons + refresh icon;
    panel hoist to `_chat.tsx` (RISKY: responsive 2-branch + mobile sheet); drop catalog tools_cache;
    settings ✅ DONE (UI in GeneralSettingsPanel + contract fields).
- **Unrelated heads-up logged for user:** qwen `setModel failed "qwen3-coder-flash"` — a thread pins a
  model qwen rejects; not MCP.
- **In-progress half-edit to reconcile:** added `discoveredTools` to UI `McpProjectBinding` + adapters
  `bindingToUi` (ProjectBindingRow not yet using it). Under the cache model, tools come from cache →
  reconcile (either keep discoveredTools-from-runtime OR cache-derived).

## Where I am
- **Worktree:** `/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code/.claude/worktrees/mcp`
- **Branch:** `ru-fork/mcp` (based on commit `d177ec50`). **Everything uncommitted** (user wants it left uncommitted for review).
- **qwen is NOT installed here** — test with fakes: `mcp-probe/servers/*` (real stdio+http MCP servers) and `apps/server/tests/provider/fakeAcpCore.ts` + `fakeAcpSpawner.ts` (fake ACP agent the real CliAdapter runs against).

## Current GREEN checkpoint (verified)
- `pnpm typecheck` → **10/10 pass, 0 errors**
- `pnpm test:fast` → only **4 preexisting failures** in `tests/bin.test.ts` (the "1 preexisting" to IGNORE — they fail because `resolveCli` can't find qwen/cli.js in this env; pass in real env). 689 pass.
- `pnpm lint` → **0 warnings, 0 errors**
- Run gates from worktree root. Lint = `pnpm lint`; tests for one file: `cd apps/server && NODE_OPTIONS='--experimental-strip-types --experimental-sqlite' pnpm vitest run --no-color <path>`.

## Locked decisions (DO NOT relitigate)
1. **Both feature flags default ON** (`settings.mcp.monitoring`, `MCP_ENGINE_USE_OVERLAY`). User chose "fully live".
2. **Leave everything uncommitted.**
3. **Minimize common-file edits.** All MCP LOGIC lives in `ru-fork/` helpers; common files hold only thin seams (registration/delegation). The user pushed back hard on this — keep it.
4. **No `as const` / casts / `any` / `as unknown`.** Only ONE documented cast exists: `probe.ts` `as Transport` (SDK exactOptionalPropertyTypes friction — justified inline). Don't add more.
5. **Secret model:** `env`/`header` values are ALWAYS secret refs in authored config; the decider splits plaintext→`ServerSecretStore`, supervisor materializes. (Option A — decider splits.)
6. **Structure:** one new package `@ru-fork/mcp-core` (pure logic + probe); everything else in `ru-fork/mcp.ts` (contracts subdir) + `apps/server/src/ru-fork/mcp/` + `apps/web/src/ru-fork/`.

## Effect 4 (beta.59) gotchas learned
- `Effect.catchAll` does NOT exist → use **`Effect.catch`**.
- No `effect/Either` / `Effect.either` → avoid; `Stream.filterMap` has a version-skewed Option type (don't use it). Let streams carry the error channel instead.
- `Array#sort` lint-flagged → use **`.toSorted()`**.
- `exactOptionalPropertyTypes: true` is on → `T | undefined` is NOT assignable to `T?` (SDK transports trip this).
- Layers are **memoized by reference** → self-providing the same `Live` const in multiple layers shares ONE instance. This is how I fixed test regressions: each Live layer self-provides its repos (matching the existing pipeline pattern), `runtimeLayer.ts` left untouched.
- Commands/events discriminate on **`type`** (string), not `_tag`. Decider is `switch(command.type)` with `command satisfies never` exhaustiveness.

## DONE (compiles, tests green)
**M1 contracts** — `packages/contracts/src/ru-fork/mcp.ts` (all schemas; `description`/`toolsCache`/`toolsCacheAt` are `NullOr` for DB; `enabled` Boolean). Seams in `orchestration.ts` (5 commands, 5 event-type literals, `mcp-catalog` aggregate kind, widened `aggregateId` union, 5 event envelopes, both command unions, `OrchestrationReadModel` gains `mcpCatalog`/`mcpBindings` with `withDecodingDefault([])`), `rpc.ts` (3 methods + 3 Rpc.make + WsRpcGroup), `settings.ts` (`mcp:{monitoring,autobindDefaults}`), `index.ts` export. Event-store `streamId`/`aggregateId` widened. Receipt repo + `OrchestrationEngine.commandToAggregateRef` widened for the new aggregate.

**M2 `@ru-fork/mcp-core`** — `packages/mcp-core/` (package.json catalog SDK dep, tsconfig). `resolver.ts` (effectiveConfig, `${VAR}`/`${PROJECT_CWD}` expand, `dedupHash`), `toolPolicy.ts` (`effectiveAllowedTools`, `pruneInertExceptions`), `fingerprint.ts` (`overlayFingerprint` — policy-aware, NOT discovered-tools), `probe.ts` (`probeOnce` SDK client). Added `@ru-fork/mcp-core` to `apps/server/package.json` deps; ran `pnpm install`.

**M3 persistence + decider + projector** — migration `031_Mcp.ts` (+ registered in `Migrations.ts`). Services `McpCatalog.ts`/`McpBinding.ts` + Layers `ProjectionMcpCatalog.ts`/`ProjectionMcpBinding.ts` (binding `enabled` int↔bool mapped explicitly). Decider branches DELEGATE to `ru-fork/mcp/`: `McpInvariants.ts`, `McpCatalogBuilders.ts`, `McpSecrets.ts`, `McpSecretNames.ts`. Projector folds delegate to `McpReadModel.ts`. Pipeline projectors delegate to `McpProjectors.ts`. `commandInvariants.ts` was REVERTED to original (untouched). `ProjectionSnapshotQuery.getCommandReadModel` loads mcp rows (restart correctness). `config.ts` gains `mcpOverlayDir`.

**M4 read RPC** — `ru-fork/mcp/McpProjectionQuery.ts` (getSnapshot + `subscriptionStream`). `ws.ts` THIN seam: 2 imports + 2 inject lines + 3 one-line handlers (stream logic lives in the service).

**M6 services + reactor + startup (DONE, driven & green)** — `ru-fork/mcp/McpSupervisor.ts` (Ref<Map<hash,Instance>>, single transient-probe sweep loop, `nextStatus` state machine, `reconcile`, `changes` PubSub, `start()`), `McpRuntime.ts` (`subscriptionStream` joining instances×bindings). **NEW `McpReactor.ts`** (drainable worker; `computeDesired` = catalog×bindings, per-project cwd via `ProjectionSnapshotQuery.getProjectShellById().workspaceRoot` memoized, `materializeSecretValues` → `resolveConfig` → `dedupHash` → desired Map with `${projectId}:${serverId}` refs → `supervisor.reconcile`; `isReconcileRelevant` = `mcp.*`/`project.deleted`/`project.meta-updated`; `project.created` → optional autobind gated by `settings.mcp.autobindDefaults`; `seedBuiltinsIfEmpty` dispatches `mcp.server-add` for builtins only when catalog empty; subscribes to `streamDomainEvents` BEFORE seeding so seed/autobind events reconcile; initial `{kind:"reconcile"}` tick covers DB-restored bindings on restart; `{start, drain}` shape). **NEW `McpDefaults.ts`** (`MCP_BUILTIN_SERVERS` = filesystem stdio `${PROJECT_CWD}` + context7 http, both secret-free; `isBuiltinServerId`). `McpCatalogBuilders.buildAddedServer` now sets `source: isBuiltinServerId(serverId) ? "builtin" : "custom"` (decider UNTOUCHED — seed flows through normal `mcp.server-add`). Wired: `McpLayers.ts` `McpRuntimeServicesLive` mergeAll now includes `McpReactorLive` + `provideMerge(ServerSecretStoreLive)` (memoized → shares engine's instance). `serverRuntimeStartup.ts`: resolve `McpSupervisor`+`McpReactor` (~line 239), start both in `reactorScope` after `providerSessionReaper.start()` (~line 287). Self-contained Live layers: pipeline + snapshotQuery + McpRuntimeServices each `provideMerge(McpRepositoriesLive)`; engine `provideMerge(ServerSecretStoreLive)` (added `ServerConfig`+`NodeServices` to 3 minimal engine test setups in `tests/orchestration/Layers/OrchestrationEngine.test.ts`).

## TODO (remaining — in order)
1. ~~**M6 reactor + startup**~~ ✅ DONE. green.
2. ~~**M7 overlay + ACP coupling**~~ ✅ **DONE** (green: typecheck 10/10, lint 0, test:fast only 4 bin.test.ts). Built: `McpOverlay.ts` (ru-fork — `writeOverlay(projectId)` reads enabled bindings+catalog+project cwd, materializes secrets, resolves configs, builds qwen `system.json` = `{security.folderTrust.enabled:false, mcpServers:{<serverId>:{stdio command/args/env | http httpUrl/headers, +policy-direct includeTools(default-deny)/excludeTools(default-allow)}}}`, atomic write via `writeFileStringAtomically` provided FileSystem+Path, returns `{overlayPath, allowedServerNames, fingerprint=overlayFingerprint(entries)}`; ONE `// @effect-diagnostics-next-line preferSchemaOverJson:off` on the external-format JSON.stringify). `MCP_ENGINE_USE_OVERLAY=true` flag in config.ts. Contract: `ProviderSessionStartInput` gained TWO provider-neutral optionals — `settingsOverlayPath` (TrimmedNonEmptyString) + `allowedMcpServers` (Array(String)). `CliAcpSupport`: `CliAcpSettingsOverlay` type + `buildCliAcpSpawnInput`/`makeCliAcpRuntime` map settingsOverlayPath→`QWEN_CODE_SYSTEM_SETTINGS_PATH` env, allowedMcpServers→`--allowed-mcp-server-names` arg. `CliAdapter.startSession`: pure passthrough (builds `settingsOverlay` from the 2 input fields, forwards; ZERO MCP import). `AcpSessionRuntime`: 3 `mcpServers:[]` comments. `ProviderCommandReactor.startProviderSession`: now Effect.gen, resolves `mcpOverlay.writeOverlay(thread.projectId)` (gated, best-effort catch→null) → sets the 2 input fields; added `McpOverlay` dep + import. `McpReactor` (M7.5): `overlayFingerprintsRef: Ref<Map<projectId,fp>>`, `syncOverlaysAndRestart` after reconcile — writeOverlay per project (bindings ∪ previous keys), diff fingerprint, first-sight=record-only, changed→`thread.session.stop` dispatch for that project's LIVE threads (from `providerService.listSessions()` × `getThreadShellById`→projectId); added `McpOverlay`+`ProviderService` deps. `McpLayers`: `McpOverlayLive` provideMerge'd into `McpRuntimeServicesLive` (before repos/secretstore so they reach it). Tests: added `McpOverlay` stub (`Layer.succeed`) to BOTH `ProviderCommandReactor.test.ts` + `RuForkProviderCommandReactor.test.ts`. No cycle: McpReactor→ProviderService→CliAdapter(no MCP); ProviderCommandReactor→McpOverlay→repos.

   **DECISION (locked): Option B** — the reactor resolves the overlay; CliAdapter is a pure forwarder. Contract fields named provider-neutral (`settingsOverlayPath` + `allowedMcpServers`, two INDEPENDENT optionals per user's request — not a masked struct); overlay's include/excludeTools derived DIRECTLY from policy (matches `overlayFingerprint`), NOT from `effectiveAllowedTools`.
3. ~~**M5 client**~~ ✅ **DONE** (green: typecheck 10/10, lint 0; web has NO test target — see [[no-web-tests]]). Built: `rpc/mcpState.ts` (atoms `mcpCatalogAtom`/`mcpBindingsAtom`/`mcpRuntimeAtom` + `applyMcpProjectionEvent`/`applyMcpRuntimeEvent` + `startMcpStateSync` + `useMcpCatalog`/`useMcpBindings`/`useMcpRuntimeMap`, mirrors `serverState.ts`). `rpc/wsRpcClient.ts` +`mcp` domain (`getSnapshot`/`subscribeProjection`/`subscribeRuntime`); mutations reuse `orchestration.dispatchCommand` (NO localApi/EnvironmentApi widening). `ru-fork/mcp-manage/adapters.ts` (pure contract→UI mappers: `catalogServerToRegistry`, `bindingToUi` w/ runtime join, `contractConfigToUi` MASKS secret refs→"", `uiConfigToDraft`, `runtimeStatusToUi`, `policyToToolOverrides`, `toggleToolPolicy`). `ru-fork/mcp-manage/useMcp.ts` (`useMcpRegistry`/`useMcpProjects`[from main `useStore` `selectProjectsAcrossEnvironments`]/`useMcpProjectBindings` + `useMcpMutations` dispatching 5 commands, re-brands ids via `.make()`). `store.ts` stripped to UI state only (kept pure selectors). `routes/__root.tsx` mounts `<McpStateBootstrap/>`. Swapped all 7 data/action components (RegistryTab/RegistryDetail/ProjectsTab/ProjectBindingRow/ProjectConfigDialog/McpServerDialog/AddToProjectControl) store→hooks; McpPanel unchanged (UI-only). ProjectsTab defaults to first project when none selected. **DELETED `fakeData.ts`.** Secret values are write-only client-side (masked on read; editing a secret server requires re-entering it).
4. **Tests** (server/package only — NO web) — mcp-core unit tests (port `mcp-probe` P1–P3 + resolver/policy/fingerprint); decider/projector mcp tests; overlay JSON + spawn-arg test via fakeAcp. **PENDING — confirm scope w/ user.**
5. **progress-log.md** — final doc in `ru-fork-instrumental/changes/mcp/` when 100% green.

## Stop condition
User runs the app with real qwen and it works immediately (flags ON). My job = the 3 gates green (ignoring the 4 bin.test.ts) + the feature wired end-to-end. The "model actually calls tools" check is the user's real-env step (probe already proved the contract).
