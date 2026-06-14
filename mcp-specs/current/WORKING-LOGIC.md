# MCP management — Working Logic (flows & state machines)

> Every runtime flow, derived from the code. Each section names the file(s) that own it. Read
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) first for the structural map; see
> [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for exact signatures.

Contents:
1. [Authoring a server (command → event → projection)](#1-authoring-a-server)
2. [The reconcile: authored state → desired instance set](#2-the-reconcile)
3. [The probe lifecycle & status state machine](#3-the-probe-lifecycle--status-state-machine)
4. [The monitoring sweep loop & the due-gate](#4-the-monitoring-sweep-loop--the-due-gate)
5. [Eager vs. load: why a fresh install does NOT probe on load](#5-eager-vs-load)
6. [Manual recheck](#6-manual-recheck)
7. [The "checking" indicator & edit-lock](#7-checking--edit-lock)
8. [Incomplete gating — «требует настройки» vs «шаблон»](#8-incomplete-gating--требует-настройки-vs-шаблон)
9. [Secrets: split, keep-on-edit, materialize, GC](#9-secrets)
10. [Orphaned-varValues prune](#10-orphaned-varvalues-prune)
11. [The built-in template migrator (3-way merge)](#11-the-built-in-migrator)
12. [The turn-start overlay & restart gate](#12-the-turn-start-overlay--restart-gate)
13. [Warn-on-impact (catalog edit affecting projects)](#13-warn-on-impact)
14. [Tool params parsing](#14-tool-params-parsing)
15. [Description / docs-link backfill, enabled flag & overlay cleanup](#15-description--docs-link-backfill-enabled--overlay-cleanup)

---

## 1. Authoring a server

*Files: `decider.ts`, `McpCatalogBuilders.ts`, `McpSecrets.ts`, `McpProjectors.ts`,
`McpReadModel.ts`.*

```
 client McpServerDialog ── dispatchCommand(mcp.server-add { serverId, draft })
   │   draft = { name, description?, config(template), vars(drafts, PLAINTEXT), extraArgs?, timeoutMs? }
   ▼
 decider "mcp.server-add":
   requireCatalogServerAbsent(serverId)              ── invariant
   vars = splitServerVars(serverId, draft.vars, [])  ── plaintext secrets → ServerSecretStore, returns refs
                                                         every var stamped origin:"user"
   emit mcp.server-added { server: buildAddedServer(...) }   ── source:"custom", locked:false, builtinId:null
   │
   ▼
 projector (SQL)  : mcp_catalog_server upsert
 projector (read) : upsertMcpServer(readModel.mcpCatalog, server)
 streamDomainEvents ─► McpReactor (eager reconcile)  +  McpProjectionQuery (UI snapshot)
```

`mcp.server-update` is the same shape with a patch and two extra rules (both in the decider):
- **Locked template guard:** if `existing.locked && patch.config !== undefined` → reject with
  `OrchestrationCommandInvariantError` ("its command cannot be edited").
- **Vars merge:** `vars = patch.vars ? mergeTemplateVars(serverId, existing, patch.vars) : existing.vars`.
  `mergeTemplateVars` (see [§11](#11-the-built-in-migrator)) keeps shipped *declarations* immutable on a
  locked template while letting their *values* and any user vars change.

`mcp.binding-set` resolves per-project var values (`resolveBindingVarValues` → `splitBindingVarValues`,
honoring `keepVarValues`) and upserts the binding. `mcp.server-remove` emits `mcp.server-removed`,
whose projector **cascades**: `catalog.remove` + `binding.removeByServer`.

---

## 2. The reconcile

*File: `McpReactor.ts` (`computeDesired`, `mergeDesired`, `reconcileNow`) + `McpSupervisor.ts`
(`reconcile`).*

The reactor turns the authored catalog+bindings into a **desired** `Map<hash, DesiredInstance>`:

```
 computeDesired():
   for each catalog server S:
        if !S.enabled:  skip                             ── B5: catalog-disabled ⇒ never probed (§15)
        if missingRequiredVars(S.vars, {}) > 0:  skip   ── incomplete catalog default can't be probed
        mergeDesired(S, varValues={}, ref="catalog:<S.id>")
   for each binding B where B.enabled:
        S = serverById[B.serverId]; if !S: skip
        if !S.enabled:  skip                             ── B5: disabled catalog server ⇒ binding kept, but no probe
        if missingRequiredVars(S.vars, B.varValues) > 0:  skip   ── incomplete binding (§8)
        mergeDesired(S, B.varValues, ref="<projectId>:<serverId>")

 mergeDesired(S, varValues, ref):
   resolved   = resolveConfig(S.config, S.vars, varValues, S.extraArgs, S.extraHeaders,
                              context={ projectCwd: mcpProbeCwd /* NEUTRAL */, secretValues })
   hash       = dedupHash(resolved)                       ── registry key (cwd-independent here)
   configKey  = configCacheKey(S.config, S.vars, varValues, S.extraArgs, S.extraHeaders)   ── cache key (5-arg, B6)
   desired[hash] = exists ? add ref : { hash, configKey, resolved, refs:{ref} }
```

**Dedup in one picture** — two projects, same server, no overrides:

```
   project A binding ─┐                                  ┌─► refs = { "catalog:srv", "A:srv", "B:srv" }
   project B binding ─┼─ same config + vars + {} values ─┤   ONE instance, ONE hash, ONE probe,
   catalog default   ─┘   (probe cwd is neutral)         └─► ONE mcp_probe_cache row (configKey)

   project C binding ── varValues { SPACE: "ops" } ─────────► different hash ─► its OWN instance + cache row
```

`supervisor.reconcile(desired)` then diffs the registry:

```
 for each desired hash:
   if registry has it    → keep instance, refresh { configKey, resolved, refs }
   else if cache has row → SEED { status: online|offline, tools, checkedAt(Ms), message } from mcp_probe_cache
   else                  → NEW  { status:"unchecked", checkedAtMs:null, tools:[] }
 registry := next ;  publish `changes`
 return  hash brand-new  OR  hash gained a ref this reconcile   ── "added" (F1)
```

**F1 — newly-*referenced*, not only brand-new.** `reconcile` returns a hash when it was absent before **or**
when an existing instance gained a ref this pass (`[...instance.refs].some(ref => !before.refs.has(ref))`).
So binding a server whose config equals an already-registered *unchecked* catalog default still triggers a
probe (the binding adds a `<project>:<server>` ref to that hash). Incomplete instances never reach here
(`computeDesired` excludes them), so the returned set is always probeable.

`reconcileNow` then, in order: GCs the persistent cache (`deleteKeysNotIn(liveConfigKeys)` — skipped when
the live set is empty, so a transient all-incomplete state never wipes the cache), GCs orphaned secrets
([§9](#9-secrets)), runs `backfillServerMetadata` ([§15](#15-description--docs-link-backfill-enabled--overlay-cleanup), B3),
and returns the **added** hashes (the reactor force-probes these only on an *eager* signal — [§5](#5-eager-vs-load)).

---

## 3. The probe lifecycle & status state machine

*Files: `mcp-core/probe.ts` (`probeOnce`), `McpSupervisor.ts` (`nextStatus`, `applyProbeResult`,
`probeInstance`).*

`probeOnce` is the only IO into the MCP SDK: connect (stdio child or streamable-HTTP) → capture
`serverInfo` (`client.getServerVersion()`) → `listTools()` → map tools (+ params,
[§14](#14-tool-params-parsing)) → close. A hard wall-clock backstop (`timeoutMs + 5s`) guarantees a hung
connect can never freeze the sweep. Result is
`{ status: "online" | "offline", tools, latencyMs, message?, timedOut?, serverDescription?, serverWebsiteUrl? }`.
On an online connect it carries `serverInfo.description`/`websiteUrl` (the docs-link backfill source,
[§15](#15-description--docs-link-backfill-enabled--overlay-cleanup)); a `timedOut` flag distinguishes a TIMEOUT
from a hard connection failure (drives the status machine below).

**Per-instance status state machine** (`McpRuntimeStatus`):

```
                 reconcile (no cache)          ┌──────────── probe online ───────────┐
   ──────────────────────────────────────────►│                                      ▼
                                      ┌─────────────┐  probe online        ┌──────────────┐
                                      │  unchecked  │─────────────────────►│   online     │
                                      └─────────────┘                      └──────┬───────┘
   reconcile (cache: online)  ─────────────► online (seeded)                      │ probe offline
   reconcile (cache: offline) ─────────────► offline (seeded, failures=1)         ▼
                                                                        B1: split by FAILURE KIND
                                            HARD fail (refused/closed/ENOENT/spawn) ─┐
                                            ──────────────────────────────────────── │ ───────────►  offline (red) NOW
                                                                                     │
                                       probe TIMEOUT  ┌──────────────────────────────┘ fail < 3
                                       (timedOut,      │                    ┌──────────────┐
                                        failures++)    └───────────────────►│  degraded    │◄────────┐
                                                                            └──────┬───────┘         │ probe TIMEOUT
                                                                                   │ fail ≥ 3        │
                                                                                   ▼                 │
                                                                            ┌──────────────┐─────────┘
                                                                            │   offline    │
                                                                            └──────────────┘
   Any state, while a probe is in flight:  `checking = true` (orthogonal — see §7)
```

`nextStatus(result, previousFailures)` (exported for unit tests):
- `online`  → `{ online, consecutiveFailures: 0 }`
- `offline` → `failures+1`; status = `offline` when **`!result.timedOut`** (a HARD failure — connection
  refused/closed, ENOENT, spawn error — is down NOW ⇒ red immediately) **or** `failures >= OFFLINE_THRESHOLD(3)`;
  otherwise (a TIMEOUT under the threshold) `degraded` (amber) — only a slow server gets the retry buffer.

`applyProbeResult` updates the registry instance (status, failures, message, latency, `checkedAt(Ms)`)
and **keeps the previous tool list unless the probe was online** (so a transient failure doesn't blank
the discovered tools). It then write-throughs to `mcp_probe_cache` (keyed by `configKey`). Note the
cache only stores `online|offline` — `degraded`/`connecting`/`unchecked` are runtime-only; a seeded
`degraded` collapses to `offline` after restart (acceptable — the next probe re-derives it).

**Coalescing** (`probeInstance` + `claimInFlight`): a hash already being probed is skipped, so the same
authored config is never connected twice at once (sweep + manual + change-driven all coalesce).

---

## 4. The monitoring sweep loop & the due-gate

*File: `McpSupervisor.ts` (`start`, `runSweep`, `isSweepDue`, `isProbeDue`).*

```
 start(): forkScoped( runSweep.repeat(Schedule.spaced(60s)) )

 runSweep():
   settings = getSettings()            ── if unreadable → return (keep last status)
   if registry empty → return
   localMs  = settings.mcp.recheckLocalMinutes  * 60_000
   remoteMs = settings.mcp.recheckRemoteMinutes * 60_000
   if localMs <= 0 AND remoteMs <= 0 → return        ── BOTH zero ⇒ the loop is fully OFF
   watched = watchedProjectsRef
   due = instances.filter(i => isSweepDue(i, watched, now, localMs, remoteMs))
   probe each `due` (concurrency 4)
```

**`isSweepDue` decision tree** (pure, unit-tested):

```
 isSweepDue(i, watched, now, localMs, remoteMs):
   ┌─ i.checkedAtMs === null ?  ──► YES ─► return FALSE   ⟵ NEVER auto-probe a never-checked instance
   │  (no probing on load — its first probe comes from manual recheck or a config change only)
   ├─ watched !== null AND i NOT in watched ?  ──► YES ─► return FALSE   ⟵ only the active project re-probes
   └─ return isProbeDue(i, now, localMs, remoteMs)

 isProbeDue(i, now, localMs, remoteMs):
   if i.checkedAtMs === null → FALSE
   intervalMs = i.transport === "stdio" ? localMs : remoteMs   ⟵ per-transport cadence
   if intervalMs <= 0 → FALSE                                  ⟵ that transport's auto-recheck disabled
   return (now - i.checkedAtMs) >= intervalMs
```

So recurring probing is governed entirely by the two interval settings (per transport, 0 = off) and
the watched scope; a never-checked instance is invisible to the sweep.

> ⚠️ **Doc bug to be aware of:** the JSDoc block above `isSweepDue` still describes the *old*
> "mandatory first probe" behaviour and contradicts the code. See `AUDIT.md` §A1.

---

## 5. Eager vs. load

*Files: `McpReactor.ts` (`processSignal`, `start`), `McpSupervisor.ts` (`probeHashes`).*

A reconcile is triggered by three things, and only some of them should *probe*:

```
 ReactorSignal:
   { reconcile, eager:true  }  ← a domain mcp.* event (user edit / bind / autobind),
                                 OR project.deleted (after removeOverlay — §15 B4)      → PROBE the added hashes
   { reconcile, eager:false }  ← the initial startup tick (DB-restored bindings)        → DO NOT probe
   { project-created }         ← always eager (autobind then probe)

 processSignal(signal):
   eager = (signal is project-created) ? true : signal.eager
   if project-created → autobindBuiltinsForProject
   pruneOrphanedVarValues                       (§10)
   added = reconcileNow                          (§2)
   if eager → supervisor.probeHashes(added)      ← force-probe just the newly-appeared instances NOW
```

**The subtle part — why a clean install does NOT probe on first run.** Built-ins are seeded by
`reconcileBuiltins` (which dispatches `mcp.builtin-sync` → emits `mcp.server-added`). If those events
reached the reactor's *own* event subscription, they would arrive as `eager:true` and probe the
built-ins immediately — violating "no probing on load". The fix is **ordering**:

```
 start():
   ① reconcileBuiltins        ← dispatches builtin-sync; engine.dispatch resolves only AFTER the event
                                 is published to the PubSub — but NO reactor subscriber exists yet
   ② forkScoped(subscribe)    ← subscribe AFTER ①; PubSub never replays to a late subscriber, so the
                                 seed events are never seen as an eager change
   ③ enqueue { reconcile, eager:false }   ← registers the new built-ins as «не проверено», no probe
```

This is a strict happens-before (the subscriber fiber is forked *after* `reconcileBuiltins` fully
completes), so it is race-free given two properties: `dispatch` awaits publication, and an unbounded
`PubSub` does not deliver pre-subscription messages to a late subscriber.

---

## 6. Manual recheck

*Files: web `RecheckButton.tsx` → `useMcp.recheck` → `ws.ts` `mcp.recheck` → `McpSupervisor.recheck`.*

```
 user clicks "Проверить" (catalog detail / binding row / panel header)
   → client.mcp.recheck({ projectId?, serverId?, transport? })   (AND-combined filter, fire-and-forget)
   → supervisor.recheck(filter):
        matched = instances.filter(instanceMatchesRecheck(_, filter))
        probe each (concurrency 4, coalesced)   ← bypasses the due-gate
   → results flow back over subscribeMcpRuntime (debounced 200ms)
```

`instanceMatchesRecheck`: an instance matches if it has a ref `<project>:<server>` (or `catalog:<server>`)
satisfying the filter; `{serverId}` matches across projects (via the `catalog:` ref too), `{projectId}`
matches a whole project, `{projectId,serverId}` matches one binding, `{}` matches everything.

The button shows a local spinner until the `recheck` promise resolves; the *authoritative* «проверка…»
state comes from the runtime stream's `checking` flag.

---

## 7. "checking" & edit-lock

*Files: `McpSupervisor.ts` (`inFlightRef`, `probeInstance`), `McpRuntime.ts`, web dialogs.*

`checking` is **orthogonal** to `status`: it is `inFlight.has(instance.hash)`, flipped on the instant a
probe claims its in-flight slot and cleared when it settles — each transition publishes `changes`, so
the UI shows «проверка…» over the last-known status without losing it.

```
 probeInstance:
   claimInFlight(hash) ── already running? → return (coalesce)
   publish changes   ── UI flips to «проверка…»
   runProbe … ensuring( releaseInFlight(hash); publish changes )  ── UI clears «проверка…»
```

**Edit-lock:** the `McpServerDialog` refuses to save while `server.checking` is true ("Идёт проверка
сервера — дождитесь её завершения."). So a config edit can't race a probe of the config it is changing.

---

## 8. Incomplete gating — «требует настройки» vs «шаблон»

*Files: `mcp-core/resolver.ts` (`missingRequiredVars`, `resolveVarValues`), web `adapters.ts`
(`catalogMissingVars`, `hasPerProjectHole`, `computeMissingVars`).*

**The var model.** Every var is **required** (the web stamps `required: true` on every draft — there are no
optional vars). A var resolves from the binding's per-project value if set, else the catalog `value`; a var
declares `perProject` to say *where* its value lives:
- `perProject: false` — a **catalog-level** var. Its value is filled HERE, on the catalog server, and is
  shared by every binding. Left empty ⇒ `value === null` ⇒ the catalog config itself can't resolve.
- `perProject: true` — a **per-project hole**. It has NO catalog value (always `null`); each binding supplies
  it. Until a project fills it, that binding can't resolve.

`missingRequiredVars` is the single server-side predicate (it does NOT inspect `perProject` — only whether a
required var has *any* effective value at the level being checked):

```
 missingRequiredVars(vars, varValues) =
   vars.filter(v => v.required)
       .filter(v => !(v.name in varValues) && v.value === null)   ── required, no binding value, no catalog default
       .map(v => v.name)
```

This drives both reactor gates:
- **Catalog default** (`missingRequiredVars(vars, {})` non-empty): `computeDesired` skips the catalog
  instance (no probe). True whenever ANY required var has no catalog value — a catalog-level var left empty
  OR a per-project hole.
- **Binding** (`missingRequiredVars(vars, binding.varValues)` non-empty): `computeDesired` skips the binding
  and `writeOverlay` excludes it (qwen never spawns it). A binding fills the per-project holes; a still-empty
  catalog-level var keeps every binding incomplete until filled at the catalog.

**The two catalog UI states (web re-derives, free of a server dep):**

```
 catalogMissingVars(vars) = required & !perProject & value===null   ── ⇒ «требует настройки»
       the author must fill these on the catalog itself; once filled the default is probeable.

 hasPerProjectHole(vars)  = some required & perProject & value===null ⇒ templateOnly ── ⇒ «шаблон»
       the default can NEVER be probed (no catalog value for the hole); usable only once a project supplies it.

 computeMissingVars(vars, binding.varValues)   ── per-binding: required perProject holes the binding hasn't filled
       ⇒ that binding row shows «требует настройки» until the project supplies the value.
```

**Progression.** A server whose required vars are ALL catalog-valued (`perProject:false`, all set) is
probeable — its `catalog:` default appears with status + tools. Flip one var to `perProject:true` (or clear a
catalog value to `null`) and the default becomes a **«шаблон»**: `catalogMissingVars`/`hasPerProjectHole`
fire, `computeDesired` skips the default, and each binding stays incomplete («требует настройки») until that
project fills the hole.

---

## 9. Secrets

*Files: `McpSecrets.ts`, `McpSecretNames.ts`, `auth/.../ServerSecretStore.ts`, `McpReactor.gcOrphanedSecrets`.*

**Split (on add/update/bind).** `splitServerVars(serverId, draftVars, existingVars)`:

```
 for each draft var D (origin stamped "user"):
   if D.secret && D.keepSecret===true && existing[D.name].value is a secretRef:
        REUSE the existing ref   ── editing other fields never wipes an untouched secret  (item 13)
   else if D.value === null:    value = null            ── a per-project hole / cleared secret
   else if D.secret:            store plaintext at mcpVarSecretName(...) ; value = { secretRef }
   else:                        value = D.value          ── plain string
```

`splitBindingVarValues` is the per-project analogue: it preserves `keepNames` (untouched masked
secrets) from the existing binding, then stores (secret) or passes (plain) the supplied values, keyed by var name.

**Secret name** (`mcpVarSecretName`): `mcp-var-<b64url(serverId)>-<b64url(varName)>` and, for a
per-project value, `…-<b64url(projectId)>`. The shared prefix `mcp-var-` enables prefix GC.

**Materialize (probe/overlay).** `materializeSecretValues(vars, varValues)` reads every effective
secret ref from the store into a `{ refName → plaintext }` map, used only in-memory by `resolveConfig`.

**GC** (`gcOrphanedSecrets`, runs in every `reconcileNow`): collect every live secret ref (catalog vars
+ all binding values) and call `secretStore.pruneByPrefix("mcp-var-", liveRefs)` — deletes every
`mcp-var-*` file not in the live set.

---

## 10. Orphaned-varValues prune

*File: `McpReactor.ts` (`pruneOrphanedVarValues`), runs at the start of every `processSignal`.*

When a catalog edit removes a var, bindings may still carry a value for the now-undeclared name.

```
 for each binding B:
   declared = names of serverById[B.serverId].vars
   keep     = Object.keys(B.varValues).filter(n => declared.has(n))
   if keep.length === all names → no orphans, skip
   else dispatch mcp.binding-set { varValues:{}, keepVarValues: keep }   ── ref-preserving prune
```

`keepVarValues` carries the surviving names' *existing* refs through `splitBindingVarValues`, so no
plaintext is needed. After this prune the secret GC ([§9](#9-secrets)) is exact. The dispatched
binding-set produces a follow-up reconcile that converges (no orphans the second time).

---

## 11. The built-in migrator

*Files: `mcpBuiltinDefinitions.ts` (data), `McpBuiltins.ts` (helpers), `McpReactor.reconcileBuiltins`,
decider `mcp.builtin-sync`, `McpCatalogBuilders.buildSyncedBuiltin` + `mergeTemplateVars`.*

Built-ins ship as **managed templates**: a stable hidden `builtinId`, per-platform locked config, and
a content `builtinHash`. At startup the migrator reconciles the shipped list against the installed
catalog **by `builtinId`**:

```
 reconcileBuiltins() (startup, NOT eager):
   for each shipped definition D:
        config = builtinConfigForPlatform(D, process.platform)   ── null ⇒ unsupported OS ⇒ skip
        hash   = builtinHash(config, D)
        installed = catalog where builtinId === D.builtinId
        if installed && installed.builtinHash === hash → up-to-date, skip
        else dispatch mcp.builtin-sync { serverId:"srv-builtin-<id>", builtinId, builtinHash:hash,
                                         name, description, websiteUrl, config,
                                         shippedVars(origin:"shipped"), timeoutMs }
   for each installed server with builtinId NOT in the shipped set:
        dispatch mcp.server-remove   ── a dropped built-in is removed everywhere (cascades bindings)
```

The decider's `mcp.builtin-sync` branch builds the row via `buildSyncedBuiltin` and emits the existing
`mcp.server-added` (if new) or `mcp.server-updated` (if present) event — **no new event/projection**.

Each `mcp.builtin-sync` / `mcp.server-remove` dispatch above uses a **fresh `crypto.randomUUID()` commandId**
(`mkReconcileCommandId`). The real idempotency guard is the **hash gate** (`installed.builtinHash === hash →
skip`) and the presence check for removal — NOT the commandId. A stable/content commandId would be
permanently deduped by the engine's receipt store and would block a legitimate re-add after a removal or a
second removal (the dedup bug that was fixed). The one exception is **`autobind`** (`server:mcp-autobind:
<project>:<server>`), which keeps a **stable** id on purpose — its dedup *is* the "bind a built-in to a
project exactly once ever" guarantee, so a user who later disables that binding isn't re-enabled on restart.

**3-way merge (`buildSyncedBuiltin`)** — shipped parts replace, user data is preserved:

```
 shipped vars  : take each shipped declaration; KEEP the user's configured value by name if one exists
 user vars     : every existing origin:"user" var survives verbatim
 extraArgs     : preserved from the existing row (extraHeaders too)
 description   : shipped value ?? existing ?? null   ── shipped wins; else PRESERVE a probe-backfill (B3, §15)
 websiteUrl    : shipped value ?? existing ?? null   ── so a re-sync never clobbers a backfilled docs link
 enabled       : preserved (a user's disable survives template syncs — B5, §15)
 createdAt     : preserved ; source:"builtin" ; locked:true ; builtinId/builtinHash updated
```

**`mergeTemplateVars`** (used by `mcp.server-update`) is the editing-side rule:

```
 split = splitServerVars(serverId, draftVars, existing.vars)   ── all origin:"user", secrets stored
 if !existing.locked → return split
 // locked template: shipped DECLARATIONS are immutable; their VALUES are settable; user vars editable
 for each split var:  if its name matches a shipped declaration → re-stamp to that shipped declaration
                      (origin + flags) but TAKE the new value ; else keep as the user var
 also re-attach any shipped var the draft omitted entirely
```

This is why a managed built-in can never "fork": its command is locked (decider rejects a config
patch), its shipped var *declarations* are locked, but the user can still fill shipped *values*, add
user vars, and set `extraArgs`.

---

## 12. The turn-start overlay & restart gate

*Files: `ProviderCommandReactor.ts`, `McpOverlay.ts`, `CliAdapter.ts`, `CliAcpSupport.ts`,
`AcpSessionRuntime.ts`.*

```
 ensureSessionForThread (per turn):
   mcpOverlayResult = MCP_ENGINE_USE_OVERLAY ? writeOverlay(projectId) catch→null : null
   currentFP = mcpOverlayResult?.fingerprint

   writeOverlay(projectId):
     cwd = project workspaceRoot   ── null ⇒ write an EMPTY overlay (no ${PROJECT_CWD} possible)
     for each ENABLED binding whose catalog server is ENABLED (B5) and has no missingRequiredVars:
         resolved = resolveConfig(... S.extraHeaders, REAL cwd ..., materialized secrets)   ── extraHeaders merged (B6)
         mcpServers[serverId] = buildServerEntry(resolved, toolPolicy)   ── include/excludeTools from POLICY
         allowedServerNames += serverId ; fingerprintEntries += {name, resolved, policy}
     write system.json  { security.folderTrust.enabled:false, mcpServers }  (mode 0600 / dir 0700)
     return { overlayPath, allowedServerNames, fingerprint: overlayFingerprint(entries) }

   reuse gate (existing live session):
     spawnFP = sessionOverlayFingerprintRef[threadId]
     overlayChanged = currentFP !== undefined && spawnFP !== undefined && spawnFP !== currentFP
     if !cwdChanged && !instanceChanged && !shouldRestartForModelChange && !overlayChanged:
          return existing session                 ── REUSE
     else: startProviderSession({ resumeCursor }) ── RESPAWN with history preserved

   startProviderSession passes settingsOverlayPath + allowedMcpServers (when overlay present)
   bindSessionToThread records sessionOverlayFingerprintRef[threadId] = currentFP
```

**Spawn translation** (`CliAdapter` → `CliAcpSupport.buildCliAcpSpawnInput`):
```
 env  QWEN_CODE_SYSTEM_SETTINGS_PATH = overlayPath
 args  node <cli.js> [launchArgs] [--allowed-mcp-server-names a,b,c] --acp
 (ACP NewSession/LoadSession always sends mcpServers: [] — the overlay is the single source)
```

**Restart timeline:**
```
 turn N   : edit a bound server  → (later) turn N+1 writes a NEW overlay → fingerprint differs
 turn N+1 : overlayChanged = true → respawn with resumeCursor → qwen reads the new overlay
                                    → record new fingerprint → turn N+2 reuses
```

---

## 13. Warn-on-impact

*Files: web `serverConfigForm.describeEditImpact`, `McpServerDialog.tsx` (AlertDialog).*

A catalog edit that would disrupt projects already using the server opens a centered confirmation
before dispatching:

```
 on Save (editing):
   impact = describeEditImpact({id, server.vars}, nextVars, bindings, projectName)
     removedVars        = per-project vars being removed that some project already FILLED (by name → project names)
     newRequiredProjects= projects affected when a brand-new required var with no value is added
   if impact !== null → open AlertDialog (lists removed vars + affected projects); Применить → commit ; Отмена → close
   else → commit immediately
```

The modal nests over the editor Dialog (base-ui handles the stack). For a **locked** template the
update omits `config` (the decider would reject it) and sends `extraArgs` + user/shipped vars.

---

## 14. Tool params parsing

*File: `mcp-core/probe.ts` (`paramsFromInputSchema`).*

`listTools()` returns each tool with a JSON-Schema `inputSchema`. The probe maps it to the UI's flat
param rows:

```
 paramsFromInputSchema(inputSchema):
   props = inputSchema.properties ; if none → []
   required = new Set(inputSchema.required ?? [])
   for [name, prop] in props:
       { name, type: typeLabel(prop), required: required.has(name), description: schemaDescription(prop) }

 typeLabel: prop.type (or "any"); an "array" with typed items → "<item>[]", else "array".
```

Empty params ⇒ the tool stays `{ name, description }` (UI shows «Без параметров.»); otherwise the params
flow through the cache, the runtime snapshot, and `effectiveAllowedTools` into the tool list UI.

---

## 15. Description / docs-link backfill, enabled flag & overlay cleanup

*Files: `mcp-core/probe.ts`, `McpSupervisor.runProbe`, `McpReactor.ts`
(`backfillServerMetadata`, `computeDesired`, `project.deleted` handler), `McpOverlay.ts`,
`McpCatalogBuilders.buildSyncedBuiltin`, web `adapters.ts` (`catalogServerToRegistry`).*

### B3 — description + docs-link backfill (probe → catalog)

A server's own `serverInfo` (its `initialize` blurb) fills the catalog `description`/`websiteUrl`
**only when those fields are empty** — a shipped/user value always wins; the probe is the fallback.

```
 probe.ts (online connect):
   serverInfo = client.getServerVersion()
   return { …, serverDescription: serverInfo.description?, serverWebsiteUrl: serverInfo.websiteUrl? }

 McpSupervisor.runProbe → probeCache.upsert { …, serverDescription, serverWebsiteUrl }   ── into the row

 McpReactor.backfillServerMetadata (runs INSIDE reconcileNow, after supervisor.reconcile):
   for each catalog server S:
     if S.description !== null AND S.websiteUrl !== null → skip (nothing to fill)
     row = probeCache.getByKey(configCacheKey(S, {}))    ── the DEFAULT-config cache row
     if none → skip
     patch = { description?: row.serverDescription.trim() when S.description===null,
               websiteUrl?:  row.serverWebsiteUrl.trim()  when S.websiteUrl===null }
     if patch empty → skip
     dispatch mcp.server-update { commandId: mkReconcileCommandId("mcp-meta-backfill:<id>:<sorted patch fields>") [fresh uuid], patch }
```

The commandId is a **fresh `crypto.randomUUID()` per dispatch** (`mkReconcileCommandId`), NOT a stable id —
the engine's receipt store dedups by commandId, so a stable id would permanently block a legitimate
re-backfill after a field is re-cleared (the original dedup bug). Idempotency instead comes from the
**reactor's own guard** (skip when the field is non-null). The flow **converges**:
once a field is filled it is no longer `null`, so the next pass produces no patch and no dispatch. For a
**built-in**, `buildSyncedBuiltin` keeps `shipped ?? existing ?? null` ([§11](#11-the-built-in-migrator)),
so a backfilled value survives every re-sync (shipped value still wins if the definition ships one).

The web surfaces it: `catalogServerToRegistry` sets `docsUrl` from `server.websiteUrl` (shipped or
backfilled) and `description` from `server.description ?? ""`.

### B5 — the `enabled` flag (catalog-level disable)

A catalog server carries `enabled`. When `enabled === false`:

```
 computeDesired : skips the catalog default AND every binding of it ⇒ NO probe, no registry instance
 writeOverlay   : skips those bindings ⇒ never sent to qwen (the server can't spawn)
 bindings       : KEPT — a disable is reversible; re-enabling restores probing + overlay with no data loss
 buildSyncedBuiltin : preserves `existing.enabled` ⇒ a user's disable survives a template re-sync (§11)
```

In the project UI a kept-but-disabled binding stays listed, grayed «Отключён в каталоге»
(`ProjectBindingRow`, reading `server.enabled`); the catalog tile's toggle reads «Включить в каталоге».

### B4 — overlay cleanup on `project.deleted`

A deleted *server* self-heals (the next overlay write just omits it, and the spawn fingerprint differs).
A deleted *project* leaves a genuine orphan — its overlay directory — so the reactor removes it:

```
 streamDomainEvents: event.type === "project.deleted":
   overlay.removeOverlay(projectId)            ── best-effort `rm -rf <mcpOverlayDir>/<projectId>` (force); never fails the chain, logs failures at debug
     .andThen(enqueue { reconcile, eager:true })   ── then reconcile (bindings already cascade; GCs the rest)
```

`removeOverlay` is best-effort: `force` makes a missing dir a no-op, and a real removal failure is **logged
at debug** (not surfaced — the dir holds resolved secrets, so a persistent failure is worth watching) rather
than failing the chain, so the handler needs no recovery.

### B6 — extra-headers (http) through probe + overlay

A catalog server may carry `extraHeaders` (http only) that **merge OVER** `config.headers`. They are
threaded everywhere the config is resolved or keyed, so probe, overlay, dedup, and cache key all agree:

```
 resolveConfig (http branch): headers = { ...config.headers, ...extraHeaders } then expand each   ── override
 mergeDesired / writeOverlay : pass S.extraHeaders into resolveConfig
 configCacheKey(config, vars, varValues, extraArgs, extraHeaders)   ── 5-arg: extraHeaders in the canonical key
```

So changing `extraHeaders` changes both the dedup hash (a new instance/probe) and the cache key (its own
row) — exactly like an `extraArgs` change on a stdio server.
