# MCP — Server-side test coverage (state of the suite)

Status snapshot of the ru-fork MCP server-side test suite. **The suite is the source of truth: a red
test = broken logic.** Worktree: `.claude/worktrees/mcp`. Run from `apps/server`.

## Headline numbers (last clean run)
- **MCP suite** (`apps/server/tests/ru-fork/mcp/`): **18 files, all green.**
- **qwen-integration tests** (`tests/orchestration/Layers/RuForkProviderCommandReactor.test.ts`): the overlay-apply + respawn-on-fingerprint-change contract (5 dedicated tests).
- **Full `pnpm test:fast`**: **865 pass, 57 skip, 4 fail** — the 4 are **only `tests/bin.test.ts`** (packaged CLI absent in this sandbox — fail on a clean tree, NOT ours). **No MCP failures.**
- **`pnpm --filter @ru-code/ru-code typecheck`: 0 errors, 0 language-service hints.**
- **`oxlint`: 0 warnings / 0 errors** on the MCP source + tests.

## ✅ Fixed this round (were red, now green)
1. **Reconciler dedup bug (4 tests).** Reactor hygiene commands used a **content-stable `commandId`**;
   the engine dedups by commandId (`OrchestrationEngine.ts:157-170` — an `"accepted"` receipt
   short-circuits before the decider), so after the first run the command could never run again even when
   state diverged (re-add a removed built-in, remove-twice, re-prune a new orphan, re-backfill a cleared
   description). **Fix:** `McpReactor.mkReconcileCommandId(tag)` mints a **fresh `crypto.randomUUID()` per
   dispatch** for sync / remove / prune-vars / meta-backfill — matching the house idiom
   (`CheckpointReactor.ts:73`, `ProviderCommandReactor.ts:90`). `autobind` is **deliberately left stable**
   (its id IS its "bind once ever" guard). The reactor's own state diff (hash gate / presence / orphan /
   empty-field checks) is the real idempotency guard. All 4 lifecycle tests now green.
2. **Three silent error swallows → now observable (`logDebug`).** Best-effort behaviour preserved (none
   crashes its caller), but a real failure is now logged:
   - `ServerSecretStore.pruneByPrefix` — was `Effect.ignore` on the per-file `remove` + a **dead** outer
     `catch`. Now `remove(path, { force: true }).pipe(Effect.ignore({ log: true }))`-style: `force` makes a
     missing file a no-op, a real failure is logged, the loop continues, the dead catch is **deleted**, and
     the shape narrows `Effect<void, SecretStoreError>` → `Effect<void>` (cleared 2 lint hints).
   - `McpOverlay.removeOverlay` — `Effect.ignore` → `{ recursive, force }` + `catchCause → logDebug`
     (the overlay dir holds resolved secrets; a failed cleanup is now visible).
   - `McpRuntime` snapshot catch — silent empty-on-failure → `logDebug` then empty (a persistent DB read
     failure is no longer masked as "no servers configured").
3. **`ProviderCommandReactor` regression.** The MCP work had wrapped a clean direct return in a needless
   `Effect.gen` (`unnecessaryEffectGen` hint) — **unwrapped** back to the pre-MCP form (functionally
   identical). And the restart-decision log now includes **`overlayChanged` + both fingerprints**, so a
   restart caused by an MCP config change is visible (previously the only trigger that fired was invisible).

## The qwen/ACP turn-start integration (the actual CLI contract)
"Apply the overlay + allow-list each turn, and restart the session iff something changed" lives in
`ProviderCommandReactor` at turn-start, NOT in the MCP reactor. Tested in **two halves joined by the overlay
FINGERPRINT** (the literal value the reactor diffs):
- **What moves the fingerprint** (`overlayFingerprint.test.ts`, real `McpOverlay`): a required-var VALUE
  change does → restart; a **description-only** change does NOT → no restart; a tool-policy change does;
  **per-project isolation** — a per-project var change in project A moves A's fingerprint but not B's.
- **Fingerprint → respawn** (`RuForkProviderCommandReactor.test.ts`): the overlay path + `allowedMcpServers`
  reach `startSession` on spawn; an **unchanged** fingerprint ⇒ no restart; a **changed** one ⇒ restart
  **with the prior `resumeCursor`** (history preserved); a `writeOverlay` failure still spawns (best-effort);
  and an overlay change in **one project does not restart another project's thread**.

Composed: "change a required var → restart; change only the description → no restart; a per-project change in
project A never restarts project B's thread."

## Coverage (objective — `pnpm test` = `vitest run --coverage`)
Report at `apps/server/coverage/` (HTML at `coverage/index.html`). Per-file `ru-fork/mcp/*` after the
live-machinery + error-path tests:

| File | Cov | File | Cov |
|---|---|---|---|
| McpBuiltins, McpCatalogBuilders, McpInvariants, McpLayers, McpProjectors, McpProjectionQuery, McpReadModel, McpRuntime, McpSecretNames, McpSecrets, mcpBuiltinDefinitions | **100%** | McpOverlay | **99%** |
| McpSupervisor | **99%** (fn 92%) | McpReactor | **93%** |

The live machinery is covered (**Supervisor 61→99%, Reactor 71→93%, Projectors 82→100%, ProjectionQuery
91→100%**), and the reactor's `catchCause` hygiene arms are now proven **live** (`reactorErrorArms.test.ts`).

## Testability seams (behavior-IDENTICAL, exported only for tests)
On `McpReactor.ts`: `reconcileBuiltinsWith(definitions, platform)`, `backfillServerMetadataEffect`,
`pruneOrphanedVarValuesEffect`, `computeDesiredEffect`, `gcOrphanedSecretsEffect`,
`autobindBuiltinsForProjectWith(projectId)`. On `McpSupervisor`: **`sweepOnce`** exposes the existing
`runSweep` (the 60s loop body) for deterministic sweep tests. One fixture:
`packages/mcp-core/test-fixtures/fakeMcpStdioServer.mjs` (a real stdio MCP server for the online probe).

## What each test file covers
| File | Covers |
|---|---|
| `mcpCore.test.ts` | resolveConfig stdio + http, substitution, resolveVarValues, configCacheKey, dedupHash, missingRequiredVars, effectiveAllowedTools, overlayFingerprint, paramsFromInputSchema |
| `builtins.test.ts` | builtinConfigForPlatform, builtinShippedVars, builtinHash sensitivity (every field), buildSyncedBuiltin 3-way merge + definition-change, mergeTemplateVars, buildAddedServer/applyServerUpdate/buildBinding |
| `secretsKeep.test.ts` | splitServerVars keepSecret, splitBindingVarValues keepNames, collectVarSecretRefs + materializeSecretValues |
| `supervisorDecisions.test.ts` | instanceInWatched, isProbeDue, isSweepDue, instanceMatchesRecheck, nextStatus |
| `supervisorReconcile.test.ts` | McpSupervisor.reconcile register/cache-seed/preserve + F1 newly-referenced |
| `supervisorProbe.test.ts` | the live probe loop: online→registry+tools+latency+cache write-through; hard offline; consecutiveFailures 1→2→3; **coalescing**; **reconciled-away-mid-probe race**; recheck bypasses due-gate; cache-seed→live-overwrite |
| `supervisorSweep.test.ts` | the sweep orchestration (`sweepOnce`): due watched re-probed; never-probed skipped; intervals-0 off; empty no-op; watched-scope excludes others |
| `overlayApply.test.ts` | McpOverlay.writeOverlay/removeOverlay — stdio+http entry, ${VAR}/${PROJECT_CWD}, secret→env, disabled/incomplete skipping, include/excludeTools, folderTrust off, empty/remove |
| `overlayRemoveLogging.test.ts` | removeOverlay best-effort: never fails the caller, **logs (debug) a real remove failure** (FS-fault injected + min-level capture) |
| `overlayFingerprint.test.ts` | the restart trigger: var-value → changes; description-only → unchanged; tool-policy → changes; per-project isolation |
| `reactorEffects.test.ts` | computeDesired (gating/dedup/refcount), gcOrphanedSecrets, autobind on/off |
| `reactorErrorArms.test.ts` | the reactor `catchCause` arms are **live**: a failed sync/remove/backfill/prune dispatch is logged and the loop continues (fake failing engine + fake repos) |
| `reactorWorker.test.ts` | worker/start end-to-end: seeds built-ins + no-probe-on-load; **server-add → stream → worker → reconcileNow → probe → ONLINE**; project.created autobind on/off; probe-cache GC; project.deleted drops the ref |
| `projectionQuery.test.ts` | McpProjectionQuery.getSnapshot (full + filtered); subscriptionStream emits on a relevant event; mcp.binding-remove cascade |
| `runtimeSnapshot.test.ts` | McpRuntime.currentSnapshot (binding + catalog runtime status/tools via supervisor join) |
| `runtimeSnapshotResilience.test.ts` | a repo read failure → empty snapshot (no UI crash) **and logs it at debug** (failing-repo fault injection) |
| `probe.test.ts` | probeOnce offline (unspawnable), connect-timeout, ONLINE (real fake MCP server: listTools + param mapping) |
| `reconciliationLifecycle.test.ts` | engine-level lifecycle: no-op dedup, changed-def propagates, **the 4 (now-fixed) dedup cases**, same-name customs, cascade no-leftovers, decider guards |

## Test harness patterns (for adding more)
- **Engine harness:** `OrchestrationEngineLive` + `OrchestrationProjectionPipelineLive` over
  `SqlitePersistenceMemory`; dispatch real commands, query the repos. To add a service, build `base` then
  `ServiceLive.pipe(Layer.provideMerge(base))`.
- **Fault injection without mocks:** override one FileSystem method via a `Layer.effect(FileSystem, …{ ...fs, remove })`
  spread (cast-free); inject a failing repo via `Layer.succeed(Repo, { method: () => Effect.fail(new PersistenceSqlError(…)) })`.
- **Capturing logs:** `Logger.make(({ logLevel, message }) => …)` + `Logger.layer([logger], { mergeWithExisting: false })`;
  to capture `logDebug` you MUST lower the level with `Layer.succeed(References.MinimumLogLevel, "Debug")` — the
  value is the **string `"Debug"`** (in this Effect beta `LogLevel` is a string union; `LogLevel.Debug` is `undefined`).
- **Service-layer precedence gotcha:** to make a service (e.g. `McpOverlay`) bind to an *overridden* dependency
  (e.g. a failing FileSystem), the override layer must be the **inner** `provideMerge`, before `base`.
- **Service-tag gotcha:** a tag isn't an Effect — use `Effect.service(Tag)` / `yield* Tag`, never `Effect.flatMap(Tag, …)`.

## ⚠️ Honest scope — still NOT "0 bugs / 100% sure"
- A passing test can under-assert and hide a bug (false-greens were caught twice this round — a remove-twice
  test, and a min-level wiring that silently captured nothing).
- **qwen integration:** the overlay-apply + respawn **logic** is tested, but with a **stubbed `ProviderService`**.
  The real qwen subprocess and the ACP wire protocol are **not run here** — we assert the reactor passes the
  right inputs / makes the right restart decision, not that qwen consumes them. A live-qwen smoke test on a
  real machine is still the missing last mile.
- **Out of scope:** the **web/UI layer** (no web test target — validated by typecheck + lint only).
- See `AUDIT.md` for the full feature-level gap analysis.

## Constraints (unchanged)
No `as`/`any`/`unknown` casts; `Effect.catch`/`catchCause` not `catchAll`; `logError`/`logDebug` only; mark
ru-fork deltas; web validated by typecheck+lint only; never run qwen. The 4 `bin.test.ts` failures are the
env baseline, not regressions.

---

## improvements-branch-3 suite (2026-06-14)

New tests under `apps/server/tests/ru-fork/mcp/branch3*.ts` (+ shared `branch3Helpers.ts`), all green:
- `branch3DeciderGuards` — #2 config-uniqueness (dup add / edit-collide / built-in skip), #8 var/`${VAR}`
  validation, #6 trust default+toggle.
- `branch3Hash64` — #10 64-bit `fnv1a`.
- `branch3SecretAtRest` — #4 secrets not plaintext on disk.
- `branch3MissingSecret` — #9 missing-secret instance excluded.
- `branch3OrphanGc` — #7 orphan-secret GC (the transactional safety net).
- `branch3OverlayGuards` — overlay↔qwen schema conformance + fingerprint respawn matrix (incl. trust),
  + `buildServerEntry` emits `trust`.
- `branch3BackfillOrdering` — #1 description back-fill runs after the probe.

Canary tests fixed honestly (config is now the identity, so same-config scaffolding was made distinct):
`overlayApply` ×2, `reactorEffects` GC, `reconciliationLifecycle` "same name" (→ same name + different config).

Full gate: server/web/contracts `typecheck` 0 · `oxlint` 0/0 · `build` ✔ · `test:fast` = 886 pass / 57 skip /
4 `bin.test.ts` baseline. Remaining: #4 ephemeral-overlay (test via `tests/provider/fakeAcpSpawner.ts`) + #11.
