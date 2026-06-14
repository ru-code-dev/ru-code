# MCP — improvements branch 3 (analysis + validated plan)

## ✅ IMPLEMENTATION STATUS (2026-06-14 — updated)

**Done + verified this round** (gates: server/web/contracts typecheck 0 · oxlint 0/0 · build ✔ ·
`test:fast` = only the 4 `bin.test.ts` env-baseline failures, **886 passed**):
- **#1** backfill ordering — back-fill moved after `probeHashes` in `processSignal`.
- **#2** config-uniqueness — `configIdentity` (mcp-core) + `requireCatalogConfigUnique` invariant on
  `server-add`/config-`server-update`; built-in **skip-on-collision** in `reconcileBuiltinsWith`.
- **#4 (encryption half)** — `apps/server/src/auth/secretCrypto.ts` (scrypt + AES-256-GCM, qwen's
  scheme) wrapping `ServerSecretStore` get/set/create. **Ephemeral-overlay half = NOT done** (next).
- **#5** UI errors — readable toasts (`readableMcpError` strips the `Orchestration command invariant
  failed (…)` wrapper); add/edit blocked (dialog stays open), all errors → notification.
- **#6** trust — full chain: contract `trust` field (default true) + DB column + projection +
  3 builders + `buildServerEntry` emits qwen's `trust` + `overlayFingerprint` includes it + UI
  («Доверять серверу» wired; removed dead «Включить все инструменты»).
- **#8** var validation — reject undeclared `${VAR}` + unknown binding var-key.
- **#9** missing-secret — excluded from `computeDesired` + overlay (no blank-credential launch).
- **#10** 64-bit hash — `fnv1a` widened (16 hex).
- **Server-side error logging** — `OrchestrationEngine` logs rejected commands: `logDebug` for
  invariant (expected user rejection), `logError` for genuine failure — full details in the terminal.
- **Tests** — failing tests written first then made green; 4 canary tests fixed honestly (distinct
  configs / adjusted premise, none removed); new coverage for trust + readable errors. Suite under
  `apps/server/tests/ru-fork/mcp/branch3*.ts` (+ helper `branch3Helpers.ts`) and the
  `mcp-probe` D6/D7 cases (operator-run, GO).

**Remaining (next session — see HANDOFF.md):**
- **#4 ephemeral overlay** — delete the plaintext overlay file after the session establishes. **It IS
  testable** (I was wrong earlier): the harness is `tests/provider/fakeAcpSpawner.ts` +
  `fakeAcpCore.ts` (runs the REAL `CliAdapter`+`AcpSessionRuntime` over a scripted in-memory agent;
  example: `tests/provider/cliAdapterErrorEngine.test.ts`). **Proven safe** by qwen-source analysis:
  qwen reads the system settings file **once** at startup, never re-reads, never writes the System
  scope, and stores MCP OAuth tokens in a SEPARATE encrypted file — so deleting after
  `sessionSetupResult` (load-or-new ⇒ covers resume) is safe. Needs a fallback for a spawn that never
  establishes.
- **#11 watchedProjects** — per-connection sets + union (deferred to last).

---

**Status:** the original plan below is the agreed-shape proposal; the STATUS block above is the
current truth. The flow was: (1) agree on this report → (2) write the FAILING tests → (3) touch the
codebase. Every code block below is verbatim before→after against the working tree at plan time.

**Standing constraints** (enforced): no `as`/`any`/`unknown` casts; `Effect.catch`/`catchCause`
not `catchAll`; only `logError`/`logDebug`; mark ru-fork deltas with `ru-fork:`; web has no
test target (typecheck+lint only); never run qwen/the project (hand a runnable artifact);
plan-before-editing. The 4 `bin.test.ts` failures are the env baseline.

Severity legend: 🔴 correctness/security · 🟠 robustness · 🟡 UX/operational.

---

## Index

| # | Item | Sev | Lands cleanly? | Testable before impl? |
|---|---|---|---|---|
| 1 | Backfill ordering (empty description/docs) | 🟠 | Yes — 2-line reorder | Yes (reactor harness) |
| 2 | Config-uniqueness invariant + built-in skip | 🔴 | Yes — new invariant + reactor guard | Yes (decider + reactor harness) |
| 3 | qwen overlay verification | 🔴 | **Proven:** 0.13.1 response carries no MCP info → runbook + probe, not in-product | Probe = manual |
| 4 | Encrypt secrets at rest + ephemeral overlay | 🔴 | Yes — encrypt `.bin`; overlay written→spawn→deleted (verified safe) | Yes (round-trip + lifecycle test) |
| 5 | Surface UI errors (modal vs toast) | 🟠 | Yes — reuses toast + modal error block | Web = typecheck/lint only |
| 6 | Wire trust, remove «enable all», no autobind | 🟡 | Yes — `trust` overlay field (folder already trusted, full-access locked ⇒ only lever); remove 1 checkbox | Server unit (fingerprint+overlay) |
| 7 | Non-transactional secret write | 🟠 | Use existing GC (Option A proven **unsafe**) | Yes (fault-injection) |
| 8 | varValues / `${VAR}` ↔ declared-vars validation | 🟠 | Yes — decider guard | Yes (decider harness) |
| 9 | Missing secret → incomplete | 🟠 | Yes — exact server-side exclusion (UI surface = follow-on) | Yes (secrets+computeDesired unit) |
| 10 | 32-bit hash collision risk | 🟡 | Yes — widen fnv to 64-bit | Yes (hash unit) |
| 11 | Cross-client `watchedProjects` clobber | 🟠 | Yes — per-connection map + union (key choice noted) | Yes (supervisor unit) |

---

## 1. Backfill ordering — the empty description/docs bug 🟠

### Mechanism (confirmed)
`backfillServerMetadataEffect` runs **inside** `reconcileNow` (`McpReactor.ts:497`), which
executes **before** the probe (`processSignal` → `supervisor.probeHashes(added)`,
`McpReactor.ts:551`). On a fresh add the probe cache has no `serverDescription` yet, so the
catalog field is never filled that session. After a restart the initial reconcile reads the
prior session's already-probed cache → it fills. That's why "after restart it works."
`probeHashes` (`McpSupervisor.ts:442-451`) **awaits** every probe + its `probeCache.upsert`,
so a backfill placed *after* it is race-free.

### Options
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Move backfill after the probe** (recommended) | One pass, no new mechanics; converges; description not in overlay fingerprint ⇒ no respawn | none material | Clean — same scope, same fn |
| B. Second backfill pass after probe, keep the first | Covers a future caller that backfills without probing | Two passes per reconcile; redundant | Clean but wasteful |
| C. Re-trigger reconcile when a probe completes | "Event-driven" | Probe completion isn't a domain event; would need a new signal + risk of probe→reconcile loops | Needs new plumbing |

**Decision: A.**

### Testability — YES (red before fix)
Reactor harness `reconciliationLifecycle.test.ts` already has `system.backfill()` and
`system.probeUpsert()`. A new end-to-end test must drive the **real** `processSignal` order
(add → eager reconcile → probe) and assert description filled in that one cycle. The cleanest
red test seeds the cache to model "probe wrote it" and asserts the *post-probe* backfill runs;
but to truly prove ordering we add a test that runs the worker path. See §Tests.

### Exact change — `apps/server/src/ru-fork/mcp/McpReactor.ts`

**Before** (`reconcileNow`, lines 479–498):
```ts
  const reconcileNow: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
    const desired = yield* computeDesired;
    const added = yield* supervisor.reconcile(desired);
    // GC: drop persisted cache rows whose authored config no longer exists in the
    // live desired set (catalog default removed / override changed or dropped).
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    // Never run a "delete-all" on an empty desired set (a transient all-incomplete state must not wipe
    // the cache); orphan rows are tiny and the next non-empty reconcile cleans them.
    if (liveConfigKeys.size > 0) {
      yield* probeCache
        .deleteKeysNotIn([...liveConfigKeys])
        .pipe(
          Effect.catch((error) =>
            Effect.logError("mcp reactor failed to GC probe cache", { error }),
          ),
        );
    }
    yield* gcOrphanedSecrets; // item 10 — prune secret .bin files no longer referenced
    yield* backfillServerMetadata; // B3 ② — fill empty description/websiteUrl from the probe
    return added;
  }).pipe(
```

**After** (remove the backfill line from `reconcileNow`):
```ts
  const reconcileNow: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
    const desired = yield* computeDesired;
    const added = yield* supervisor.reconcile(desired);
    // GC: drop persisted cache rows whose authored config no longer exists in the
    // live desired set (catalog default removed / override changed or dropped).
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    // Never run a "delete-all" on an empty desired set (a transient all-incomplete state must not wipe
    // the cache); orphan rows are tiny and the next non-empty reconcile cleans them.
    if (liveConfigKeys.size > 0) {
      yield* probeCache
        .deleteKeysNotIn([...liveConfigKeys])
        .pipe(
          Effect.catch((error) =>
            Effect.logError("mcp reactor failed to GC probe cache", { error }),
          ),
        );
    }
    yield* gcOrphanedSecrets; // item 10 — prune secret .bin files no longer referenced
    return added;
  }).pipe(
```

**Before** (`processSignal`, lines 540–553):
```ts
  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eager = signal.kind === "project-created" ? true : signal.eager;
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* pruneOrphanedVarValues; // item 11 — drop stranded var values (ref-preserving)
      const added = yield* reconcileNow;
      if (eager) {
        // A config-affecting change (or new project) just landed — probe the newly-appeared
        // instances NOW instead of waiting for the sweep (item 3). Cosmetic edits add nothing.
        yield* supervisor.probeHashes(added);
      }
    });
```

**After** (run the backfill *after* the probe — sees fresh metadata):
```ts
  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eager = signal.kind === "project-created" ? true : signal.eager;
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* pruneOrphanedVarValues; // item 11 — drop stranded var values (ref-preserving)
      const added = yield* reconcileNow;
      if (eager) {
        // A config-affecting change (or new project) just landed — probe the newly-appeared
        // instances NOW instead of waiting for the sweep (item 3). Cosmetic edits add nothing.
        yield* supervisor.probeHashes(added);
      }
      // ru-fork: B3 ② — back-fill catalog description/websiteUrl from the probe cache. MUST run
      // AFTER probeHashes: a fresh add has no cache row until the eager probe writes it, so an
      // earlier pass (inside reconcileNow) saw nothing. Idempotent + converges (the empty-only
      // guard makes repeat passes no-ops); description is not in the overlay fingerprint, so this
      // never respawns a session. On the non-eager startup path it reads the prior-session cache.
      yield* backfillServerMetadata;
    });
```

Also correct the now-stale comment at `McpReactor.ts:469-472` (it claims a "deterministic,
field-scoped commandId / replay-idempotent" — untrue since `mkReconcileCommandId` mints a fresh
uuid; and the pass now runs post-probe):

**Before** (469–472):
```ts
  // B3 ②: back-fill catalog `description`/`websiteUrl` from a server's first successful probe — but
  // ONLY when the catalog field is empty (a shipped/user value always wins). Reads the server's
  // default-config cache row and dispatches a metadata-only `mcp.server-update`. Replay-idempotent
  // (deterministic, field-scoped commandId); converges (once filled, the next pass produces no patch).
```
**After:**
```ts
  // B3 ②: back-fill catalog `description`/`websiteUrl` from a server's first successful probe — but
  // ONLY when the catalog field is empty (a shipped/user value always wins). Reads the server's
  // default-config cache row and dispatches a metadata-only `mcp.server-update`. Invoked from
  // processSignal AFTER the eager probe so the cache row exists; converges (the empty-only guard
  // makes the next pass a no-op). commandId is a fresh per-dispatch uuid (mkReconcileCommandId).
```

---

## 2. Config-uniqueness invariant + built-in skip-on-collision 🔴

### Mechanism (confirmed)
The catalog keys identity by opaque `serverId` only (PK in `Migrations/031_Mcp.ts`; no UNIQUE
on name/config). The runtime collapses identical configs into one (`configCacheKey`/`dedupHash`).
So two catalog rows with the same config are allowed but produce: a shared probe row, duplicate
qwen `mcpServers` entries (overlay keys by `serverId` — `McpOverlay.ts:174`), and confusing shared
status. `mcp.builtin-sync` (`decider.ts:804-805`) keys only by `serverId`, so a shipped built-in
can silently duplicate a colliding custom server. **Tier-1 #5 is this same root cause.**

### Identity definition — structural, secret-independent
We do NOT reuse `configCacheKey` (it includes per-server secret refs → two credentialed servers
never collide → useless for real MCPs). We add a pure **`configIdentity`** over
`{transport, command, args, httpUrl, headers-keys+template, extraArgs, extraHeaders, var NAMES}`
— value- and secret-independent. Server-authoritative (computed in the decider), so the secret
plaintext-vs-ref mismatch is moot. (Per-project AUTH secrets live on **bindings**, keyed by the
unchanged value-inclusive `configCacheKey` — fully distinguished; this invariant never touches them.)

### Options — enforcement model
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Decider invariant + dialog stays open on reject** (recommended) | Single authority; can't be bypassed; no client hashing ⇒ no secret/drift issue; atomic (no event on reject) | Needs UI error surface (item 5) to be visible | Clean — mirrors `requireCatalogServerAbsent` |
| B. Disable Save button via client-side hash | Instant feedback | Browser can't see secret refs → wrong for credentialed servers; duplicates the hash (drift) | Smell — re-mirrors mcp-core like `adapters.ts:103` |
| C. De-dup at the overlay only | No user rejection | Leaves shared-probe confusion + ambiguous policy-union; doesn't fix builtin path | Hot-path complexity |

**Decision: A** (the UI just renders the decider's error — item 5).

### Options — built-in collision
| Option | Pros | Cons | Arch fit |
|---|---|---|---|
| **A. Reactor skips a built-in whose config collides with another server, on add AND update** (recommended) | Non-destructive; self-heals; same mechanism both paths | A built-in may stay on its last good config until the user resolves the clash | Clean — fits `reconcileBuiltinsWith` diffing |
| B. Adopt the custom server as the built-in (stamp builtinId) | No frozen built-in | Mutates/renames/locks the user's server — surprising | Risky |
| C. Do nothing (accept the gap) | Zero work | Duplicate built-in on collision | — |

**Decision: A**, applied on both the add and update branches, with a `logDebug` notice.

### Testability — YES (red before fix)
- Decider: add A (X) ok; add B (X, different name) → `rejects.toThrow()`; edit to collide → throw;
  edit own non-config field → ok. Harness = `reconciliationLifecycle.test.ts` "decider guards" block.
- Reactor: custom X exists; ship built-in X → assert built-in **not** added (catalog has no
  `builtinId` row for it). Harness = `system.reconcile([def])` + `system.catalog()`.

### Exact code

**2a. New pure identity — `packages/mcp-core/src/resolver.ts`** (append after `configCacheKey`, before `canonicalize`, ~line 187):
```ts
/**
 * ru-fork: CATALOG-level uniqueness identity. Structural + secret/value-INDEPENDENT: two catalog
 * templates collide iff they target the same transport endpoint with the same arg/header SHAPE and
 * the same declared var NAMES — regardless of credentials or per-project values. Distinct from
 * `configCacheKey` (which includes values/refs and is the per-binding probe-cache key). Used only by
 * the `requireCatalogConfigUnique` decider invariant; never participates in resolution or probing.
 */
export function configIdentity(
  config: McpServerConfig,
  // Loose `{ name }` shape on purpose: callers pass either a catalog `McpServerVar[]` (server-update,
  // built-in skip) or a draft `McpServerVarDraft[]` (server-add). Both carry `.name`; we read nothing
  // else, so this avoids a type mismatch without a cast.
  vars: ReadonlyArray<{ readonly name: string }>,
  extraArgs: ReadonlyArray<string>,
  extraHeaders: Readonly<Record<string, string>>,
): string {
  const varNames = vars.map((declared) => declared.name).toSorted();
  return fnv1a(JSON.stringify(canonicalize({ config, varNames, extraArgs, extraHeaders })));
}
```
(`McpServerConfig` is already imported in resolver.ts. `config` for stdio holds
`{transport, command, args}` and for http `{transport, httpUrl, headers}` — the headers VALUES are
`${VAR}` templates, not resolved secrets, so they're safe to include and they correctly distinguish
two different remote endpoints. Note: if item 10 widens `fnv1a` to 64-bit, this inherits it for free.)

> **Package export:** verified `packages/mcp-core/src/index.ts` is `export * from "./resolver.ts"`
> — so `configIdentity` (and item 8's `configPlaceholders`) are exported automatically once added to
> resolver.ts. **No index change needed.**

**2b. New invariant — `apps/server/src/ru-fork/mcp/McpInvariants.ts`** (append; add the import):
```ts
import { configIdentity } from "@ru-fork/mcp-core";
```
```ts
/**
 * ru-fork: reject a catalog write whose structural config identity already exists on ANOTHER server
 * (custom or built-in). `excludeServerId` is the server being edited (so a non-config edit never
 * collides with itself). Scans the whole catalog so a custom add that matches a shipped built-in is
 * told to bind the built-in instead.
 */
export function requireCatalogConfigUnique(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly identity: string;
  readonly excludeServerId: McpServerId | null;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const clash = input.readModel.mcpCatalog.find(
    (server) =>
      server.id !== input.excludeServerId &&
      configIdentity(server.config, server.vars, server.extraArgs, server.extraHeaders) ===
        input.identity,
  );
  if (!clash) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail:
        `Сервер с такой конфигурацией уже существует: «${clash.name}». ` +
        `Привяжите его к проекту или измените команду/URL, аргументы или заголовки.`,
    }),
  );
}
```
(`configIdentity` needs the server's `extraArgs`/`extraHeaders`, which `McpCatalogServer` always
carries via `withDecodingDefault`. The new draft on add has them too — see 2c.)

**Decider imports (required for 2c/2d/8b/8c):** add to `decider.ts`'s existing
`./ru-fork/mcp/McpInvariants.ts` import → `requireCatalogConfigUnique`; and add a
`@ru-fork/mcp-core` import → `configIdentity` (item 2) and `configPlaceholders` (item 8). The
decider already imports `requireCatalogServer*` from `McpInvariants` and resolver symbols from
mcp-core, so these slot into the existing import lines.

**2c. Wire into `mcp.server-add` — `apps/server/src/orchestration/decider.ts:761-774`.**
Before:
```ts
    case "mcp.server-add": {
      yield* requireCatalogServerAbsent({ readModel, command, serverId: command.serverId });
      const vars = yield* splitServerVars(command.serverId, command.draft.vars, []);
```
After:
```ts
    case "mcp.server-add": {
      yield* requireCatalogServerAbsent({ readModel, command, serverId: command.serverId });
      // ru-fork: config-uniqueness — a server's identity is its config, not its name. Reject a
      // duplicate of any existing catalog server (incl. built-ins) BEFORE writing secrets.
      yield* requireCatalogConfigUnique({
        readModel,
        command,
        identity: configIdentity(
          command.draft.config,
          command.draft.vars,
          command.draft.extraArgs ?? [],
          command.draft.extraHeaders ?? {},
        ),
        excludeServerId: null,
      });
      const vars = yield* splitServerVars(command.serverId, command.draft.vars, []);
```
NOTE the ordering: the uniqueness check runs **before** `splitServerVars` (which writes secrets) —
so a rejected duplicate never orphans a secret (ties into item 7). `command.draft.vars` is the
draft `McpServerVarDraft[]`; `configIdentity` only reads `.name`, which drafts carry. `extraArgs`/
`extraHeaders` on `McpServerDraft` are optional → default to `[]`/`{}` (matches `buildAddedServer`).

**2d. Wire into `mcp.server-update` — `decider.ts:776-789`.** Compute the *resulting* config/vars
and check only when config-affecting fields change. Before:
```ts
    case "mcp.server-update": {
      const existing = yield* requireCatalogServer({ readModel, command, serverId: command.serverId });
      const occurredAt = yield* nowIso;
      // Identity lock: a template's command and shipped var declarations are read-only. A patch that
      // would change the command is rejected; configuring (extraArgs, var values, user vars) is allowed.
      if (existing.locked && command.patch.config !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `MCP server '${command.serverId}' is a locked template; its command cannot be edited.`,
        });
      }
      const vars = command.patch.vars
        ? yield* mergeTemplateVars(command.serverId, existing, command.patch.vars)
        : existing.vars;
```
After (insert the uniqueness check after the lock check, before `mergeTemplateVars` writes secrets):
```ts
    case "mcp.server-update": {
      const existing = yield* requireCatalogServer({ readModel, command, serverId: command.serverId });
      const occurredAt = yield* nowIso;
      // Identity lock: a template's command and shipped var declarations are read-only. A patch that
      // would change the command is rejected; configuring (extraArgs, var values, user vars) is allowed.
      if (existing.locked && command.patch.config !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `MCP server '${command.serverId}' is a locked template; its command cannot be edited.`,
        });
      }
      // ru-fork: config-uniqueness on edit — only when a config-affecting field changes. Compute the
      // RESULTING identity and reject if it collides with a DIFFERENT server (exclude self).
      if (
        command.patch.config !== undefined ||
        command.patch.vars !== undefined ||
        command.patch.extraArgs !== undefined ||
        command.patch.extraHeaders !== undefined
      ) {
        yield* requireCatalogConfigUnique({
          readModel,
          command,
          identity: configIdentity(
            command.patch.config ?? existing.config,
            command.patch.vars ?? existing.vars,
            command.patch.extraArgs ?? existing.extraArgs,
            command.patch.extraHeaders ?? existing.extraHeaders,
          ),
          excludeServerId: command.serverId,
        });
      }
      const vars = command.patch.vars
        ? yield* mergeTemplateVars(command.serverId, existing, command.patch.vars)
        : existing.vars;
```
(`command.patch.vars` is `McpServerVarDraft[] | undefined`; `existing.vars` is `McpServerVar[]`.
`configIdentity` reads only `.name`, present on both — type-compatible. `mcp.builtin-sync` does NOT
go through this branch, so built-ins are governed solely by the reactor skip in 2e.)

**2e. Built-in skip — `apps/server/src/ru-fork/mcp/McpReactor.ts` `reconcileBuiltinsWith` (97-172).**
Add a collision check before the dispatch. Before (the per-definition loop body, ~115-122):
```ts
      shippedBuiltinIds.add(definition.builtinId);
      const serverId = builtinServerId(definition.builtinId);
      const hash = builtinHash(config, definition);
      const installed = installedByBuiltinId.get(definition.builtinId);
      if (installed && installed.builtinHash === hash) {
        continue; // up to date
      }
      yield* engine
        .dispatch({
          type: "mcp.builtin-sync",
```
After:
```ts
      shippedBuiltinIds.add(definition.builtinId);
      const serverId = builtinServerId(definition.builtinId);
      const hash = builtinHash(config, definition);
      const installed = installedByBuiltinId.get(definition.builtinId);
      if (installed && installed.builtinHash === hash) {
        continue; // up to date
      }
      // ru-fork: skip-on-collision — never duplicate/clobber a DIFFERENT server that already has this
      // config (e.g. a user hand-added the same command). Checked on add AND update; the built-in
      // stays on its last good config and self-heals once the conflicting server is gone.
      const shippedIdentity = configIdentity(config, builtinShippedVars(definition), [], {});
      const collision = catalog.find(
        (server) =>
          server.id !== McpServerId.make(serverId) &&
          configIdentity(server.config, server.vars, server.extraArgs, server.extraHeaders) ===
            shippedIdentity,
      );
      if (collision) {
        yield* Effect.logDebug("mcp reactor: built-in skipped (config conflicts with existing server)", {
          builtinId: definition.builtinId,
          conflictsWith: collision.id,
        });
        continue;
      }
      yield* engine
        .dispatch({
          type: "mcp.builtin-sync",
```
Add the import at the top of `McpReactor.ts`:
```ts
import { configIdentity } from "@ru-fork/mcp-core";
```
(Built-ins ship no `extraArgs`/`extraHeaders` — they're authored-empty — so `[]`/`{}` match what
`buildSyncedBuiltin` stores. `builtinShippedVars(definition)` is already imported/used here.)

> **Caveat to log (no-silent-caps):** the skip means a future built-in *update* won't land while a
> conflicting custom server exists. The `logDebug` above records it; item 5's notice can surface it
> to the user later. Acceptable and non-destructive.

---

## 3. qwen overlay verification 🔴 — the biggest gap

### Mechanism (confirmed)
The overlay reaches qwen out-of-band (`QWEN_CODE_SYSTEM_SETTINGS_PATH` +
`--allowed-mcp-server-names`); the ACP `session/new` response carries qwen's actually-loaded
servers/tools but is **never inspected** (`AcpSessionRuntime.ts:463-489`). If qwen ignores the
overlay (wrong path, schema drift, version mismatch), the server can't tell.

**`mcp-probe` (`mcp-probe/test.js`) already verifies a LOT against real qwen:** it writes the
overlay, spawns `qwen --acp`, drives `session/new`, and inspects **two oracles** — qwen's own
`ToolRegistry created: [...]` log and each fake server's START/LIST/CALL audit log — to assert the
expected `mcp__server__tool` set registered (cases D1–D*, allowlist, per-tool, http, env, trust).
What it does **not** do: inspect the ACP `session/new` **response** (`sessionSetupResult`), and it
doesn't exercise our production `AcpSessionRuntime` path. So it proves *qwen honors an overlay*, not
that *our running server confirms qwen honored this overlay*.

### DECISIVE FINDING (verified in qwen-code 0.13.1)
qwen's `newSession` handler (`packages/cli/src/acp-integration/acpAgent.ts:196-215`) returns **only**:
```ts
return { sessionId: session.getId(), models: availableModels, modes: modesData, configOptions };
```
Our `NewSessionResponse` type (`packages/effect-acp/src/_generated/schema.gen.ts:7262-7306`) matches:
`{ _meta?, configOptions?, models?, modes?, sessionId }`. **There is NO `mcpServers` / loaded-tools /
per-server-status field in the `session/new` response.** qwen discovers MCP servers during
`Config.initialize()` but never reports the result back over ACP (the only post-session push is
`available_commands_update` — slash commands, not MCP servers; `Session.ts:379-407`). And
`AcpSessionRuntime` doesn't even receive the overlay's server names (they're consumed by the spawn
env in `CliAcpSupport.ts`, not passed into the runtime). **So "inspect `sessionSetupResult` and
compare" is impossible in 0.13.1 — the data isn't on the wire.** This is proven, not assumed.

### Options (re-evaluated against that fact)
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Manual `check-mcp-feature.md` runbook + additive probe assertions** (recommended now) | The probe already reads qwen's real registry log + server audit logs — the only oracle that exists in 0.13.1; zero product risk | Manual, not CI | Doc + probe only |
| B. Runtime parse of qwen's debug registry log from our spawned process | Closes it in-product without a qwen change | **Fragile** — depends on the `ToolRegistry created:` debug line + `QWEN_RUNTIME_DIR` + log timing; breaks on any qwen logging change; needs us to enable + locate qwen's debug log per session | Hacky — string-scraping a debug log in the hot path |
| C. Upstream qwen: add loaded-MCP status to the `session/new` `_meta`, then inspect it | The clean, durable fix; CI-able | Requires a qwen-code change + version pin; out of our repo | Right long-term; external |

**Decision: A now.** B is written below so it's not an assumption — but I recommend **against**
shipping it (fragility > value); C is the real fix, filed as upstream follow-up.

### 3a. Runbook — created: `mcp-specs/current/check-mcp-feature.md`.

### 3b. Additive probe assertions (proposal; you approve + run)
The probe ALREADY inspects qwen's registry log + audit logs — that's the working oracle. Additions:
- A **negative case**: overlay allow-lists a server-name with no matching server → assert qwen's
  registry contains none of its `mcp__name__*` tools (proves the probe detects a non-load).
- An explicit **two-project isolation case**: two overlays, two sessions → assert each registry set
  is disjoint. These extend the existing GO/NO-GO contract; additive, low-risk. **You run it.**

### 3c. Option B, written out (NOT recommended — fragility documented)
If we wanted in-product detection without a qwen change, the only signal is qwen's runtime debug log
(the same `ToolRegistry created: [...]` line `mcp-probe/monitor`/`test.js` parses). It would require:
spawning qwen with its debug log enabled + a known `QWEN_RUNTIME_DIR`, then in `AcpSessionRuntime`
after `created` (`AcpSessionRuntime.ts:~463`), read that log, parse the `mcp__server__*` tool names,
and `logError` when the set differs from the overlay's `allowedServerNames`. **Two blockers make this
unfit for production:** (1) `AcpSessionRuntime` doesn't currently receive `allowedServerNames` (it'd
need threading from `CliAcpSupport`/`ProviderCommandReactor` where the overlay is built); (2) it
scrapes an undocumented debug log with race-prone timing. **Recommendation: do not implement B.**
Keep verification at the probe (A); pursue C upstream. This is the honest, evidence-backed call — the
"inspect the response" idea cannot work because qwen 0.13.1 does not send the data.

### 3d. Overlay CONFORMANCE — verified from qwen source (this part IS knowable, and it's good)
What we *can* prove statically (and did): **our overlay can never be silently rejected.** Verified in
qwen 0.13.1:
- **Schema match:** qwen's `mcpServers[name]` accepts `{command, args, env, cwd, url, httpUrl,
  headers, tcp, timeout, trust, description, includeTools, excludeTools, …}` — all optional
  (`sdk-typescript/src/types/protocol.ts:287-306`). Every key our `buildServerEntry` writes is valid.
- **Lenient parser:** unknown keys are logged to debug and **ignored, never rejected**
  (`settings.ts:191-250`).
- **Precedence:** `QWEN_CODE_SYSTEM_SETTINGS_PATH` is the **highest-precedence** layer; `mcpServers`
  uses `SHALLOW_MERGE` — our overlay wins per-server (`settings.ts:289-312`).
- **Read timing:** settings load at process startup, fresh from disk **every** `qwen --acp` spawn; no
  hot-reload. **`--allowed-mcp-server-names`** overrides settings' allow/exclude entirely
  (`config.ts:366-375, 941-953`).

**Deliverable: a small overlay-conformance unit test** asserting our generated overlay only uses keys
in qwen's `MCPServerConfig` shape — so a future `buildServerEntry` change can't drift out of qwen's
schema unnoticed. That's the durable, testable half of #3; the probe covers the runtime "did it load".

---

## 4. Encrypt secrets at rest 🔴

### Mechanism (confirmed)
Two plaintext locations: (a) `ServerSecretStore` `.bin` files under `${stateDir}/secrets/`; (b) the
resolved qwen overlay `${stateDir}/mcp/overlays/<projectId>/system.json`. Both are `0o600`/`0o700`,
no encryption.

**qwen-code 0.13.1 scheme (to mirror), `file-token-storage.ts:25-63`:**
`scryptSync('qwen-code-oauth', \`${hostname}-${username}-qwen-code\`, 32)` → `aes-256-gcm`,
random 16-byte IV per write, format `ivHex:authTagHex:cipherHex`. (qwen also tries OS keychain via
optional `keytar`; the file scheme is its headless fallback — that's the one we mirror, since our
server is headless.)

### The overlay constraint (decisive)
qwen reads `system.json` as **plaintext JSON** via `QWEN_CODE_SYSTEM_SETTINGS_PATH`
(`CliAcpSupport.ts:79-82`). We cannot encrypt it without modifying qwen. → **The only correct
hardening for the overlay is the existing FS perms + a documented `stateDir` exclusion from
backups/cloud-sync.** We encrypt the `.bin` store; we document the overlay as defense-by-perms.

### Options — the `.bin` store
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Wrap encrypt/decrypt in `ServerSecretStore` set/create/get, scrypt+AES-GCM keyed by host+user** (recommended) | Mirrors qwen; transparent to callers; round-trippable; authenticated (tamper-evident) | Key is derivable on the same host/user (matches qwen's own threat model — protects against off-host copy, not a local attacker) | Clean — one Layer, no interface change |
| B. OS keychain via `keytar` | Strongest on desktop | Optional native dep; broken headless (our server) → needs the file fallback anyway | Heavy; new dep |
| C. Leave plaintext, perms only | Zero work | Plaintext at rest | — |

**Decision: A** (same algorithm + key derivation as qwen, so behavior/threat-model parity).

### Testability — YES
Pure round-trip unit: `encrypt(decrypt(x)) === x`; tamper a byte → `decrypt` throws; a value
written by the new code is unreadable as UTF-8 plaintext. Plus a store-level test: `set` then `get`
returns the same bytes; an on-disk file does not contain the plaintext substring.

### Exact code

**4a. New helper — `apps/server/src/auth/secretCrypto.ts`** (new file; pure, no Effect):
```ts
// ru-fork: at-rest encryption for the ServerSecretStore `.bin` files. Mirrors qwen-code 0.13.1's
// headless file scheme (file-token-storage.ts): scrypt(host+user) → aes-256-gcm, format
// `ivHex:authTagHex:cipherHex`. Host+user-derived key matches qwen's threat model (protects a
// copied-off-host file, not a local same-user attacker).
import * as Crypto from "node:crypto";
import * as os from "node:os";

const deriveKey = (): Buffer => {
  const salt = `${os.hostname()}-${os.userInfo().username}-qwen-code`;
  return Crypto.scryptSync("qwen-code-oauth", salt, 32);
};

// Derived once per process (scrypt is intentionally slow); host/user don't change at runtime.
const KEY = deriveKey();

export function encryptSecret(plaintext: Uint8Array): Uint8Array {
  const iv = Crypto.randomBytes(16);
  const cipher = Crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  return new TextEncoder().encode(blob);
}

export function decryptSecret(blob: Uint8Array): Uint8Array {
  const parts = new TextDecoder().decode(blob).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }
  const iv = Buffer.from(parts[0]!, "hex");
  const authTag = Buffer.from(parts[1]!, "hex");
  const decipher = Crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(authTag);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(parts[2]!, "hex")), decipher.final()]));
}
```

**4b. Wrap the store — `apps/server/src/auth/Layers/ServerSecretStore.ts`.** Add the import:
```ts
import { decryptSecret, encryptSecret } from "../secretCrypto.ts";
```
`get` (38-51) — decrypt **after** the read-error catch. Decryption is synchronous and throws on a
tampered/legacy blob; putting it in `Effect.map` would make that a defect AND feed the wrong cause
shape to the existing `.catch` (which reads `cause.reason._tag` from the readFile PlatformError). So
handle the read error first, then decrypt in `Effect.try`. Before:
```ts
  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Uint8Array.from(bytes)),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
    );
```
After:
```ts
  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
      // ru-fork: at-rest decryption (scrypt+AES-GCM) runs AFTER the read-error catch — a NotFound
      // stays null; a tampered/legacy blob becomes a typed SecretStoreError (Effect.try converts the
      // synchronous decrypt throw — it would otherwise be an uncaught defect).
      Effect.flatMap((bytes) =>
        bytes === null
          ? Effect.succeed(null)
          : Effect.try({
              try: () => decryptSecret(Uint8Array.from(bytes)),
              catch: (cause) =>
                new SecretStoreError({ message: `Failed to decrypt secret ${name}.`, cause }),
            }),
      ),
    );
```
(Confirm `Effect.try` is available in this beta — it's a standard constructor; the codebase's
`Effect.catch`/`Effect.gen` usage implies the full surface. The `set`/`create` encrypts below are
infallible in practice — aes-256-gcm with a fixed 32-byte key + random 16-byte IV cannot fail — so
computing `encryptSecret(value)` before the Effect is safe.)
`set` (53) — encrypt before write. Before:
```ts
  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    return Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, value);
```
After:
```ts
  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    const encrypted = encryptSecret(value); // ru-fork: at-rest encryption
    return Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, encrypted);
```
`create` (78-86) — encrypt before write. Before:
```ts
  const create: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(value);
```
After:
```ts
  const create: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const encrypted = encryptSecret(value); // ru-fork: at-rest encryption
    return Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(encrypted);
```
> **No migration needed** — the MCP feature has never shipped (zero users/data). There are no legacy
> plaintext `.bin` files to preserve. Just ship the encrypted format; no fallback branch, no wipe step.

**4c. Overlay — make it EPHEMERAL (verified safe), not a persistent plaintext file.**
*Verified lifecycle:* `writeOverlay` is awaited **before** the spawn (`ProviderCommandReactor.ts:531-539`
→ `startProviderSession`); the path is passed fresh on **every** spawn; resume/config-change = a
**brand-new `qwen --acp`** with a freshly-written overlay; qwen reads the file **only at process
startup** and has fully consumed it by the time the ACP `initialize` RPC resolves
(`AcpSessionRuntime.ts:410-414`); each spawn re-reads from disk (no hot-reload). Today the file is
deleted **only on project-deletion** (`McpReactor.ts:572-577`) — so resolved secrets sit in plaintext
on disk indefinitely. Since we have no backcompat constraint, the clean design is:
| Option | Plaintext-on-disk window | Cons |
|---|---|---|
| **A. Ephemeral per-spawn overlay** (recommended) | seconds (spawn → session established) | small new plumbing: a post-init delete + a per-spawn path |
| B. Keep per-project persistent file, `0600` only | forever (until project deleted) | resolved secrets live on disk for the life of the project |

**Recommended — Option A:** write a **per-spawn** overlay file (e.g. `overlays/<projectId>/<spawnId>.json`,
not the shared per-project path — avoids a race where a concurrent spawn of the same project reads a
file another session just deleted), pass it to qwen, and **delete it right after the session is
established** (after `session/new`/`session/load` resolves in `AcpSessionRuntime`), with a short
fallback timer (~30s) so a spawn that never establishes still cleans up. Net: secrets are encrypted at
rest in the `.bin` store, and the only plaintext copy (the overlay) exists for the few seconds qwen
needs to read it — then it's gone.
*Cons:* `AcpSessionRuntime` must know the overlay path to delete it (it already receives
`settingsOverlayPath` in the spawn input) and delete it post-`initialize`; the per-spawn filename is a
small change to `writeOverlay`'s path scheme (fine — no backcompat). **Testable:** assert the overlay
exists at spawn and is gone after the session resolves (and after the fallback timer if it doesn't).

---

## 5. Surface UI errors 🟠

### Mechanism (confirmed)
All mutations funnel through `dispatchMcpCommand` (`useMcp.ts:100-108`) which does
`.catch(() => undefined)`; `recheck` (274-281) likewise. The modal already has an `error` state +
a red block (`McpServerDialog.tsx:99`, `:384`); the toast system is global
(`toastManager.add(stackedThreadToast({type:"error", title, description}))`,
`components/ui/toast.tsx` + `toastHelpers.ts`). The RPC `dispatchCommand` returns a promise that
**rejects with `Error`** carrying the decider's `detail` (`wsTransport.ts:66-77`).

### Routing table — case → surface → message
| Action | Hook fn | Origin | Surface | Message (ru) |
|---|---|---|---|---|
| Add server | `addServer` | **Modal** | Red block at modal bottom | decider `detail` (e.g. «Сервер с такой конфигурацией…») |
| Edit server | `updateServer` | **Modal** | Red block at modal bottom | decider `detail` |
| Save project config | `setProjectBinding` | **Modal** (ProjectConfigDialog) | Red block at modal bottom | decider `detail` |
| Delete server | `removeServer` | List/Detail | **Toast** error | «Не удалось удалить сервер» + detail |
| Toggle server on/off | `setServerEnabled` | List/Detail | **Toast** error | «Не удалось изменить состояние сервера» |
| Add to project | `addBindingToProject` | Dropdown | **Toast** error | «Не удалось добавить сервер в проект» |
| Remove binding | `removeBinding` | Row | **Toast** error | «Не удалось убрать сервер из проекта» |
| Toggle binding on/off | `setBindingEnabled` | Row | **Toast** error | «Не удалось изменить состояние» |
| Toggle tool | `setToolEnabled` | Tool list | **Toast** error | «Не удалось изменить инструмент» |
| Recheck/refresh | `recheck` | Button | **Toast** error | «Не удалось проверить сервер» |

### Options — how mutations report failure
| Option | Pros | Cons | Arch fit |
|---|---|---|---|
| **A. Modal mutations return `Promise<void>` (reject on failure); non-modal mutations toast inside the hook** (recommended) | Modal controls its own error block; row actions get a uniform toast for free; minimal call-site churn | Modal call sites must `await` + `catch` → setError | Clean — splits "throw to caller" vs "self-toast" by origin |
| B. All mutations toast inside the hook | Zero call-site changes | Modal errors should stay in the modal, not as a toast over it; wrong UX | Simpler but wrong surface |
| C. Return a result object `{ok,error}` everywhere | Explicit | Verbose; touches every call site | More churn |

**Decision: A.** Split `dispatchMcpCommand` into a throwing variant (for modal mutations) and a
toasting variant (for fire-and-forget row actions).

### Testability
Web has no test target → validate with typecheck + lint only (per constraints). Logic is simple
plumbing; no unit tests added. (The decider rejection it surfaces IS unit-tested in item 2.)

### Exact code — `apps/web/src/ru-fork/mcp-manage/useMcp.ts`

**5a.** Replace the single swallowing dispatcher (100-108) with two variants:
```ts
function dispatchMcpCommandOrThrow(
  command: Parameters<
    ReturnType<typeof getPrimaryEnvironmentConnection>["client"]["orchestration"]["dispatchCommand"]
  >[0],
): Promise<void> {
  // ru-fork: modal callers await this and render the rejection in the dialog's error block.
  return getPrimaryEnvironmentConnection()
    .client.orchestration.dispatchCommand(command)
    .then(() => undefined);
}

function dispatchMcpCommandToast(
  command: Parameters<
    ReturnType<typeof getPrimaryEnvironmentConnection>["client"]["orchestration"]["dispatchCommand"]
  >[0],
  failureTitle: string,
): void {
  // ru-fork: fire-and-forget row actions — a failure becomes a UI toast (already-wired notifications).
  void getPrimaryEnvironmentConnection()
    .client.orchestration.dispatchCommand(command)
    .catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
}
```
Add this import at the top of `useMcp.ts` (verified path/alias — `toast.tsx` re-exports both
symbols; existing callers use exactly this line, e.g. `CommandPalette.tsx:107`):
```ts
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
```

**5b.** Modal mutations return the promise. `addServer` (160-179) before returns `string`
synchronously; the dialog needs to await. New shape:
```ts
  addServer: (input) => {
    const serverId = `srv-${randomUUID()}`;
    const description = trimmedDescription(input.description);
    return dispatchMcpCommandOrThrow({
      type: "mcp.server-add",
      commandId: newCommandId(),
      serverId: McpServerId.make(serverId),
      draft: {
        name: input.name,
        ...(description !== undefined ? { description } : {}),
        config: uiConfigToContract(input.config),
        vars: uiVarsToDraft(input.vars),
        extraArgs: [...input.extraArgs],
        extraHeaders: { ...input.extraHeaders },
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
      createdAt: nowIso(),
    }).then(() => serverId);
  },
```
…with the interface change `addServer: (input) => Promise<string>` and `updateServer`/
`setProjectBinding` → `Promise<void>`. Row actions switch to `dispatchMcpCommandToast(cmd, "…")`,
`recheck` replaces `.catch(() => undefined)` with the toast. (Full per-mutation diff is mechanical;
listed in the routing table. The interface (`McpMutations`, 125-157) updates the three modal
signatures to return promises.)

**5c.** Modal consumes it — `McpServerDialog.tsx`. The dialog already has
`const [error, setError] = useState<string|null>(null)` (:99) and renders the error block at the
bottom (`{error && <p className="text-sm text-destructive">{error}</p>}`, :384). The single dispatch
point is `commit` (:151-160), called from both `handleSubmit` (:205) and the warn-on-impact
confirmation path — so awaiting in `commit` covers both. The real close is `setOpen(false)` (NOT an
`onClose()`). Verbatim before (:151-160):
```tsx
  /** Dispatch the add/update, then close the dialog and clear staged state. */
  function commit(input: AddServerInput) {
    if (isEditing) {
      updateServer(server.id, input);
    } else {
      addServer(input);
    }
    setOpen(false);
    setImpact(null);
    setPendingInput(null);
  }
```
After (close only on success; render the decider rejection in the existing error block):
```tsx
  /** Dispatch the add/update; close + clear on success, or surface the server error in the dialog. */
  function commit(input: AddServerInput) {
    // ru-fork: addServer/updateServer now return a Promise that rejects with the decider error.
    const dispatched = isEditing ? updateServer(server.id, input) : addServer(input);
    void dispatched
      .then(() => {
        setOpen(false);
        setImpact(null);
        setPendingInput(null);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Не удалось сохранить сервер.");
      });
  }
```
(`addServer` returns `Promise<string>`, `updateServer` `Promise<void>` → the ternary is
`Promise<string | void>`; `.then(() => …)` discards the value. The error block at :384 renders the
Russian decider `detail` unchanged.)

> **Caller audit (required):** `addServer` currently returns the new `serverId` **synchronously**
> (`useMcp.ts:178`); making it `Promise<string>` breaks any caller that uses the id inline. The
> dialog's `commit` ignores the return (safe). Before impl, grep every `addServer(` call site and
> confirm none consume the returned id synchronously (the "add then immediately bind" flow, if any,
> must `await`). This is the one non-mechanical part of item 5.

---

## 6. Dialog controls — wire trust, remove the other, no autobind toggle 🟡

### Decision (confirmed end-to-end against qwen + our code)
- **«Доверять серверу»** checkbox (`McpServerDialog.tsx`, state `trusted` :96): currently **never
  sent**. → **WIRE IT** as a real catalog-level `trust` field (the one true lever over MCP
  confirmation — see the full proof + exact diffs below). Default true.
- **«Включить все инструменты»** checkbox (state `enableAllTools` :97): **never sent**, and redundant
  with the existing per-project tool policy (allow/deny → qwen `includeTools`/`excludeTools`). →
  **Dead. Remove.**
- **`autobindDefaults`** (server setting, honored in `McpReactor.autobindBuiltinsForProject`):
  stays **false**, **no UI toggle** (your decision) → a new project starts with **0 MCPs**. Confirm
  the default false (it already is, `settings.ts:236`).

### Removal (the «Включить все инструменты» checkbox only)
**Remove** in `McpServerDialog.tsx`: the «Включить все инструменты» `<label>…<Checkbox/></label>`
block (`:275-287`), its `enableAllTools` state (`:97`), and its `reset()` line (`:114`). Redundant —
tool on/off is the existing per-project `toolPolicy`. The «Доверять серверу» checkbox is **kept and
wired** (next section); the `trusted` state (`:96`) is reused, not removed.
**Testability:** web = typecheck/lint only; the `trust` logic is unit-tested server-side (fingerprint
+ overlay tests, below).

### «Доверять серверу» (trust) — WIRE IT (the one real confirmation lever)
**Fully verified, no blocking catch.** Earlier I wrongly said folder-trust gates this — it doesn't.
Proof chain: our overlay writes `security.folderTrust.enabled: false` (`McpOverlay.ts:188`) →
`isFolderTrustEnabled()` = false (`trustedFolders.ts:194-196`) → folder-trust feature OFF →
`isWorkspaceTrusted()` trusted (`trustedFolders.ts:224-228`) → `isTrustedFolder()` = **true**
(`config.ts:1899-1916`). **The folder is already trusted.** So a per-server `trust: true`
(`mcp-tool.ts:132-143` `getDefaultPermission`: `trust===true && isTrustedFolder()` → `'allow'`) makes
tools auto-run with **no** change to the folder-trust line. And since **full-access is locked**
(`DISABLE_AUTO_APPROVE`, `apps/web/src/ru-fork/config.ts:6`) our `request_permission` auto-answer
(`CliAdapter.ts:958`, gated on full-access) never fires — so **the overlay `trust` field is the ONLY
lever** over MCP confirmation. Today we send no `trust` → only read-only tools auto-run
(`mcp-tool.ts:137` `readOnlyHint`), write tools ask.

**Behavior:** catalog-level `trust` (default true = «доверять», auto-run). Uncheck → that server's
**write** tools prompt on the next turn for **every** project using it (catalog change → every
project's overlay fingerprint differs → qwen respawns via the existing `overlayChanged` gate). Каталог
→ все проекты. (Honesty: unchecking a server with only **read-only** tools changes nothing — qwen
always auto-allows read-only — so the checkbox visibly matters only for write-capable servers; add a
tooltip.)

### Exact diffs (~6 files, low risk)
**Contract — `packages/contracts/src/ru-fork/mcp.ts`.** `McpCatalogServer` (after `enabled`, :150):
```ts
  // ru-fork: server-wide auto-approval. true ⇒ qwen runs this server's tools without confirmation
  // (folder is trusted); false ⇒ write tools prompt (read-only still auto-run). Catalog-level — a
  // change respawns every project's session via the overlay fingerprint.
  trust: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
```
`McpServerDraft` (add, after `description`, :250) and `McpServerDraftPatch` (after `enabled`, :269):
```ts
  trust: Schema.optionalKey(Schema.Boolean),
```
**DB — `apps/server/src/persistence/Migrations/031_Mcp.ts`** (after `enabled`, :32):
```sql
      trust              INTEGER NOT NULL DEFAULT 1,
```
**Builders — `apps/server/src/ru-fork/mcp/McpCatalogBuilders.ts`.** `buildAddedServer` (after `enabled: true,`):
```ts
    trust: draft.trust ?? true,
```
`applyServerUpdate` (after the `enabled:` line):
```ts
    trust: patch.trust ?? existing.trust,
```
`buildSyncedBuiltin` (after its `enabled:` line):
```ts
    trust: input.existing?.trust ?? true,
```
**Overlay — `apps/server/src/ru-fork/mcp/McpOverlay.ts`.** `buildServerEntry` gains a `trust` param and
emits it (qwen's field is **`trust`**). In both transport branches add `trust,` to the returned object:
```ts
function buildServerEntry(
  resolved: ResolvedServerConfig,
  policy: McpToolPolicy,
  trust: boolean,
): Record<string, unknown> {
  // …toolFilter + timeout unchanged…
  // stdio branch:  return { command, args, env, ...(cwd?{cwd}:{}), timeout, ...toolFilter, trust };
  // http branch:   return { httpUrl, headers, timeout, ...toolFilter, trust };
}
```
The call (`:174`): `buildServerEntry(resolved, binding.toolPolicy, server.trust)`. The
`fingerprintEntries.push({...})` (`:176-180`) gains `trust: server.trust,`.
**Fingerprint — `packages/mcp-core/src/fingerprint.ts`.** Add `readonly trust: boolean;` to
`OverlayServerEntry`, and add `trust: entry.trust,` to the canonical object in `overlayFingerprint` →
a trust change yields a new fingerprint → respawn.
**UI — `McpServerDialog.tsx`.** The `trusted` state already exists (`:96`) — now actually **send** it:
add `trust: trusted` to the `AddServerInput`, and in `useMcp.ts` `addServer`/`updateServer` include
`trust` in the command `draft`/`patch`. **Remove** the «Включить все инструменты» checkbox (`:97, :114,
:275-287`) — tool on/off is already the per-project `toolPolicy` (→ qwen `includeTools`/`excludeTools`,
`mcp-client.ts:1426-1446`).

**Cons:** trust is catalog-level (no per-project override) — matches the model (projects tune per-tool
via `toolPolicy`). Read-only servers ignore it (qwen behavior) — tooltip it. No folder-trust change.
Testable: a fingerprint unit test (trust flips the hash) + an overlay test (entry carries `trust`).

---

## 7. Non-transactional secret write 🟠

### Mechanism (confirmed)
`decideOrchestrationCommand` runs at `OrchestrationEngine.ts:172-175` — **before**
`sql.withTransaction` (177). The decider's `splitServerVars`/`resolveBindingVarValues` call
`secretStore.set()` immediately (`McpSecrets.ts:64-67,104-111`). If the subsequent event append /
projection fails inside the transaction, the secret is already on disk → **orphan** (no event
references it). No compensation today. (Note: item 2 already moves the uniqueness reject *before*
the secret write, removing one orphan source.)

### Options
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Compensating cleanup: on transaction failure, remove secrets written during the decide phase** (recommended) | Minimal; localized; no decider rewrite | Needs the decide phase to RECORD which secret names it wrote (a small collector) | Moderate — thread a "written refs" set out of decide |
| B. Move secret writes INSIDE the transaction | Truly atomic | Big refactor: secret IO is FS, not SQL — it can't join the SQL tx; you'd need a 2-phase pattern | Architecture change |
| C. Orphan GC sweep (already exists: `pruneByPrefix`/`gcOrphanedSecrets`) covers it eventually | Already implemented; self-heals | Window of an orphan secret on disk until the next reconcile GC | Already in place |
| D. Accept (rely on C) | Zero work | A transient orphan secret persists until GC | — |

### Both options, written out + evaluated

**Option A (naive recompute) — REJECTED, it's unsafe.** Wrapping the transaction in `Effect.onError`
and recomputing secret names from the command (`mcpVarSecretName` from `command.serverId` +
`draft.vars` [+ `projectId`]) then `remove`-ing them looks clean:
```ts
// AFTER the existing .catchTag("SqlError", …) on the transaction — DO NOT USE (see why below):
.pipe(
  Effect.onError(() =>
    Effect.gen(function* () {
      if (envelope.command.type === "mcp.server-add") {
        for (const draft of envelope.command.draft.vars) {
          if (draft.secret && draft.value !== null) {
            yield* serverSecretStore
              .remove(mcpVarSecretName({ serverId: envelope.command.serverId, varName: draft.name }))
              .pipe(Effect.ignore);
          }
        }
      }
      // …binding-set / server-update branches…
    }),
  ),
)
```
**Why it's unsafe:** `splitServerVars` honors `keepSecret` (`McpSecrets.ts`) — on a `server-update`
that keeps an existing secret, NO new write happens, the var **reuses the prior ref**. The recompute
above can't see that, so on a rollback it would `remove` a secret that the *previous, committed* add
still references → it deletes a live credential. Same hazard for binding `keepNames`. A *safe* Option
A would require the decide phase to RETURN the set of secret names it actually wrote (a real collector
threaded out of `splitServerVars`/`splitBindingVarValues` into the engine), then remove exactly those
— a real change to the decider's return contract. Bigger, and still only closes a window GC closes.

**Option C (rely on existing orphan GC) — RECOMMENDED, and it's already correct + safe.** No code
change. `gcOrphanedSecretsEffect` (`McpReactor.ts:371-396`) computes `live` = every secret ref
referenced by the **persisted** catalog + bindings, then `pruneByPrefix(MCP_VAR_SECRET_PREFIX, live)`
removes every `mcp-var-*.bin` NOT in `live`. An orphan from a failed append is never in the DB → never
in `live` → pruned on the next reconcile. Crucially it **cannot** delete a referenced secret (the
exact bug that sinks Option A), because `live` is derived from what's actually referenced. It runs on
every reactor signal (user edit / project-created / reconcile). Combined with **item 4** (secrets now
encrypted at rest), an orphan is an *encrypted, unreferenced* blob pruned within one reconcile —
negligible risk. The only residual: a crash before the next reconcile leaves the orphan until the
startup reconcile (still encrypted, still pruned then).

**Decision: C** — document that orphan GC is the transactional safety net (add a line to
`IMPLEMENTATION.md`); do not add the unsafe/heavier Option A. (If you want belt-and-suspenders later,
it's the *safe* A: thread written-names out of decide — I'll write that exact change on request.)

### Testability — YES (fault-injection): force `eventStore.append` to fail after a secret write;
assert the orphan `.bin` is gone after a reconcile (Option C) and that a *kept* secret survives.

---

## 8. varValues / `${VAR}` ↔ declared-vars validation 🟠

### Mechanism (confirmed)
`mcp.binding-set` (`decider.ts:849-881`) stores `command.patch.varValues` with **no check** that
its keys are declared vars. `expandTemplate` (`resolver.ts:45-59`) turns an unknown `${VAR}` into
`""` silently. `resolveVarValues` (71-90) turns a missing var into `""`. → a typo'd binding key is
silently ignored; an undeclared `${VAR}` silently blanks.

### Options
| Option | Pros | Cons | Arch fit |
|---|---|---|---|
| **A. Decider guard on `mcp.binding-set`: reject varValues keys not in `server.vars`** (recommended) | Catches the common typo at the authority; cheap | Doesn't catch config-side `${VAR}` typos (covered by B) | Clean — same invariant pattern |
| **B. Add-time config validation: every `${VAR}` in config resolves to a declared var (or `${PROJECT_CWD}`)** (recommended, pairs with A) | Catches template/declaration mismatch at add | Needs a placeholder-extractor in resolver (pure) | Clean — pure helper + decider call |
| C. Resolver throws on unknown `${VAR}` at runtime | Centralized | Too late (server already "added"); turns a config error into a probe failure | Worse UX |

**Decision: A + B** (validate both binding keys and config placeholders at the decider).

### Testability — YES (decider harness): bind with an undeclared key → throw; add a server whose
config has `${UNDECLARED}` → throw; declared-only → ok.

### Exact code
**8a. Pure placeholder extractor — `resolver.ts`** (append near `expandTemplate`):
```ts
/** ru-fork: every distinct `${NAME}` referenced by a config (excludes the builtin ${PROJECT_CWD}). */
export function configPlaceholders(config: McpServerConfig): ReadonlySet<string> {
  const names = new Set<string>();
  const scan = (value: string): void => {
    for (const match of value.matchAll(TEMPLATE_PATTERN)) {
      const name = match[1];
      if (name !== undefined && name !== PROJECT_CWD) {
        names.add(name);
      }
    }
  };
  if (config.transport === "stdio") {
    scan(config.command);
    config.args.forEach(scan);
  } else {
    scan(config.httpUrl);
    Object.values(config.headers).forEach(scan);
  }
  return names;
}
```
**8b. Decider — binding key check** in `mcp.binding-set` (after `requireCatalogServer` resolves
`server`, before `resolveBindingVarValues` writes secrets):
```ts
      // ru-fork: reject binding varValues whose keys are not declared vars (catches typos that would
      // otherwise be stored and silently ignored).
      const declaredNames = new Set(server.vars.map((declared) => declared.name));
      const unknownKeys = Object.keys(command.patch.varValues ?? {}).filter(
        (key) => !declaredNames.has(key),
      );
      if (unknownKeys.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Неизвестные переменные для сервера «${server.name}»: ${unknownKeys.join(", ")}.`,
        });
      }
```
**8c. Decider — config placeholder check** in `mcp.server-add` (and `server-update` when
`patch.config`/`patch.vars` change), after the uniqueness check:
```ts
      // ru-fork: every ${VAR} in the config must resolve to a declared var (or ${PROJECT_CWD}).
      const declaredVarNames = new Set(command.draft.vars.map((variable) => variable.name));
      const danglingPlaceholders = [...configPlaceholders(command.draft.config)].filter(
        (name) => !declaredVarNames.has(name),
      );
      if (danglingPlaceholders.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Шаблон ссылается на необъявленные переменные: ${danglingPlaceholders.join(", ")}.`,
        });
      }
```
(Imports: add `configPlaceholders` to the decider's `@ru-fork/mcp-core`/contracts import. Confirm
`TEMPLATE_PATTERN`/`PROJECT_CWD` are module-scoped in resolver.ts — they are, per the research.)

---

## 9. Missing secret → blank credential 🟠

### Mechanism (confirmed)
`materializeSecretValues` (`McpSecrets.ts:150-154`) maps a missing ref to `""`; `resolveVarValues`
(`resolver.ts:85-87`) maps a missing secret ref to `""`. A deleted/never-set secret → server
launches with a blank credential, looks "complete," fails confusingly.

### Options
| Option | Pros | Cons | Arch fit |
|---|---|---|---|
| **A. Treat a declared-but-missing secret as "incomplete" (exclude from probes/overlay, surface a status)** (recommended) | No blank-credential launches; matches the existing «требует настройки» incomplete-instance concept | Needs `materialize`/resolve to report which refs were missing | Clean — extends the existing completeness gate |
| B. Hard error at resolution | Explicit | A single missing secret errors the whole reconcile pass | Too broad |
| C. Leave blank | Zero work | Silent broken server | — |

**Decision: A** — fold "missing secret ref" into the existing incomplete-instance exclusion (the same
gate that hides a template with an unfilled per-project hole). The completeness gate today is
`missingRequiredVars` (`resolver.ts:98-106`, pure), checked in `computeDesiredEffect`
(`McpReactor.ts` catalog loop + binding loop, BEFORE `mergeDesired`/`materializeSecretValues`) and in
`McpOverlay.ts:156`. A missing secret ref needs the store (async), so it's a sibling **effectful**
check at the same gate.

> **Scope split (honest):** (a) the **safety** fix — exclude the instance so qwen never launches with a
> blank credential — is exact code below and fully lands. (b) Showing «требует настройки» in the UI
> for this case is a SEPARATE change: the client computes `incomplete`/`missingVars` from catalog vars
> (`adapters.ts`) and **cannot see** a missing server-side ref, so surfacing it needs a new
> per-instance flag on the runtime snapshot. (a) is the fix; (b) is a follow-on, flagged not coded.

### Exact code (safety exclusion)
**9a. Effectful predicate — `apps/server/src/ru-fork/mcp/McpSecrets.ts`** (append; `effectiveVarValue`
+ `isSecretRef` are already module-scoped here, used by `collectVarSecretRefs`):
```ts
/** ru-fork: names of REQUIRED secret vars whose stored secret is ABSENT (deleted / never written).
 * Such a var resolves to "" and would launch a blank credential — caller must treat the instance as
 * incomplete (exclude from probe + overlay), exactly like a missing required value. */
export const missingSecretVarNames = (
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): Effect.Effect<ReadonlyArray<string>, SecretStoreError, ServerSecretStore> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const missing: string[] = [];
    for (const declared of vars) {
      if (!declared.required) {
        continue; // optional secret missing ⇒ "" is acceptable (matches missingRequiredVars semantics)
      }
      const effective = effectiveVarValue(declared, varValues);
      if (effective !== null && isSecretRef(effective)) {
        const bytes = yield* secretStore.get(effective.secretRef);
        if (bytes === null) {
          missing.push(declared.name);
        }
      }
    }
    return missing;
  });
```
**9b. Gate in `computeDesiredEffect` — `McpReactor.ts`.** Catalog loop, after the `missingRequiredVars`
check. Before:
```ts
    if (missingRequiredVars(server.vars, {}).length > 0) {
      continue;
    }
    yield* mergeDesired(desired, server, {}, server.timeoutMs ?? undefined, `catalog:${server.id}`);
```
After:
```ts
    if (missingRequiredVars(server.vars, {}).length > 0) {
      continue;
    }
    // ru-fork: a declared required secret whose stored value is gone ⇒ incomplete (never launch blank).
    if ((yield* missingSecretVarNames(server.vars, {}).pipe(provideSecretStore)).length > 0) {
      continue;
    }
    yield* mergeDesired(desired, server, {}, server.timeoutMs ?? undefined, `catalog:${server.id}`);
```
Binding loop, after its `missingRequiredVars(server.vars, binding.varValues)` check, identically:
```ts
    if (missingRequiredVars(server.vars, binding.varValues).length > 0) {
      continue; // incomplete ⇒ not probed/spawned (§D8)
    }
    // ru-fork: missing stored secret ⇒ incomplete (don't launch a blank credential).
    if ((yield* missingSecretVarNames(server.vars, binding.varValues).pipe(provideSecretStore)).length > 0) {
      continue;
    }
    yield* mergeDesired(desired, server, binding.varValues, effectiveTimeoutMs(server, binding), `${binding.projectId}:${binding.serverId}`);
```
(`provideSecretStore` already exists in `computeDesiredEffect` — `Effect.provideService(ServerSecretStore, secretStore)`. Import `missingSecretVarNames` from `./McpSecrets.ts` where `materializeSecretValues` is already imported.)
**9c. Same gate in `McpOverlay.ts`** after line 156's `missingRequiredVars` check — the overlay
writer has `provideSecretStore`/`materializeSecretValues` in scope; add the identical
`missingSecretVarNames(...).length > 0 ⇒ continue` guard so a missing-secret binding is also excluded
from the qwen overlay (defense in depth with 9b).

### Testability — YES (secrets unit + computeDesired unit): declare a required secret var, store no
`.bin` → assert `missingSecretVarNames` returns its name AND the instance is absent from
`computeDesiredEffect`'s result (not resolved to `""`).

---

## 10. 32-bit hash collision risk 🟡

### Mechanism (confirmed)
`fnv1a` is 32-bit (`resolver.ts:202-209`). Used by `configCacheKey` (probe-cache row key),
`dedupHash` (supervisor instance key + overlay fingerprint base), `builtinHash` (template-change
detection), and now `configIdentity` (item 2). A 32-bit space (~4.3B) gives a ~50% collision chance
around ~77k distinct keys (birthday bound) — low for a single user's catalog, but a collision in
`dedupHash`/`configCacheKey` is a real correctness bug (two configs share a probe row / instance).

### Options
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Widen `fnv1a` to 64-bit (FNV-1a 64 via BigInt), 16 hex chars** (recommended) | Drops collision risk to negligible; one function; every caller inherits it; keys are opaque strings so no schema change | Slightly slower (BigInt); existing persisted 8-char keys become 16-char → a one-time cache/key reshuffle | Clean — single function, callers unchanged |
| B. Switch to SHA-256 (truncated) | Cryptographic | Heavier; overkill for non-adversarial identity | Fine but heavier |
| C. Leave 32-bit | Zero work | Latent collision bug in the riskiest keys | — |

**Decision: A.** Keys are opaque (probe-cache `config_key` TEXT, in-memory dedup map, builtinHash
TEXT) → widening is transparent; old persisted rows simply don't match new keys and get GC'd/re-probed.

### Testability — YES (pure unit): no collision across a large set of distinct inputs; stable output;
length is 16 hex.

### Exact code — `packages/mcp-core/src/resolver.ts:202-209`
Before:
```ts
/** 32-bit FNV-1a → 8 hex chars. Used for the config/dedup/overlay/builtin identity hashes. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
```
After:
```ts
/** ru-fork: 64-bit FNV-1a → 16 hex chars. Used for the config/dedup/overlay/builtin/identity hashes.
 * Widened from 32-bit to make a collision (two different configs sharing a probe-cache row or a
 * supervisor instance) negligible. Keys are opaque strings everywhere, so widening is transparent —
 * pre-existing 8-char persisted keys simply no longer match and are GC'd/re-probed. */
export function fnv1a(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
```
> **Interaction with item 2:** apply item 10 first, then `configIdentity` inherits 64-bit for free.
> **Interaction with persisted state:** acceptable pre-release; on a real deployment we'd ship a
> migration that wipes `mcp_probe_cache` (re-probed harmlessly) — note in `DATA-MODEL.md`.

---

## 11. Cross-client `watchedProjects` clobber 🟠

### Mechanism (confirmed)
`watchedProjectsRef` is a **single shared** `Ref<ReadonlySet<string> | null>`
(`McpSupervisor.ts:242`), set wholesale by `setWatchedProjects` (248-249), driven per-connection by
`mcpSetActiveProject` (`ws.ts:952-957`). Two clients/windows → last writer wins; the other's watched
set is dropped (its servers stop being swept). In-memory, reset to `null` (= probe all) on restart.

### Options
| Option | Pros | Cons / risk | Arch fit |
|---|---|---|---|
| **A. Per-connection watched sets; the sweep watches the UNION** (recommended) | Correct multi-client behavior; each window keeps its monitoring; cleared on disconnect | Needs a per-connection key + cleanup on disconnect | Moderate — keyed map + union read |
| B. Keep single Ref, never clear (union of all-time) | Trivial | Grows unbounded; a closed window keeps its projects hot forever | Leak |
| C. Accept clobber | Zero work | Multi-window users silently lose monitoring | — |

**Decision: A** — store `Map<connKey, ReadonlySet<string>>`; sweep watches the union; drop a key on
disconnect. **Supervisor is a singleton** (`McpSupervisorLive`, one instance shared across all
connections — confirmed), so the map lives in one place.

> **Key choice (important):** the obvious key is `session.sessionId`, available at the seam
> (`makeWsRpcLayer(session.sessionId)`, ws.ts:1313). But that's the **auth** session — two browser
> tabs of the *same user* share it, so keying by it does NOT fix the very "two windows" case the gap
> describes. The correct key is a **per-WS-connection id** minted in `websocketRpcRouteLayer`. Both
> are written below; **recommend the per-connection id.**

### Exact code (supervisor — identical for either key)
**Interface — `McpSupervisor.ts:189-190`.** Before:
```ts
  readonly setWatchedProjects: (projectIds: ReadonlyArray<string>) => Effect.Effect<void>;
```
After:
```ts
  readonly setWatchedProjects: (connKey: string, projectIds: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly clearWatchedProjects: (connKey: string) => Effect.Effect<void>;
```
**State — `McpSupervisor.ts:242`.** Before:
```ts
  const watchedProjectsRef = yield* Ref.make<ReadonlySet<string> | null>(null);
```
After:
```ts
  // ru-fork: per-connection watched sets (was a single shared Set ⇒ last-writer-wins clobber).
  const watchedBySessionRef = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
```
**Setters — `McpSupervisor.ts:248-249`.** Before:
```ts
  const setWatchedProjects: McpSupervisorShape["setWatchedProjects"] = (projectIds) =>
    Ref.set(watchedProjectsRef, new Set(projectIds));
```
After:
```ts
  // An empty list = this client is viewing no project ⇒ KEEP its entry with an empty set (watch
  // nothing for it); only a disconnect removes the entry. So one client viewing nothing never
  // suppresses another client's watched projects.
  const setWatchedProjects: McpSupervisorShape["setWatchedProjects"] = (connKey, projectIds) =>
    Ref.update(watchedBySessionRef, (bySession) => new Map(bySession).set(connKey, new Set(projectIds)));
  const clearWatchedProjects: McpSupervisorShape["clearWatchedProjects"] = (connKey) =>
    Ref.update(watchedBySessionRef, (bySession) => {
      const next = new Map(bySession);
      next.delete(connKey);
      return next;
    });
```
…and add `setWatchedProjects, clearWatchedProjects` to the returned shape object.
**Sweep read — `McpSupervisor.ts:478`.** Before:
```ts
    const watched = yield* Ref.get(watchedProjectsRef);
```
After (preserves the exact tri-state: no clients ⇒ null ⇒ probe-all startup default; clients all
viewing nothing ⇒ empty Set ⇒ probe nothing; else the union):
```ts
    const bySession = yield* Ref.get(watchedBySessionRef);
    const watched: ReadonlySet<string> | null =
      bySession.size === 0
        ? null
        : new Set<string>([...bySession.values()].flatMap((projectSet) => [...projectSet]));
```
(The downstream `isSweepDue(instance, watched, …)` / `instanceInWatched` are unchanged — they already
take `ReadonlySet<string> | null`.)

### Exact code (web seam — recommended: per-connection id)
In `websocketRpcRouteLayer` (`ws.ts:1301-1338`) mint a connection id and thread it into the rpc layer
+ the disconnect release. The minimal, non-guessing shape:
```ts
    const connectionId = yield* Effect.sync(() => crypto.randomUUID()); // ru-fork: per-WS-connection key
    // …pass connectionId into makeWsRpcLayer(session.sessionId, connectionId) so the mcp handler can use it…
    return yield* Effect.acquireUseRelease(
      sessions.markConnected(session.sessionId),
      () => rpcWebSocketHttpEffect,
      () =>
        sessions
          .markDisconnected(session.sessionId)
          .pipe(Effect.andThen(mcpSupervisor.clearWatchedProjects(connectionId))), // ru-fork: drop on disconnect
    );
```
and the handler (`ws.ts:952-957`):
```ts
        [WS_METHODS.mcpSetActiveProject]: ({ projectId }) =>
          observeRpcEffect(
            WS_METHODS.mcpSetActiveProject,
            mcpSupervisor.setWatchedProjects(connectionId, projectId !== null ? [projectId] : []),
            { "rpc.aggregate": "mcp" },
          ),
```
**The one signature to confirm during impl:** `makeWsRpcLayer` currently takes `(session.sessionId)`
(ws.ts:1313, param `currentSessionId` at :181) — add a second `connectionId` param and capture it in
the handler closure. That's the single threading change; everything else is exact.
**Minimal fallback (if you don't want to touch `makeWsRpcLayer`):** key by `currentSessionId` instead
— exact same supervisor code, `setWatchedProjects(currentSessionId, …)` /
`clearWatchedProjects(currentSessionId)` in the disconnect release. Fixes cross-**user** clobber; does
NOT separate same-user tabs. I recommend paying the one-param threading for the full fix.

### Testability — YES (supervisor unit): `setWatchedProjects("c1", ["A"])`, `setWatchedProjects("c2",
["B"])` → sweep union = {A,B}; `setWatchedProjects("c2", [])` → union still {A}; `clearWatchedProjects("c1")`
→ map has only c2's empty set → union = {} (probe nothing); clear c2 → empty map → null (probe all).

---

## Tests to write FIRST (red before any fix)

All under `apps/server/tests/ru-fork/mcp/` unless noted. Harnesses confirmed in
`reconciliationLifecycle.test.ts` (`makeSystem`, `dispatch`, `catalog`, `bindings`, `reconcile`,
`backfill`, `probeUpsert`) and `reactorWorker.test.ts` (full reactor `run`).

1. **Backfill ordering** (`reactorWorker.test.ts` or a new `metadataBackfillOrdering.test.ts`):
   drive the real worker path — add a custom server (description null), inject a fake probe that
   returns `serverDescription`, enqueue an eager reconcile, drain, assert the catalog description is
   filled **in that cycle**. RED today (backfill precedes the probe). *Needs a fake-probe seam in the
   reactor harness; reactorWorker.test.ts already builds the supervisor — confirm how it stubs
   `probeOnce` (or inject a fake supervisor) when writing the test.*
2. **Config uniqueness — add** (`reconciliationLifecycle.test.ts` "decider guards" block): add A
   (config X) ok; add B (same config X, different name/id) → `rejects.toThrow()`; catalog has 1 row
   with X. RED today.
3. **Config uniqueness — edit** : add A(X) and B(Y); edit A→Y → throw; edit A's name only → ok. RED.
4. **Built-in skip-on-collision** : custom server config X; `reconcile([builtinDef with X])` → assert
   no `builtinId` row added (built-in skipped). RED.
5. **Config placeholder / binding-key validation** (item 8): add server with `${UNDECLARED}` → throw;
   bind with an undeclared key → throw; declared-only → ok. RED.
6. **Secret encryption round-trip** (item 4, `tests/auth/secretCrypto.test.ts`): `decrypt(encrypt(x))
   === x`; tamper → throws; on-disk blob ≠ plaintext. (GREEN once 4a lands — this is a fix-validation
   test, not a red-first bug test.)
7. **64-bit hash** (item 10): distinct inputs → distinct 16-hex outputs; deterministic. (Fix-validation.)

Items 7/9/11 (transactional secret, missing-secret-incomplete, watchedProjects) get tests when their
A-vs-C decisions are locked.

## Resolved (recommendations locked — no open unknowns)
- **#3:** in-product "did it load" is impossible in qwen 0.13.1 (no MCP data in `session/new`) → runbook
  (done) + a conformance unit test (3d) + additive probe cases (3b). No backcompat to worry about.
- **#4:** no migration (zero users) — ship encrypted `.bin` + ephemeral overlay (write→spawn→delete).
- **#6:** wire `trust` (folder already trusted — no folder-trust change), remove «enable all», no
  autobind toggle (stays false → new project = 0 MCPs).
- **#7:** rely on existing orphan GC (the "undo on failure" variant is proven unsafe) + a doc line.
- **#9:** server-side exclusion now; the «требует настройки» label for the rare missing-*secret* case is
  a small follow-on (needs a runtime-snapshot flag).
- **#11:** key by a **per-connection id** (one `makeWsRpcLayer` param) for the full multi-tab fix.

## Sequencing (decided)
- **#3 probe extras:** just improve the probe (additive cases); independent, ungated — done as part of
  the work, you run it whenever.
- **#11 (watchedProjects):** **DEFERRED to last.** Nothing is broken without it — single-window works
  fully; only multi-window background auto-reprobe is scoped to the last-focused project (manual
  recheck still works). Pick it up after everything else.

## The only choice left for you
- **Round scope:** all of the rest in one test+fix pass, or **clean core first (1, 2, 4, 6, 8, 10 +
  #5 UI)** then (3-probe, 7-doc, 9)? — #11 goes last regardless.

Everything else is decided and has exact before/after code above.
