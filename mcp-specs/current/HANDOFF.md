# MCP — session handoff (resume anchor)

**Worktree:** `/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code/.claude/worktrees/mcp`.
Run server commands from `apps/server`. All work below is **unstaged working-tree changes** — do **not**
commit unless asked.

## Where things stand (2026-06-14)
The MCP feature is fully built. The **improvements-branch-3** round is implemented and green except two
deferred items. Read **`improvments-banch-3.md`** (top "IMPLEMENTATION STATUS" block) first.

**Done + verified** (gates: server/web/contracts `typecheck` 0 · `oxlint` 0/0 · `build` ✔ ·
`test:fast` = **886 pass**, only the 4 preexisting `tests/bin.test.ts` env failures):
- #1 backfill ordering · #2 config-uniqueness + built-in skip · **#4 secret encryption** (scrypt+AES-GCM,
  `auth/secretCrypto.ts`) · #5 readable UI toasts · **#6 trust** (full chain: contract→DB→projection→
  builders→overlay→fingerprint→UI) · #8 var validation · #9 missing-secret exclusion · #10 64-bit hash ·
  server-side rejected-command logging (`logDebug` invariant / `logError` genuine).
- Tests: `apps/server/tests/ru-fork/mcp/branch3*.ts` (+ `branch3Helpers.ts`); 4 canary tests fixed
  honestly (distinct configs); trust + readable-error coverage added. `mcp-probe` D6/D7 added (operator runs it).

## What to do next

### ✅ #4 ephemeral overlay — DONE (2026-06-14)
Implemented + green. The resolved overlay is now deleted on every spawn settle (success/error/start-timeout/
reuse/interrupt) via `Effect.ensuring` in `ProviderCommandReactor`, plus an **inner CLI start timeout**
(`ACP_SESSION_START_TIMEOUT_MS`, `CliAdapter` `timeoutOrElse`) that converts a wedged `cli --acp` boot into a
typed error so the finalizer reliably fires, plus **sweep-on-start** (`serverRuntimeStartup` →
`McpOverlay.removeAllOverlays`) and **sweep-on-shutdown** (`fastShutdown` sync `rmSync`). Full before/after +
the 13-test guarantee matrix: **`improvments-banch-4.md`**. Verified: typecheck 0 · oxlint 0/0 ·
`test:fast` 896 pass (only the 4 `bin.test.ts` baseline). The detail below is kept for history.

### 1. #4 ephemeral overlay (the remaining security half) — (DONE — see above)
**Goal:** the resolved qwen overlay (`${stateDir}/mcp/overlays/<projectId>/system.json`) holds plaintext
secrets and currently persists until project-delete. Delete it **right after the session establishes**.

**Proven safe (qwen 0.13.1 source-verified):** qwen reads the system settings file **once** at startup
(`loadSettings()` → `loadAndMigrate(systemSettingsPath, SettingScope.System)`), stores it in-memory,
**never** re-reads it (no settings file watcher), **never** writes the System scope (`setValue` only
targets User/Workspace), and stores MCP OAuth tokens in a SEPARATE encrypted file
(`~/.qwen/mcp-oauth-tokens-v2.json`) — never back into the overlay. So deletion after startup is safe.

**Where to hook the delete:** after `sessionSetupResult` resolves in the session-spawn path — it's
assigned from **`session/load` (resume) OR `session/new` (fresh)**, so hanging the delete there covers
**resume** too (resume = a brand-new `qwen --acp` spawn that re-writes + re-reads the overlay). Thread
the overlay path so it's deletable; the reactor (`ProviderCommandReactor`) owns `mcpOverlayResult.overlayPath`
and writes it before every spawn (`ProviderCommandReactor.ts` ~531-561).

**The test harness EXISTS** (the earlier "no harness" claim was wrong):
- `apps/server/tests/provider/fakeAcpSpawner.ts` + `fakeAcpCore.ts` — an in-memory `ChildProcessSpawner`
  that runs the **real `CliAdapter` + `AcpSessionRuntime`** over a scripted fake agent; the fake answers
  `initialize`/`session/new`/`session/load` (`handleCreateSession`/`handleLoadSession` →
  `{ sessionId: FAKE_SESSION_ID }`), so a real session establishes deterministically (no real process).
- Working example: `apps/server/tests/provider/cliAdapterErrorEngine.test.ts` — `adapter.startSession({
  threadId, cwd, runtimeMode })` over `fakeAcpSpawnerLayer(script)`, awaited to a live session.
- (Reactor-level `RuForkProviderCommandReactor.test.ts` / `OrchestrationEngineHarness.integration.ts`
  use a **mock** provider/overlay — good for respawn LOGIC, not for real-file deletion.)

**Test to write** (cliAdapterErrorEngine-style): write a REAL temp overlay file, point the spawn's
`settingsOverlayPath` at it, start a session over `fakeAcpSpawnerLayer`, assert the file is **gone** after
the session establishes; plus a **fallback** case — a spawn that never establishes must still clean up
(short timer or session-scope finalizer) so a crashed spawn doesn't leak the plaintext file. Confirm
whether `startSession`'s input carries `settingsOverlayPath` as a field the runtime can read for the
delete (it flows into the spawn env via `CliAcpSupport.buildCliAcpSpawnInput`); thread it if not.

### 2. #11 watchedProjects (deferred to last)
Per-connection watched sets + union sweep, drop on disconnect. Full exact diff in
`improvments-banch-3.md` §11. Nothing is broken without it (single-window works; only multi-window
background auto-reprobe is scoped to the last-focused project; manual recheck still works). Do it after #4.

## Hard constraints (the user enforces these)
- **No test edits unless fixing a genuine canary** — and then ADJUST honestly (distinct configs / fix the
  premise), never delete a test, no blind spots; cover new behavior with new tests. **Report any
  UNEXPECTED degradation; if you can't fix something the clean way, STOP and report** (don't cut corners).
- **No `as`/`any`/`unknown` casts; `Effect.catch`/`catchCause`; only `logError`/`logDebug`** (error = a
  genuine blocking failure, debug = expected/user-input); mark ru-fork deltas with `ru-fork:`.
- **MCP feature never shipped → no backcompat/migration** (don't add fallback/wipe branches).
- Web has no test target — validate web with typecheck+lint. **Never run qwen/the project** (not
  installed); the operator runs `mcp-probe` (`node ./mcp-probe/test.js` → `RESULT: GO`).
- Every error the server sends to the UI must ALSO appear in the terminal (error if blocking, else debug).
- The 4 `tests/bin.test.ts` failures are the only allowed baseline.
