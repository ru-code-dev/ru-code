# improvements-branch-4 — Ephemeral overlay deletion + lifecycle sweep (#4)

**Status:** ✅ IMPLEMENTED + GREEN (2026-06-14). Worktree `.claude/worktrees/mcp`, run server cmds from `apps/server`.

> **Verified:** `tsc --noEmit` 0 errors · `oxlint` 0/0 on all changed files · `test:fast` =
> **896 passed / 57 skipped**, only the 4 pre-existing `bin.test.ts` env failures remain. All 6 changes
> landed as specified below (Change 3 first, then 1/2/4/5/6). Tests: G1/G2/G3/G8/G10/G12/G13 green guards;
> G4/G5/G6 (reactor `ensuring` delete), G7 (inner start timeout → error), G11 (shutdown sweep) went
> red→green on wiring. Ordering proof (file written+finalized BEFORE spawn) locked by **G13** +
> `overlayApply` (real atomic write read-back). Real-qwen overlay shape unchanged ⇒ `mcp-probe` still GO.
**Scope:** make the per-project qwen settings overlay (`<mcpOverlayDir>/<projectId>/system.json`) — which
holds **resolved plaintext secrets** — *ephemeral*: it exists only across the spawn boot and is deleted
afterwards, on every code path, plus swept on app start and shutdown. Includes the **inner CLI-start
timeout** that turns a hung `cli --acp` boot into an *error* (the thing that makes deletion reliable).

This doc gives **literal before→after** for every change and the **test matrix** that guarantees both
(a) the overlay APPLY behaviour stays correct (no spurious restarts, no wrong apply) and (b) deletion
happens on success, error, start-timeout, reuse, app-start, and app-shutdown.

---

## 0. The finding that drives the design (verified from source)

There is **no timeout on the ACP start handshake.** `runLoggedRequest` (`AcpSessionRuntime.ts:198-224`)
wraps `initialize` / `session/new` / `session/load` with **logging only** — no `Effect.timeout`. The two
watchdogs in `CliAdapter` are forked **after** `acp.start()` returns and only act while a turn is active
(`childExitFiber` waits on `acp.waitForExit`; `stallWatchdogFiber` early-returns unless
`ctx.activeTurnId !== undefined`). The `config.ts` timeout consts (`ACP_WIRE_STALL_WARN_MS = 1h`,
`ACP_WIRE_STALL_KILL_MS = 2h`) are **turn-stall** thresholds, not a start timeout.

**Consequence:** if `cli --acp` spawns but hangs at boot and never answers `initialize`,
`providerService.startSession` → `startProviderSession` **hangs forever**. A plain `Effect.ensuring`
wrapped around it would therefore **never fire**. So we must add a start timeout that *fails*, converting
the hang into a typed error — and the deletion hangs off that settled outcome.

### Why deletion can never cause a wrong restart (the apply-correctness guarantee)

The restart decision is `overlayChanged = currentOverlayFingerprint !== spawnFingerprint`
(`ProviderCommandReactor.ts:617-621`). Both fingerprints are **computed in memory** by `overlayFingerprint`
over the **catalog + bindings** (`McpOverlay.ts:214`), and the spawn-time one is cached **per thread** in
`sessionOverlayFingerprints` (`:589-591`). **Nothing re-reads the overlay file to decide a restart.**
Therefore deleting the file between turns cannot change the decision: next turn `writeOverlay` recomputes
the same fingerprint from the same catalog/bindings and the reuse path is taken. This is proven by test
**G1** below.

### The lifetime of the file

The file is needed **only from the moment we write it until the freshly-spawned child has booted and read
it** (qwen reads settings once at startup via `loadSettings()`, never re-reads, never writes the System
scope, stores MCP OAuth in a separate encrypted file — source-proven in `HANDOFF.md`). A successful
`initialize` round-trip proves the read already happened. On a **reuse** turn no new child boots, so the
freshly-written file is dead weight the instant the decision returns. So the correct lifetime is exactly
**the spawn-decision region of one turn-start**, on every exit path.

---

## 1. The design — three mechanisms (your 5 items, consolidated)

| Your item | Mechanism | Where |
|---|---|---|
| 1 delete after session true + 2 delete on any spawn error | **A. `ensuring(delete)` around the spawn-decision region** — fires on success, failure, AND interruption (one hook, can't be skipped) | `ProviderCommandReactor.ensureSessionForThread` |
| 3 delete after timeout / "inner cli start timeout produces error → deletion" | **A0. inner start timeout** — `Effect.timeoutOrElse` around `acp.start()` fails with a typed error so A's `ensuring` reliably fires (not a separate file-timer) | `CliAdapter.startSession` |
| 4 delete all on shutdown | **C. sync sweep of `mcpOverlayDir`** | `fastShutdown.runFastShutdownCleanup` |
| 5 delete all on start | **B. async sweep of `mcpOverlayDir`** | `serverRuntimeStartup` startup phase |

Net: `A0` guarantees the spawn always **settles**; `A` deletes the per-turn file on every settle + reuse +
interrupt; `B` cleans anything a hard crash (SIGKILL/power-loss, where `A`/`C` never ran) left behind; `C`
shrinks the on-disk window on graceful stop. **Item 3 is NOT a redundant file-timer** — it is the start
timeout, which is a real latent-bug fix (a hung CLI boot currently strands the turn forever).

**Asymmetry to note:** `B` (startup) runs in the normal Effect program → uses the async Effect
`FileSystem`. `C` (shutdown) runs inside the **synchronous SIGINT/SIGTERM handler** via `Effect.runSync`
(`server.ts` fast-exit path) → must use **`nodeFs.rmSync`** (sync), exactly like the existing
`nodeFs.unlinkSync(serverRuntimeStatePath)` in `runFastShutdownCleanup`. An async `FileSystem.remove`
there would throw under `runSync`.

---

## CHANGE 1 — `config.ts`: add the start-timeout constant

**File:** `apps/server/src/config.ts` (after `POST_ANSWER_RESUME_TIMEOUT_MS`, ~line 149).

### Before
```ts
export const POST_ANSWER_RESUME_TIMEOUT_MS = 3_600_000;

/**
 * CONTEXT_WINDOW_TOKENS — total context window size advertised to the
```

### After
```ts
export const POST_ANSWER_RESUME_TIMEOUT_MS = 3_600_000;

/**
 * ACP_SESSION_START_TIMEOUT_MS — hard ceiling on the ACP start handshake
 * (`initialize` + `authenticate` + `session/new`|`session/load`). Unlike the
 * wire-stall thresholds above (which only apply DURING an active turn), nothing
 * else bounds the start: if a freshly-spawned `cli --acp` child hangs at boot
 * and never answers `initialize`, `startSession` would otherwise hang forever.
 * On timeout the adapter fails the start with a typed ProviderAdapterProcessError
 * (the session scope then closes and SIGKILLs the child). 60s is generous for a
 * cold node boot + qwen init (typically <10s) yet short enough to surface a wedge
 * and — for ru-fork MCP — release the ephemeral overlay promptly. Tunable.
 */
export const ACP_SESSION_START_TIMEOUT_MS = 60_000;

/**
 * CONTEXT_WINDOW_TOKENS — total context window size advertised to the
```

**Why a module const (not a ServerConfig field):** matches every other timeout here
(`ACP_WIRE_STALL_*`, `POST_ANSWER_RESUME_TIMEOUT_MS`). Test-time override is injected through the adapter
options (Change 2), so we don't need it on `ServerConfig`.

---

## CHANGE 2 — `CliAdapter.ts`: the inner start timeout (hang → typed error)

**File:** `apps/server/src/provider/Layers/CliAdapter.ts`.

### 2a. Import the const (line 50-59 import block)

#### Before
```ts
  ACP_WIRE_STALL_KILL_MS,
```
#### After
```ts
  ACP_SESSION_START_TIMEOUT_MS,
  ACP_WIRE_STALL_KILL_MS,
```
(Keep alphabetical with the existing sorted import; `ACP_SESSION_*` sorts before `ACP_WIRE_*`.)

Also ensure `Duration` is imported (it is **not** currently in CliAdapter). Add near the other
`effect/*` imports at the top of the file:
```ts
import * as Duration from "effect/Duration";
```

### 2b. Add the option for test injection (interface at line 104-108)

#### Before
```ts
export interface CliAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
}
```
#### After
```ts
export interface CliAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
  /**
   * ru-fork: override the ACP start-handshake timeout. Production omits it ⇒
   * ACP_SESSION_START_TIMEOUT_MS. Tests pass a tiny value so a scripted hang at
   * `session/new` trips the timeout without a real-time wait.
   */
  readonly sessionStartTimeoutMs?: number;
}
```

### 2c. Resolve the default once (near `boundInstanceId`, ~line 400)

#### Before
```ts
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(CLI_NAME);
```
#### After
```ts
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(CLI_NAME);
    // ru-fork: bound the start handshake so a wedged `cli --acp` boot fails instead
    // of hanging the turn forever (and, for MCP, promptly releases the ephemeral overlay).
    const sessionStartTimeoutMs = options?.sessionStartTimeoutMs ?? ACP_SESSION_START_TIMEOUT_MS;
```

### 2d. Wrap `acp.start()`'s result in the timeout (the `started` binding, lines 1028-1046)

`started` is the value of an `Effect.gen` that ends in `return yield* acp.start()`, then `.pipe(tapError,
mapError)`. We add `Effect.timeoutOrElse` as the **outermost** step so it bounds the whole handshake and
emits an already-mapped adapter error. (`timeoutOrElse` is the exact API used elsewhere in this repo —
`daemonLauncher.ts:197`.)

#### Before
```ts
            return yield* acp.start();
          }).pipe(
            // ru-fork: capture the CLI exit code at the boundary —
            // `mapAcpToAdapterError` below wraps `AcpProcessExitedError`
            // in `ProviderAdapterSessionClosedError`, dropping `.code` from
            // structured log fields.
            Effect.tapError((error) =>
              isAcpProcessExitedError(error)
                ? Effect.logError("[cli-acp.process-exited]", {
                    threadId: input.threadId,
                    method: "session/start",
                    exitCode: error.code,
                  })
                : Effect.void,
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
```
#### After
```ts
            return yield* acp.start();
          }).pipe(
            // ru-fork: capture the CLI exit code at the boundary —
            // `mapAcpToAdapterError` below wraps `AcpProcessExitedError`
            // in `ProviderAdapterSessionClosedError`, dropping `.code` from
            // structured log fields.
            Effect.tapError((error) =>
              isAcpProcessExitedError(error)
                ? Effect.logError("[cli-acp.process-exited]", {
                    threadId: input.threadId,
                    method: "session/start",
                    exitCode: error.code,
                  })
                : Effect.void,
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
            // ru-fork: hard ceiling on the start handshake. Nothing else bounds it
            // (the stall/child-exit watchdogs are forked only AFTER start and act
            // only during an active turn). On timeout the interrupt unwinds the
            // pending `initialize`/`session.new` RPC and the session scope closes,
            // SIGKILLing the child; we surface a typed adapter error so callers
            // (and the reactor's overlay finalizer) see a settled failure.
            Effect.timeoutOrElse({
              duration: Duration.millis(sessionStartTimeoutMs),
              orElse: () =>
                Effect.logError("[cli-acp.start-timeout]", {
                  threadId: input.threadId,
                  method: "session/start",
                  timeoutMs: sessionStartTimeoutMs,
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: input.threadId,
                        detail: `ACP session did not complete its start handshake within ${sessionStartTimeoutMs}ms — the cli --acp child is unresponsive.`,
                        cause: new Error("acp-session-start-timeout"),
                      }),
                    ),
                  ),
                ),
            }),
          );
```

**Notes / correctness:**
- `ProviderAdapterProcessError` is already imported and constructed with exactly `{ provider, threadId,
  detail, cause }` at lines 735-741, so this matches the existing shape.
- The log is `logError` because a start timeout is a genuine blocking failure (per the logging rule:
  error = blocking, debug = expected). It is failure-only — healthy starts never hit it.
- Interrupting `acp.start()` resets its memo to `NotStarted` (`AcpSessionRuntime.ts:514-518`), and the
  `sessionScope` finalizer (`CliAdapter.ts:650-651`) closes on this failure → the child (spawned into
  `sessionScope`) is killed. No zombie.

---

## CHANGE 3 — `McpOverlay.ts`: `deleteOverlayFile` + `removeAllOverlays`

**File:** `apps/server/src/ru-fork/mcp/McpOverlay.ts`.

### 3a. Extend the service interface (lines 55-67)

#### Before
```ts
  readonly writeOverlay: (projectId: ProjectId) => Effect.Effect<OverlayResult, McpError>;
  /**
   * B4 ③: remove a deleted project's overlay directory (best-effort — a missing
   * dir is a no-op). Never fails (errors are swallowed), so callers need no recovery.
   */
  readonly removeOverlay: (projectId: ProjectId) => Effect.Effect<void>;
}
```
#### After
```ts
  readonly writeOverlay: (projectId: ProjectId) => Effect.Effect<OverlayResult, McpError>;
  /**
   * B4 ③: remove a deleted project's overlay directory (best-effort — a missing
   * dir is a no-op). Never fails (errors are swallowed), so callers need no recovery.
   */
  readonly removeOverlay: (projectId: ProjectId) => Effect.Effect<void>;
  /**
   * #4 ephemeral: delete a single resolved overlay FILE the moment the spawn it
   * fed has settled. The file holds plaintext secrets and is only needed until the
   * freshly-spawned child boots and reads it (qwen reads settings once at startup,
   * never re-reads). Best-effort — a missing file is a no-op; never fails, so it is
   * safe inside `Effect.ensuring`. `force` swallows ENOENT.
   */
  readonly deleteOverlayFile: (overlayPath: string) => Effect.Effect<void>;
  /**
   * #4 ephemeral: sweep EVERY project's overlay under `mcpOverlayDir`. Used on app
   * start to clear plaintext-secret files a hard crash (SIGKILL/power-loss) left
   * behind. Best-effort — a missing dir is a no-op; never fails. The dir is
   * recreated lazily by the next `writeOverlay` (atomic write makes its parents).
   */
  readonly removeAllOverlays: Effect.Effect<void>;
}
```

### 3b. Implement them (after `removeOverlay`, before the `return`, lines 243-245)

#### Before
```ts
    ).pipe(
      // ru-fork: best-effort cleanup — `force` makes a missing dir a no-op; a real failure is logged (the
      // dir holds resolved secrets) but must not fail the project.deleted chain.
      Effect.catchCause((cause) =>
        Effect.logDebug("mcp overlay: failed to remove project overlay", { projectId, cause }),
      ),
    );

  return { writeOverlay, removeOverlay } satisfies McpOverlayShape;
});
```
#### After
```ts
    ).pipe(
      // ru-fork: best-effort cleanup — `force` makes a missing dir a no-op; a real failure is logged (the
      // dir holds resolved secrets) but must not fail the project.deleted chain.
      Effect.catchCause((cause) =>
        Effect.logDebug("mcp overlay: failed to remove project overlay", { projectId, cause }),
      ),
    );

  const deleteOverlayFile: McpOverlayShape["deleteOverlayFile"] = (overlayPath) =>
    provideIo(fileSystem.remove(overlayPath, { force: true })).pipe(
      // ru-fork: best-effort — never fails (safe under Effect.ensuring). `force` makes a
      // missing file a no-op; a real failure is debug (non-blocking — sweep-on-start nets it).
      Effect.catchCause((cause) =>
        Effect.logDebug("mcp overlay: failed to delete ephemeral overlay file", {
          overlayPath,
          cause,
        }),
      ),
    );

  const removeAllOverlays: McpOverlayShape["removeAllOverlays"] = provideIo(
    fileSystem.remove(serverConfig.mcpOverlayDir, { recursive: true, force: true }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("mcp overlay: failed to sweep overlay dir", {
        dir: serverConfig.mcpOverlayDir,
        cause,
      }),
    ),
  );

  return {
    writeOverlay,
    removeOverlay,
    deleteOverlayFile,
    removeAllOverlays,
  } satisfies McpOverlayShape;
});
```

**Why a file-delete, not `removeOverlay(projectId)`:** the reactor holds `mcpOverlayResult.overlayPath`
directly; deleting the single `system.json` is the precise intent and leaves the (harmless, empty) project
dir, which the next atomic write reuses. Reusing `removeOverlay` would over-broadly nuke the dir and is
semantically "project deleted", not "turn settled".

---

## CHANGE 4 — `ProviderCommandReactor.ts`: `ensuring(delete)` around the spawn region

**File:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, in `ensureSessionForThread`.
`mcpOverlayResult` is computed at `:531`. The spawn-or-reuse decision is the block from
`const existingSessionThreadId = …` (`:594`) through the final `return startedSession.threadId` (`:669`).
We wrap that block in one `Effect.gen` and pipe `Effect.ensuring(deleteOverlayFile)` when an overlay was
written. `Effect.ensuring` runs on success, typed failure (incl. the new start-timeout), and interruption.

### Before (lines 594-670)
```ts
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      // ru-fork: runtimeModeChanged removed from restart triggers — the
      // adapter receives live runtimeMode on every sendTurn / respondToRequest
      // input (see ProviderSendTurnInput / ProviderRespondToRequestInput),
      // so dropdown changes no longer require a session restart. Restart still
      // fires for cwd / provider-instance / model changes.
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      // … (unchanged respawn-decision body) …
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });
```

### After
```ts
    // ru-fork #4: the spawn-decision region — respawn, reuse, or fresh spawn. The
    // overlay file (plaintext secrets) is only needed until a freshly-spawned child
    // boots and reads it; on a reuse turn nothing reads it at all. So the moment this
    // region settles — success, a (now timeout-bounded) start failure, or interrupt —
    // delete the file. The restart DECISION uses the in-memory fingerprint, never the
    // file, so deleting it can't trigger a spurious respawn next turn (test G1).
    const decideAndSpawn = Effect.gen(function* () {
      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        // ru-fork: runtimeModeChanged removed from restart triggers — the
        // adapter receives live runtimeMode on every sendTurn / respondToRequest
        // input (see ProviderSendTurnInput / ProviderRespondToRequestInput),
        // so dropdown changes no longer require a session restart. Restart still
        // fires for cwd / provider-instance / model changes.
        const cwdChanged = effectiveCwd !== activeSession?.cwd;
        // … (unchanged respawn-decision body, verbatim) …
        yield* bindSessionToThread(restartedSession);
        return restartedSession.threadId;
      }

      const startedSession = yield* startProviderSession(undefined);
      yield* bindSessionToThread(startedSession);
      return startedSession.threadId;
    });

    return yield* (
      mcpOverlayResult === null
        ? decideAndSpawn
        : decideAndSpawn.pipe(
            Effect.ensuring(mcpOverlay.deleteOverlayFile(mcpOverlayResult.overlayPath)),
          )
    );
  });
```

**Mechanical note:** the only change is wrapping the existing `:594-669` body verbatim into the
`decideAndSpawn` generator (indent +2) and adding the trailing `return yield* (… ensuring …)`. No logic
inside the block changes. `mcpOverlay` is already the bound service (it calls `mcpOverlay.writeOverlay` at
`:532`). `deleteOverlayFile` returns `Effect<void>` (never fails) so `ensuring` adds no error channel.

**Interaction with the existing best-effort writeOverlay catch (`:533-538`):** when `writeOverlay` fails,
`mcpOverlayResult` is `null` → we take the un-wrapped `decideAndSpawn` (nothing to delete). Unchanged.

---

## CHANGE 5 — sweep on app start

Two clean options; per the "code both where two exist" rule, both are specified. **Recommend Option A**
(explicit, follows the `runStartupPhase` pattern, ordered before anything writes an overlay).

### Option A (recommended) — a startup phase in `serverRuntimeStartup.ts`

#### 5A-i. Inject the service (add to imports + the `makeServerRuntimeStartup` header, lines 236-245)

Before (import block already has `McpReactor`, `McpSupervisor` from `./ru-fork/mcp/…`):
```ts
import { McpReactor } from "./ru-fork/mcp/McpReactor.ts";
import { McpSupervisor } from "./ru-fork/mcp/McpSupervisor.ts";
```
After:
```ts
import { McpOverlay } from "./ru-fork/mcp/McpOverlay.ts";
import { McpReactor } from "./ru-fork/mcp/McpReactor.ts";
import { McpSupervisor } from "./ru-fork/mcp/McpSupervisor.ts";
```

Before (`:241-242`):
```ts
  const mcpSupervisor = yield* McpSupervisor;
  const mcpReactor = yield* McpReactor;
```
After:
```ts
  const mcpSupervisor = yield* McpSupervisor;
  const mcpReactor = yield* McpReactor;
  const mcpOverlay = yield* McpOverlay;
```

#### 5A-ii. Add the phase BEFORE `reactors.start` (insert before `:284`)

Before:
```ts
    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
```
After:
```ts
    // ru-fork #4: wipe stale per-project overlay files (plaintext secrets) left by a
    // prior run that exited hard (SIGKILL / power-loss) before its ensuring/shutdown
    // sweep could run. Done before reactors so nothing reads a stale file. Best-effort.
    yield* Effect.logDebug("startup phase: sweeping stale MCP overlays");
    yield* runStartupPhase("mcp.overlay.sweep", mcpOverlay.removeAllOverlays);

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
```

`removeAllOverlays` never fails, so no `Effect.catch` wrapper is needed (unlike `keybindings.start`).

### Option B (alternative) — sweep at the head of `McpReactor.start()`

If you prefer to keep the sweep inside the MCP module and avoid a new injection into
`serverRuntimeStartup`: call `removeAllOverlays` as the first effect of `McpReactor.start()` (it already
runs at boot via `reactors.start`, `:294`). McpReactor would need `McpOverlay` as a dependency. Downside:
the sweep is then *inside* `reactors.start`, slightly less explicit and ordered with reactor seeding
rather than strictly before it. Functionally equivalent. **Not recommended** unless avoiding the startup
injection matters more than ordering clarity.

---

## CHANGE 6 — sweep on graceful shutdown (`fastShutdown.ts`)

Runs inside the **synchronous** SIGINT/SIGTERM handler (`server.ts` fast-exit, via `Effect.runSync`), so it
**must be sync** — use `nodeFs.rmSync`, mirroring the existing `nodeFs.unlinkSync` for the runtime-state
file. `config.mcpOverlayDir` is already on `ServerConfig` (used by `McpOverlay`).

### Before (whole `runFastShutdownCleanup`, lines 31-45)
```ts
export const runFastShutdownCleanup = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  yield* providerService.stopAll().pipe(Effect.ignoreCause({ log: true }));
  yield* terminalManager.killAll;
  yield* Effect.sync(() => {
    try {
      nodeFs.unlinkSync(config.serverRuntimeStatePath);
    } catch {
      // Already absent or another writer touched it — fine.
    }
  });
});
```
### After
```ts
export const runFastShutdownCleanup = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  yield* providerService.stopAll().pipe(Effect.ignoreCause({ log: true }));
  yield* terminalManager.killAll;
  yield* Effect.sync(() => {
    try {
      nodeFs.unlinkSync(config.serverRuntimeStatePath);
    } catch {
      // Already absent or another writer touched it — fine.
    }
  });
  // ru-fork #4: drop every per-project overlay (plaintext secrets) on graceful stop,
  // shrinking the on-disk window. SYNC (rmSync) because this runs in the SIGINT/SIGTERM
  // handler under Effect.runSync — an async FileSystem.remove would throw here.
  // Best-effort; the next start's sweep is the backstop for anything left.
  yield* Effect.sync(() => {
    try {
      nodeFs.rmSync(config.mcpOverlayDir, { recursive: true, force: true });
    } catch {
      // Missing or racing writer — fine; start-sweep nets it.
    }
  });
});
```

The doc comment at the top of `fastShutdown.ts` lists steps 1-3; update it to mention step 4 (overlay
sweep) for accuracy. (Cosmetic; no behaviour.)

---

## 2. Test matrix — what guarantees what

Legend for harnesses (all verified to exist):
- **RH** = reactor harness `apps/server/tests/orchestration/Layers/RuForkProviderCommandReactor.test.ts` —
  stubs `McpOverlay.writeOverlay` with per-project entries, **mock** `startSession`; asserts respawn
  decision via `startSession.mock.calls`. Best for APPLY-correctness + reactor `ensuring` wiring.
- **EH** = engine harness `apps/server/tests/provider/cliAdapterErrorEngine.test.ts` — **real** `CliAdapter`
  + `AcpSessionRuntime` over `fakeAcpSpawnerLayer(script)` + real OrchestrationEngine. Best for the inner
  start timeout + full chain.
- **Unit** = direct service test (real `McpOverlay` / `runFastShutdownCleanup` over a temp dir).

| ID | Guarantee | Harness | Assertion |
|---|---|---|---|
| **G1** | **Deletion ⊥ apply.** File deleted between turns ⇒ same config still takes the reuse path (NO spurious respawn). | RH | Stub `writeOverlay` creates a REAL temp file, fingerprint `v1`. Turn 1 spawns; `ensuring` deletes it. Turn 2 same config → `writeOverlay` recomputes `v1` → `startSession` called **once** total. Assert file absent after each turn. |
| **G2** | We restart **iff** the overlay meaningfully changed. | RH (exists, keep) | unchanged fp → no respawn; changed fp → respawn **with prior resumeCursor**; `writeOverlay` fail → spawn without overlay. |
| **G3** | Fingerprint is RIGHT — changes on config/varValue/toolPolicy/trust, stable on description/discovered-tools. | Unit (exists: `branch3OverlayGuards.test.ts`, `overlayFingerprint.test.ts`, keep) | sensitivity table. Guarantees G2's decision can't false-fire or miss. |
| **G4** | Delete on **success**. | RH | Stub `writeOverlay` → real temp file; mock `startSession` resolves. After turn: file **gone**. |
| **G5** | Delete on **spawn error**. | RH | Same; mock `startSession` **fails**. After the failed turn: file **gone** (`ensuring` fired on failure). |
| **G6** | Delete on **reuse** (no spawn). | RH | Turn 2 reuse path (unchanged fp): a real file was written this turn; assert **gone** even though `startSession` was not called again. |
| **G7** | **Inner CLI start timeout produces an error.** | EH | Extend fake to **hang** at `session/new`; build adapter with `sessionStartTimeoutMs: 50`. `adapter.startSession(...)` **fails** with `ProviderAdapterProcessError` (detail mentions "start handshake"). Proves a wedged boot settles instead of hanging. |
| **G8** | Start **error** (not hang) also settles. | EH | Fake `respondError` at `session/new` → `startSession` fails (mapped adapter error). |
| **G9** | **Full chain: start timeout → overlay deleted.** (capstone) | EH + real `McpOverlay` | Seed a catalog server + project binding (overlay non-empty), `MCP_ENGINE_USE_OVERLAY` on, `sessionStartTimeoutMs: 50`, fake hangs at `session/new`. Drive a turn through the REAL reactor. Assert: overlay file **created** (observe pre-timeout) then **absent** after the failed turn. Proves your exact ask. |
| **G10** | Sweep on **app start**. | Unit | Create `<dir>/p1/system.json`, `<dir>/p2/system.json`; run `mcpOverlay.removeAllOverlays`; assert dir empty/absent. |
| **G11** | Sweep on **shutdown**. | Unit | Create overlay files under `config.mcpOverlayDir`; run `runFastShutdownCleanup` (stub `ProviderService.stopAll`/`TerminalManager.killAll`); assert overlay dir gone. |
| **G12** | `deleteOverlayFile` is **safe on a missing file** (ensuring never throws). | Unit | Call on a non-existent path → succeeds (no error), via `{ force: true }`. |

### Harness work required (honest)

- **Fake-agent start-phase scripting (G7-G9).** Today `fakeAcpCore.ts` only scripts `onPrompt`; it always
  succeeds `initialize`/`session/new`/`session/load`. Add an optional `startBehavior?: "ok" | "hang" |
  "error"` to `FakeAcpScript` and branch in the `handleCreateSession`/`handleLoadSession` stubs:
  `"hang"` → never resolve (await a never-completing Deferred, like the prompt-hang at
  `fakeAcpCore.ts:166-169`); `"error"` → reply JSON-RPC error; default `"ok"` → current behaviour. This is
  **additive** — existing tests omit the field and are unchanged (no test edits, no blind spots).
- **G9** needs the EH layer to include `McpOverlayLive` + catalog/binding seeding + `MCP_ENGINE_USE_OVERLAY`
  on. EH already wires the real OrchestrationEngine + reactor; add the MCP layers and a 2-command seed
  (catalog add + binding set) reusing `branch3Helpers.ts` builders.

### What "100% guaranteed" means here — and the one honest caveat

- **APPLY correctness:** fully guaranteed by G1-G3. The restart decision is a pure in-memory fingerprint
  comparison over catalog+bindings; G3 proves the fingerprint is sensitive to exactly the right inputs, G2
  proves the decision wiring, and **G1 proves deletion cannot perturb it** (the file is never read to
  decide). So "we don't restart when not needed / apply wrong" is locked.
- **DELETION:** guaranteed on success (G4), error (G5), reuse (G6), start-timeout end-to-end (G7+G9),
  app-start (G10), app-shutdown (G11), and the no-throw property (G12).
- **Caveat (unchanged from the whole suite):** the **real qwen binary is faked**. EH exercises the REAL
  `CliAdapter` + `AcpSessionRuntime` + reactor + `McpOverlay` (so every line we add — timeout, error
  mapping, `ensuring`, sweep — is exercised for real); only the qwen process is simulated. The
  real-qwen overlay *shape/precedence* remains operator-verified via `mcp-probe`
  (`node ./mcp-probe/test.js → RESULT: GO`), exactly as today. No test here can or should boot real qwen.

---

## 3. Risk · cons · architecture-fit · testability

- **Risk — early delete starves a later spawn?** No. Each turn-start writes a fresh overlay *before* any
  possible respawn (`writeOverlay` at `:531` is unconditional; respawn is downstream in the same effect).
  A future restart always gets a freshly-written file. Deleting this turn's file after its spawn settles
  can't affect a future turn.
- **Risk — delete races the child's read?** No. We delete only after `startProviderSession` **settles**; a
  successful `initialize` proves the read already happened (qwen reads once at boot). On failure the child
  is being killed anyway. Defense-in-depth: deleting *before* the turn streams also shrinks the
  plaintext-on-disk window.
- **Risk — the new start timeout false-fires on a slow cold boot?** 60s is ~6× the typical <10s qwen
  init; tunable via the const. It only fires on a genuine wedge, and the failure is the *correct* outcome
  (today such a wedge hangs the turn forever — this is a net robustness fix beyond MCP).
- **Cons:** Change 4 indents the spawn-decision block into a named generator (mechanical, no logic change).
  Change 5 adds one service injection. Change 6 adds a sync `rmSync` (consistent with the existing one).
- **Architecture fit:** deletion lives in the layer that **wrote** the file (the reactor owns
  `overlayPath`); `CliAdapter` stays MCP-agnostic (the timeout is generic provider robustness, not MCP).
  `McpOverlay` remains the single owner of the overlay-file lifecycle (write/remove/delete/sweep). The
  start timeout uses the repo's established `Effect.timeoutOrElse` idiom and the central `config.ts`
  timeout block.
- **Testability:** the start timeout is injectable (`sessionStartTimeoutMs`) so tests trip it in ms;
  deletion is observable as real files in the reactor + engine harnesses; sweeps are plain unit tests.

---

## 4. Implementation order (when go is given)

1. Change 1 (const) → Change 2 (timeout) → typecheck.
2. Change 3 (overlay methods) → Change 4 (reactor ensuring) → typecheck.
3. Change 5 (start sweep) → Change 6 (shutdown sweep) → typecheck.
4. Fake-agent `startBehavior` extension (additive).
5. Tests G1-G12. Run `test:fast`, server/web/contracts `typecheck`, `oxlint`.
6. Operator runs `mcp-probe` (real-qwen shape unchanged → still `RESULT: GO`).

**Constraints (standing):** no `as`/`any`/`unknown`; `Effect.catch`/`catchCause`; `logError` (blocking) /
`logDebug` (expected) only; mark `ru-fork:` deltas; no test deletions (fake extension is additive); MCP
never shipped → no backcompat; web = typecheck+lint only; never run qwen/the project; report any
UNEXPECTED degradation and STOP rather than cut corners.
