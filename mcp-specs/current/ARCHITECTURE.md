# MCP management — Architecture

> Scope: the ru-fork MCP feature as it exists in the current working tree. This document explains
> *how the system is put together*; [`WORKING-LOGIC.md`](./WORKING-LOGIC.md) explains *how it behaves
> at runtime*, and [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) is the line-level reconstruction spec.

---

## 1. The big picture

The feature manages **MCP servers** (external tools a coding agent can call) across **projects**. It
is built on the host app's existing **event-sourced CQRS** spine and adds three planes:

```
                          ┌───────────────────────────────────────────────────────────────┐
                          │                         WEB CLIENT                              │
                          │  atoms (mcpState) ← streams      mutations → dispatchCommand    │
                          └───────────▲───────────────────────────────────┬────────────────┘
                                      │ WS RPC (reads + subscriptions)     │ WS RPC (commands)
   ┌───────────────────────────────────┴────────────────────────────────────┴──────────────────────┐
   │ SERVER                            (reads)                              (commands)                │
   │                            ┌──────┴───────┐                    ┌───────▼─────────┐             │
   │   AUTHORED PLANE (CQRS)    │ McpProjection │                   │ OrchestrationEngine          │
   │                            │ Query (reads) │                   │  decider → events → store    │
   │   catalog + bindings       └──────▲───────┘                    └───────┬─────────┘             │
   │                                   │ snapshot/stream                    │ domain events         │
   │                            ┌──────┴───────────────────────────────────▼─────────┐             │
   │                            │ ProjectionPipeline → SQLite (mcp_catalog_server,    │             │
   │                            │   mcp_project_binding)   +  read-model (decider)    │             │
   │                            └──────▲───────────────────────────────────┬─────────┘             │
   │                                   │ listAll()                          │ streamDomainEvents    │
   │   MONITORING PLANE         ┌──────┴───────┐   reconcile()      ┌───────▼─────────┐             │
   │   (in-memory + cache)      │ McpReactor   │──────────────────► │ McpSupervisor   │             │
   │                            │ (authored →  │   probeHashes()    │ registry +      │             │
   │                            │  desired set)│◄───── changes ─────│ sweep loop      │             │
   │                            └──────┬───────┘                    └───────┬─────────┘             │
   │                                   │                                    │ probeOnce (mcp-core)  │
   │                            ┌──────▼───────┐                    ┌───────▼─────────┐             │
   │                            │ McpRuntime   │  status+tools      │ mcp_probe_cache │             │
   │                            │ (flatten →   │◄───────────────────│ (per configKey) │             │
   │                            │  snapshots)  │                    └─────────────────┘             │
   │                            └──────────────┘                                                    │
   │                                                                                                │
   │   SESSION PLANE            ┌──────────────────────┐   writeOverlay()   ┌─────────────────────┐ │
   │   (qwen coupling)          │ ProviderCommandReactor│──────────────────►│ McpOverlay          │ │
   │                            │  turn-start gate:     │   fingerprint      │  → system.json      │ │
   │                            │  overlayChanged?      │◄──────────────────│  + allowlist        │ │
   │                            └──────────┬───────────┘                    └─────────────────────┘ │
   │                                       │ settingsOverlayPath + allowedMcpServers                 │
   │                            ┌──────────▼───────────┐                                            │
   │                            │ CliAdapter → CliAcpSupport → spawn `node cli.js                   │
   │                            │   --allowed-mcp-server-names … --acp`                             │
   │                            │   env QWEN_CODE_SYSTEM_SETTINGS_PATH=<overlay>                    │
   │                            └──────────────────────┘                                            │
   └────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Four planes, one feature:**

1. **Authored plane (CQRS).** The *catalog* of server templates and the per-project *bindings* are
   the only durable, user-authored state. They are mutated exclusively through orchestration
   *commands* (`mcp.*`), turned into *events* by the decider, persisted by the projection pipeline,
   and read back via `McpProjectionQuery`.
2. **Monitoring plane.** The `McpReactor` turns authored state into a *desired set* of live
   instances; the `McpSupervisor` owns that registry and probes each instance on a schedule,
   writing results to the `mcp_probe_cache`. `McpRuntime` flattens the registry into UI snapshots.
3. **Session plane.** At qwen turn-start the `ProviderCommandReactor` asks `McpOverlay` to write the
   project's settings overlay and decides — by fingerprint — whether to re-spawn the ACP session.
4. **Secrets plane (cross-cutting).** Secret var values live only in `ServerSecretStore` as
   `mcp-var-…` files; everywhere else they are opaque `{ secretRef }` references, materialized to
   plaintext only in-memory at probe/overlay time.

---

## 2. The three packages and where MCP code lives

| Location | Role |
|---|---|
| `packages/contracts/src/ru-fork/mcp.ts` | **The data model.** Every MCP schema + type (configs, vars, catalog server, binding, probe record, runtime snapshots, drafts/patches, stream events). The single shared vocabulary. |
| `packages/contracts/src/orchestration.ts` (+ `rpc.ts`, `provider.ts`, `settings.ts`) | **Wiring contracts.** The `mcp.*` commands/events, the WS RPC methods, the provider spawn input (`settingsOverlayPath`/`allowedMcpServers`), and the `settings.mcp` block. |
| `packages/mcp-core/` | **Pure logic, no Effect, no IO.** Template resolution (`resolver.ts`), the MCP SDK probe (`probe.ts` — the one deliberate non-Effect IO boundary), the overlay fingerprint (`fingerprint.ts`), tool-policy intersection (`toolPolicy.ts`). Reusable by the `mcp-probe` test harness verbatim. |
| `apps/server/src/ru-fork/mcp/` | **The server engine.** Supervisor, reactor, runtime, overlay, secrets, catalog builders, invariants, projectors, read-model folds, layer composition, projection query, the built-in templates + helpers. |
| `apps/server/src/persistence/{Services,Layers,Migrations}/Mcp*` | **Persistence.** Repository interfaces + SQL implementations for catalog, bindings, probe cache; the single `031_Mcp.ts` migration. |
| `apps/web/src/ru-fork/mcp-manage/` + `apps/web/src/rpc/mcpState.ts` | **The UI.** Client atoms fed by the streams, the panel/dialogs/components, the view-model adapters, and the mutation hooks. The catalog list and project list share one card shell (`McpServerItemCard`) and one control cluster (`McpItemActions`); see §7.1. |

**Isolation rule (ru-fork convention).** All MCP logic lives in `ru-fork/` folders or dedicated
`Mcp*` files so upstream re-syncs never conflict. The few shared files that had to change
(`decider.ts`, `projector.ts`, `OrchestrationEngine.ts`, `ProviderCommandReactor.ts`,
`ProjectionPipeline.ts`, `ProjectionSnapshotQuery.ts`, `ws.ts`, the CLI adapter chain, `config.ts`,
`serverRuntimeStartup.ts`, `server.ts`) hold only **thin seams** that delegate into `ru-fork/mcp`.
ru-fork deltas are marked with `ru-fork:` comments.

---

## 3. The authored plane (CQRS) in detail

```
 client ──dispatchCommand(mcp.server-add | server-update | server-remove
        │                  | binding-set | binding-remove)──────────────┐
        ▼                                                                ▼
 OrchestrationEngine.dispatch ─► decider.ts (validate + split secrets + build)
        │                                   │
        │  emits mcp.server-added/updated/removed,                       │ (decider also runs the
        │        mcp.binding-set/binding-removed                         │  internal mcp.builtin-sync)
        ▼                                                                ▼
 event store (append) ──► ProjectionPipeline ──► SQL projectors (McpProjectors.ts)
        │                                              │
        │                                              ├─ mcp_catalog_server  (upsert/remove + cascade bindings)
        │                                              └─ mcp_project_binding (upsert/remove + cascade by project)
        │
        └─► streamDomainEvents (PubSub) ──► McpReactor, McpProjectionQuery (both subscribe)
```

**Aggregates.**
- **Catalog** is a *singleton* aggregate (`MCP_CATALOG_AGGREGATE_ID = "mcp-catalog"`). All
  `mcp.server-*` events target it. This serialises catalog edits.
- **Bindings** are scoped to the **project** aggregate, so `mcp.binding-*` events order and cascade
  with `project.deleted` (the binding projector handles that cascade).

**Two read models, by design.**
- The **decider's read model** (`OrchestrationReadModel`) is rebuilt by `ProjectionSnapshotQuery`,
  which now also loads `mcpCatalog` + `mcpBindings` (via `listAll`) so command invariants
  (`McpInvariants.ts`) can validate against current state. The in-memory folds live in
  `McpReadModel.ts` and are applied by `projector.ts`.
- The **UI read model** is served by `McpProjectionQuery` (snapshot + a change-driven stream) and
  consumed by the web atoms.

**Secrets never enter this plane in plaintext.** Inbound drafts carry plaintext var values; the
decider (`McpSecrets.splitServerVars` / `splitBindingVarValues`) writes them to `ServerSecretStore`
and the *event* carries only `{ secretRef }`. Therefore the event store, the SQL projections, the
read models, and the client all hold refs, never secrets.

---

## 4. The monitoring plane in detail

`McpReactor` (authored → desired) and `McpSupervisor` (desired → probed) form a closed loop:

```
 authored change (mcp.* event)         startup
        │                                 │
        ▼                                 ▼
 McpReactor.processSignal           reconcileBuiltins (migrator) ─┐
   ├─ pruneOrphanedVarValues                                       │ (before subscribe — see §Logic)
   ├─ reconcileNow:                                                ▼
   │    computeDesired (ENABLED catalog defaults + complete enabled bindings)
   │    → resolveConfig at the NEUTRAL probe cwd  → dedupHash      ┌──────────────────────────┐
   │    → supervisor.reconcile(desired)  ────────────────────────►│ McpSupervisor registry   │
   │    → probeCache.deleteKeysNotIn (GC)                          │  Map<hash, instance>     │
   │    → gcOrphanedSecrets                                        │                          │
   │    → backfillServerMetadata (probe → empty desc/url)         │                          │
   └─ if eager: supervisor.probeHashes(addedHashes)  ────────────►│  probeInstance (coalesced)│
                                                                   │   → probeOnce (mcp-core) │
 sweep loop (60s tick) ─ isSweepDue? ─ probeInstance ────────────►│   → applyProbeResult      │
                                                                   │   → probeCache.upsert     │
 manual recheck (ws) ─ instanceMatchesRecheck ─ probeInstance ───►│   → publish `changes`     │
                                                                   └───────────┬──────────────┘
                                                                               │ changes (debounced)
                                                                       ┌───────▼─────────┐
                                                                       │ McpRuntime      │ → subscribeMcpRuntime
                                                                       │ flatten → snaps │
                                                                       └─────────────────┘
```

**Key architectural decisions:**

- **Dedup by resolved-config hash.** Two projects that bind the same server with no per-project
  overrides resolve to the *same* config (because probes use a neutral `mcpProbeCwd`, not the project
  dir), so they share **one** registry instance, **one** probe, and **one** cache row. A per-project
  value mints a distinct hash → its own instance. This is the central efficiency of the design.
- **Two keys, two purposes.** `dedupHash(resolved)` (includes cwd) keys the in-memory registry;
  `configCacheKey(config, vars, varValues, extraArgs, extraHeaders)` (cwd-independent) keys the
  persistent cache and is what the UI uses to find a catalog server's status. The reactor computes
  both.
- **`enabled` is honored at the source.** `computeDesired` skips any catalog server whose `enabled`
  is `false` (and any binding whose catalog server is off), so a disabled server is never probed and
  drops out of the desired set entirely. `writeOverlay` applies the same gate.
- **Probe-driven metadata back-fill.** `reconcileNow` runs `backfillServerMetadata`: for any catalog
  server whose `description`/`websiteUrl` is still empty, it reads that server's default-config
  probe-cache row and dispatches a metadata-only `mcp.server-update` to fill it (a shipped/user value
  always wins). The commandId is deterministic + field-scoped, so it is replay-idempotent and
  converges (once filled, the next pass produces no patch).
- **The cache is the source of truth for status + tools.** The registry is in-memory and seeded from
  the cache on reconcile, so a restart shows last-known state without re-probing.
- **Watched-project scoping.** The client tells the server which project it is viewing
  (`mcp.setActiveProject`); the sweep only re-probes that project's instances. Until first told, the
  supervisor watches *all* (safe default), so probing never silently stops.

---

## 5. The session plane in detail

qwen reads MCP servers **only** from a settings overlay file at spawn — never from the ACP
`mcpServers` array (which the runtime always sends empty). The overlay is the single source.

```
 thread.turn-start ─► ProviderCommandReactor.ensureSessionForThread
   │
   ├─ McpOverlay.writeOverlay(projectId)  [best-effort; failure never blocks the turn]
   │     → resolve every ENABLED, COMPLETE binding (catalog server enabled too) at the REAL project cwd
   │       (extraArgs + extraHeaders threaded into resolveConfig)
   │     → materialize secrets in-memory → system.json (mode 0600, dir 0700)
   │     → returns { overlayPath, allowedServerNames, fingerprint }
   │
   ├─ reuse gate: cwdChanged | instanceChanged | shouldRestartForModelChange | overlayChanged
   │     overlayChanged = spawnFingerprint(thread) !== currentFingerprint
   │
   ├─ if reuse  → keep the live session (qwen already has the right overlay)
   └─ if respawn→ startProviderSession(resumeCursor) with
                    settingsOverlayPath + allowedMcpServers
                  → CliAdapter → CliAcpSupport:
                       env QWEN_CODE_SYSTEM_SETTINGS_PATH=<overlay>
                       arg --allowed-mcp-server-names <names>
                  → bindSessionToThread records the fingerprint for next turn
```

**Why turn-start, not on-edit:** qwen only reads the overlay when it spawns. Rewriting the overlay
while a session is live would do nothing until the next spawn. So the overlay is (re)written every
turn, and a *changed fingerprint* triggers a re-spawn on the **next** turn with `resumeCursor` (so
conversation history is preserved). This dissolves an entire class of "stale session" races that an
edit-time restart model suffered from.

**The fingerprint subsumes the allow-list.** `overlayFingerprint` hashes, per enabled server, the
server name + resolved-config hash + tool policy. Removing/adding a binding changes the set of
names, which changes the fingerprint — so there is no separate "allow-list changed" signal to track.
It is **policy-based, not discovered-tools-based**: qwen intersects the overlay's
include/excludeTools with whatever it discovers, so a server gaining/losing a tool needs no restart.

**Overlay-dir lifecycle.** `McpOverlay.removeOverlay(projectId)` deletes a project's overlay
directory (best-effort; a missing dir is a no-op, errors swallowed). The reactor calls it when it
sees `project.deleted` before reconciling — a deleted *server* self-heals via the fingerprint, but a
deleted *project* leaves an orphan dir that nothing else would reclaim.

**Kill-switch.** `MCP_ENGINE_USE_OVERLAY` (config.ts, default `true`) gates the whole session
coupling. When `false`, spawns are byte-for-byte identical to upstream (no overlay env var, no
allow-list arg, no overlay-driven restart), and qwen falls back to the user's own `~/.qwen` config.

---

## 6. Layer composition (Effect dependency graph)

```
 server.ts: RuntimeCoreDependenciesLive
   └─ provideMerge McpRuntimeServicesLive  (ru-fork/mcp/McpLayers.ts)
        ├─ McpRuntimeLive          (flatten → snapshots)
        ├─ McpProjectionQueryLive  (UI read model)
        ├─ McpReactorLive          (authored → desired)
        ├─ provideMerge McpOverlayLive       (turn-start overlay; also used by ProviderCommandReactor)
        ├─ provideMerge McpSupervisorLive    (singleton registry + sweep)
        ├─ provideMerge McpRepositoriesLive  (catalog + binding + probe-cache repos — MEMOIZED)
        └─ provideMerge ServerSecretStoreLive

 ProjectionPipeline + ProjectionSnapshotQuery also provideMerge McpRepositoriesLive
   → because the layer is memoized, the SAME repo instances are shared across the
     pipeline (writes), the snapshot query (decider read model), the reactor, the
     overlay, the runtime, and the projection query. One DB-backed source, many readers.

 serverRuntimeStartup: on startup, inside the reactor scope, start:
   mcpSupervisor.start()  (the 60s sweep loop)
   mcpReactor.start()     (reconcileBuiltins → subscribe → initial reconcile)
```

The **memoised `McpRepositoriesLive`** is the linchpin: catalog/binding/probe-cache repositories are
constructed once and shared, so every plane reads/writes the same SQLite-backed state without
re-instantiating connections or risking divergent caches.

---

## 7. Web architecture

```
 __root.tsx ─ startMcpStateSync(client.mcp)
   ├─ subscribeProjection → applyMcpProjectionEvent → mcpCatalogAtom / mcpBindingsAtom
   ├─ subscribeRuntime    → applyMcpRuntimeEvent    → mcpRuntimeAtom / mcpCatalogRuntimeAtom
   └─ getSnapshot (eager)  (catalog/bindings only; runtime arrives via its own initial snapshot)

 _chat.tsx ─ client.mcp.setActiveProject({ projectId: activeProjectId })   (scopes the sweep)

 useMcp.ts (hooks)
   ├─ useMcpRegistry      = catalog atoms  ─adapters.catalogServerToRegistry→ McpRegistryServer[]
   ├─ useMcpProjectBindings = binding atoms ─adapters.bindingToUi→ McpProjectBinding[]
   ├─ useMcpProjects      = the app's real projects
   └─ useMcpMutations     = addServer/updateServer/removeServer/setServerEnabled
                            /setProjectBinding/addBindingToProject/removeBinding
                            /setBindingEnabled/setToolEnabled/recheck
                            (all but recheck → orchestration.dispatchCommand)

 store.ts (zustand) ─ EPHEMERAL UI ONLY (panel open, active tab, selection) + pure selectors
 McpPanelMount ─ hoisted into the _chat layout so the panel survives draft→thread navigation
```

**Separation:** the *data* is server-owned (atoms ← streams, mutations → commands); the zustand store
holds only which panel/tab/selection is open. The `adapters.ts` module is the single translation
boundary between wire contracts and the flatter UI view-types (`types.ts`), keeping components
decoupled from the wire shape. Secret values arrive already masked (`""` for a stored ref); the UI
re-supplies a value only when the user types one, and signals "keep the stored secret" otherwise
(`keepSecret` / `keepVarValues`).

`removeServer`/`setServerEnabled` round out the catalog mutations: `removeServer` issues
`mcp.server-remove` (custom servers only); `setServerEnabled` is an `mcp.server-update` carrying just
`{ enabled }` — the ⑬ on/off toggle that stops probing and drops the server out of every overlay.

### 7.1 The unified item card (the main UI refactor)

The catalog list and the project list previously rendered two divergent inline layouts. They are now
one shell + one control cluster, so a server looks identical wherever it appears:

```
 McpServerItemCard.tsx  — ONE card shell (catalog AND project)
   left:   status dot
   line 1: transport badge · source tag (встроенный / «мой») · name
   line 2: status word (colored) + counts (statusLabel / statusDetail)
   lines 3–4: description (clamp-2) + error (clamp-2), full-width, left-aligned with the name
   behaviour: onActivate fires on mouse-up UNLESS text is selected (keeps the description copyable)
              · catalog passes a `navigate` activate (opens the detail)
              · project passes a `collapsible` activate (expands `children` in place; drives aria-expanded)
   right:  the caller's `actions` slot

 McpItemActions.tsx     — ONE control cluster, fixed order/look EVERYWHERE
   refresh (RecheckButton) → edit-slot → delete(optional) → enable/disable Switch → collapse-arrow(optional)
   neutral-ghost icons; only delete tints red on hover
   edit is a dialog-wrapped slot: catalog → McpServerDialog, project → ProjectConfigDialog
   delete + arrow are optional (a built-in has no delete; a navigate card has no arrow)

 ExtraHeadersField.tsx  — Key: Value textarea (one per line) for a locked http template's
                          extra/override headers (⑲), merged over the template's own headers
```

Consumers are now thin: `RegistryTab` (catalog list), `ProjectBindingRow` (project card +
collapse body), and `RegistryDetail` (the detail-pane header) all render `McpItemActions`, and the
two lists render `McpServerItemCard` — so the controls and the row layout live in exactly one place.
`McpRegistryServer` (`types.ts`) carries the fields these need: `message` (probe-failure text),
`enabled`, `extraHeaders`, `templateOnly`, and a now-populated `docsUrl` (shipped on a built-in or
back-filled from the probe).

**Right-click menus** use the cross-platform `readLocalApi().contextMenu.show` (the sidebar's
Electron+web pattern), not a web-only menu: catalog → recheck / edit / delete; project binding →
recheck / show-in-catalog / remove.

**VarsEditor** dropped the «обязательно» toggle — every var is required by construction. Each row is
now binary on `[для проекта]`: OFF = a catalog value filled here (shared by all projects); ON = a
per-project hole, which **clears and disables** the catalog value field (a per-project var has no
catalog value, each binding fills it).

**Projects toolbar.** The "check every server in the project" recheck moved out of the `McpPanel`
header and into the `ProjectsTab` toolbar (beside the project dropdown), disabled when the project
has no enabled binding to check. `McpPanel` is now just title + close + the two tabs.

---

## 8. Cross-cutting concerns

- **Secrets.** Single authority: `ServerSecretStore`, keyed `mcp-var-<b64(serverId)>-<b64(varName)>[-<b64(projectId)>]`.
  Materialized to plaintext only inside `McpSecrets.materializeSecretValues`, used by the prober and
  the overlay writer, and written to the overlay file (mode 0600) — the one at-rest plaintext surface,
  necessary because qwen needs real values. GC'd by `gcOrphanedSecrets` (reactor) via `pruneByPrefix`.
- **Time.** ISO strings for display (`checkedAt`), epoch ms for due-checks (`checkedAtMs`), so the
  sweep never re-parses ISO.
- **Errors.** `McpError` (tagged) is the boundary error for reads/overlay; persistence errors are
  `ProjectionRepositoryError`; secret errors are `SecretStoreError`. The reactor's background effects
  are wrapped in `Effect.catch`/`catchCause` + `logError` so a failure in one binding never tears down
  the loop. Logging is `logDebug` (traces) / `logError` (failures) only.
- **Single migration.** `031_Mcp.ts` creates all three tables; it is edited in place (the feature is
  unreleased), never stacked.
