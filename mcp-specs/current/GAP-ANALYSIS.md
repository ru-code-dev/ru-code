# MCP feature — gap analysis ("what are we still missing")

Comprehensive audit of the whole MCP feature (server logic, decider, overlay→qwen integration, web UI,
persistence, operations), synthesized from two independent source audits + the test/coverage state.
Date: 2026-06-14. Read-only analysis — **nothing here is fixed yet** unless noted.

**Bottom line:** the feature is **substantial and mostly real** (full CQRS catalog/bindings, supervisor +
reactor monitoring, turn-start overlay, secrets-as-refs, a complete web panel). The implementation depth is
high and the reactor/supervisor/secrets units are unusually well-tested. The remaining gaps cluster in four
places: **(1) the product never verifies qwen actually consumed the overlay**, **(2) plaintext secrets at
rest (in two locations)**, **(3) the UI swallows every server-side error**, and **(4) a few missing
decider validations**. None is a showstopper; together they're the difference between "works on my machine"
and "trustworthy."

---

## Tier 1 — real correctness / security gaps (fix first)

1. **Nothing verifies qwen loaded the overlay — it's fire-and-forget.** The overlay reaches qwen out-of-band
   (env `QWEN_CODE_SYSTEM_SETTINGS_PATH` + CLI `--allowed-mcp-server-names`, `CliAcpSupport.ts:81-88`), and
   the ACP `session/new`/`load` deliberately send `mcpServers: []` (`AcpSessionRuntime.ts:439,456,472`). The
   `session/new` response (`sessionSetupResult`) carries qwen's actually-loaded servers/tools but is
   **never inspected** (`AcpSessionRuntime.ts:463-489`). If qwen ignores the overlay (wrong path, schema
   drift, version mismatch), the server can't tell, and the UI keeps showing the supervisor's independent
   green probe. **This is the single biggest gap** — the whole feature trusts qwen blindly.
2. **Secrets stored in plaintext at rest, in two places.** `ServerSecretStore` writes raw bytes to
   `<stateDir>/secrets/<name>.bin` (mode 0600), and the resolved overlay materializes the same plaintext
   secrets into `mcp/overlays/<projectId>/system.json` (`McpOverlay.ts:159-197`). No encryption / keychain —
   protection is filesystem permissions only. Anyone who can read the user's home dir (backup, sync, a
   same-user process) reads every MCP API key. Confirm `stateDir` is excluded from any synced/backed-up path
   (nothing in code enforces it).
3. **The UI swallows every mutation error.** `dispatchMcpCommand` does `.catch(() => undefined)`
   (`useMcp.ts:107`), and `recheck` likewise (`:281`). A rejected `mcp.server-add`/`binding-set`/`recheck`
   shows **no toast, no error state, no retry** — the dialog closes as if it succeeded. Biggest user-facing
   gap: failure is indistinguishable from success.
4. **Two dead dialog controls.** "Доверять серверу" and "Включить все инструменты" toggle local state but are
   **never read** in submit (`McpServerDialog.tsx:96-97, 128-206`). They're misleading no-ops.
5. **`autobindDefaults` is unreachable from the UI.** Honored server-side (`McpReactor.ts:408`) and in the
   contract (`settings.ts:237`), but there's no toggle anywhere in `apps/web`. A documented behavior with no
   switch.
6. **`mcp.builtin-sync` has no absent/built-in guard.** Unlike `server-add`, the decider branch
   (`decider.ts:804-831`) never checks `requireCatalogServerAbsent` or that an existing row is actually a
   built-in. A pre-existing **custom** server whose id collides with `srv-builtin-<id>` would be silently
   **overwritten/converted to a locked built-in** on the next startup sync. Correctness + mild security.

## Tier 2 — robustness / edge cases

7. **Secrets are written before the event commits (non-transactional).** The decider runs
   `splitServerVars`/`splitBindingVarValues` (→ `secretStore.set`) *before* the `sql.withTransaction` that
   appends the event (`OrchestrationEngine.ts:172-221`). A failed/empty command leaves an orphan `.bin` on
   disk; only the eventual reactor GC cleans it — self-healing, not transactional. (Worse given plaintext
   storage: a leaked secret persists silently until GC.)
8. **No validation tying values/placeholders to declared vars:**
   - binding `varValues` for **undeclared** names (or `perProject:false` vars) are persisted + get secret
     files written, then ignored by the resolver — stored-but-inert + orphan secrets (`McpSecrets.ts:103-115`,
     `resolver.ts:78`). Only the item-11 prune cleans them.
   - a config `${FOO}` referencing an **undeclared** var silently expands to `""` (`resolver.ts:50-58`) — a
     typo produces a silently broken command with no error.
   - `mcp.server-update` doesn't re-validate the resulting config/required-vars (`decider.ts:776-799`).
9. **`materializeSecretValues` maps a missing/corrupt secret ref to `""`** (`McpSecrets.ts:152-154`,
   `resolver.ts:86`). A deleted secret → server spawns/probes with a **blank credential** and just shows
   "offline", with no signal the secret is gone.
10. **`writeOverlay` empties the overlay when the project cwd is missing** (`McpOverlay.ts:142-182`). A
    transient snapshot-query miss strips **every** MCP server for that turn (not just `${PROJECT_CWD}` ones).
11. **Probe vs. real session diverge on cwd.** Probes resolve `${PROJECT_CWD}` to a neutral `mcpProbeCwd`
    (`config.ts:219-224`) while the overlay uses the real project cwd. A cwd-dependent server (e.g. filesystem
    server) is validated against a different directory than it runs in — green probe, possibly broken session.
12. **Cross-client `setWatchedProjects` is last-writer-wins** (`McpSupervisor.ts:248-249`, `ws.ts:952-957`).
    Two UI clients on different projects clobber each other's watched set → one silently stops auto-probing.
13. **32-bit FNV-1a hashes everywhere** (`dedupHash`/`configCacheKey`/`overlayFingerprint`/`builtinHash`,
    `resolver.ts:201-209`). A collision → two different configs share one instance / cache row, or a missed
    respawn. Low probability, wrong blast radius (wrong status/tools shown, stale qwen session).
14. **Cached `degraded` rehydrates as `offline`** on restart (`McpSupervisor.ts:299-305`) — the degraded
    distinction is lost across restart (the cache schema narrows status to online|offline).
15. **Overlay change mid-turn is invisible until the next turn** (fingerprint compare only fires at the next
    turn-start, `ProviderCommandReactor.ts:620-621`) — a real "my change didn't apply" surprise, no UI signal.

## Operational / observability

- **Every GC path is best-effort + debug-logged** (probe-cache GC, orphan-secret GC, var-value prune, overlay
  removal). A leaked plaintext secret `.bin` from a failed prune persists **silently** (this round we at least
  made these `logDebug` instead of fully silent — but per the audit a *security-relevant* cleanup failure
  arguably warrants `logError`; we chose debug-for-now).
- **No metric/health surface** for "overlay write failed → spawned without MCP" beyond one error log; the user
  sees no MCP and no UI signal.
- **`MCP_ENGINE_USE_OVERLAY` is a hard-coded source constant** (`config.ts:79`) — a kill switch not exposed to
  env/settings.
- **Probe-cache GC never clears the terminal empty state** (`McpReactor.ts:486-495`): intentional guard against
  wiping on a transient all-incomplete state, but orphan rows persist forever if all servers are removed.

## User-facing missing pieces

- No error feedback on any MCP action (Tier 1 #3). No "test connection" before save; a server can only be
  probed after it's saved.
- No way to see whether MCP actually reached the model this session ("qwen loaded N servers, M tools") — only
  the out-of-band probe status.
- No bulk import (paste a `.mcp.json` / `mcpServers` block) — one server at a time (`addMcpParsing.ts`).
- No per-server diagnostics/logs (spawn stderr, qwen MCP-load errors) — only the one-line probe `message`.

## Test gaps (despite high unit coverage)

- **No live qwen / ACP test** — the overlay-apply + respawn logic is tested only against a **stubbed
  `ProviderService`**; nothing exercises the real subprocess or the `--allowed-mcp-server-names`/overlay-path
  consumption. This is the missing last mile.
- The **overlay-fingerprint cache-eviction** respawn path (`ProviderCommandReactor.ts:617-621`) — a long-idle
  thread losing its `spawnFingerprint` — is under-tested; the evict→respawn behavior deserves a direct test.
- No test for: `mcp.builtin-sync` landing on a colliding custom id (#6); a decider failure → orphan secret →
  GC (#7); undeclared-var validation (#8); a probe proceeding with a blank credential (#9); cross-client
  watched clobber (#12); `extraHeaders` overriding a same-named `config.headers` key.
- **Web UI has zero test target** — validated by typecheck+lint only.

## What's solid (so this is balanced)
- Catalog/binding CQRS + cascade deletes; built-in 3-way-merge reconciliation; desired-set dedup + refcounting;
  the health supervisor (sweep scope, in-flight coalescing, status state machine); secrets-as-refs split; the
  config-keyed probe cache. All have real, asserted unit tests (`apps/server/tests/ru-fork/mcp/`).
- The **reconciler dedup bug** (re-add / remove-twice / re-prune / re-backfill) and the **three silent error
  swallows** were **found and fixed this round** (see `TESTING.md` → "Fixed this round").
- The qwen restart **decision** logic (apply overlay + respawn on fingerprint change, per-project isolation,
  resume-cursor preservation) is now tested end-to-end through the real reactor.

## Suggested priority order
1. **Surface UI errors** (#3) + remove/flag the dead controls (#4) + add the `autobindDefaults` toggle (#5) —
   cheap, high user value.
2. **Add the `mcp.builtin-sync` absent/built-in guard** (#6) — small decider change, prevents data loss.
3. **Verify qwen consumed the overlay** (#1) — inspect `sessionSetupResult` and surface a mismatch.
4. **Encrypt secrets at rest** (#2) — or at minimum document/enforce the `stateDir` exclusion.
5. **Add the missing decider validations** (#8) and make the secret write transactional (#7).
6. **A live-qwen smoke test** to close the integration last mile.
