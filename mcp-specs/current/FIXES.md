# MCP management — Fix Plan (verified)

> **Status (2026-06-14):** the R/B/C fixes below are implemented. A later round also landed: the **reconciler
> dedup fix** (per-dispatch `crypto.randomUUID()` commandIds), **three silent error swallows → `logDebug`**
> (`pruneByPrefix` + dead-catch removal + type narrow, `removeOverlay`, `McpRuntime` snapshot), the
> `ProviderCommandReactor` `Effect.gen` unwrap + `overlayChanged` in the restart log, and a large test +
> lint pass. See **`TESTING.md`** for that round and **`GAP-ANALYSIS.md`** for the remaining (not-yet-fixed)
> gaps.

> Actionable companion to [`AUDIT.md`](./AUDIT.md). Every fix below is **byte-checked against the current
> tree** and uses **only APIs already proven in this codebase** — so implementation may copy the `AFTER`
> blocks verbatim (no improvisation). Each item: location · severity · before→after · why-minimal · risk.
>
> **Global gate (after each phase):** `pnpm typecheck` 10/10 · `pnpm lint` 0/0 · `pnpm test:fast` (only the
> 4 preexisting `bin.test.ts` env failures).
>
> **Order:** Phase A (robustness) → Phase B (dead-code) → Phase C (hygiene). A and B are independent;
> R1+R2 are one coherent edit in the same file. Two items from the v1 draft (R5-via-filterMap, C2) were
> corrected/dropped during verification — see *Verification notes* and *Deliberately NOT changing*.

## Verification notes (what was confirmed, so the AFTER blocks are final)

- `Cache.make` **requires a `lookup`**; access is `Cache.getOption(cache, key)` (→ `Option`) and
  `Cache.set(cache, key, v)` — module functions, exactly as `handledTurnStartKeys` uses them (R2).
- `Effect.acquireUseRelease(acquire, (a)=>use, (a)=>release)` is proven (`ws.ts:1333`, `cli/project.ts:78`)
  with the release taking the acquired value (R4).
- `Effect.as`, `Effect.logError`, `Effect.void`, `Effect.gen` — all proven (R1/R4).
- `Stream.filter` is used in `McpProjectionQuery` and its **refinement overload** `<A,B extends A>(refinement):
  Stream<B>` exists in `effect@4.0.0-beta.59` — so R5 narrows cleanly. (`Stream.filterMap` takes a
  `Filter.Filter`, *not* `A→Option<B>` — the v1 draft was wrong; not used.)
- `Ref` is used **only** by `sessionOverlayFingerprintRef` in `ProviderCommandReactor` → R2 removes the import.
- `GetCatalogServerInput` has no importer outside `getById`'s machinery → B2 removes it entirely.
- `connecting`/`error` appear in **two** adapter switches (`runtimeStatusToUi` *and* `runtimeDetail`) → B4 edits both.

---

## Phase A — Robustness (failure-path correctness)

### A1 · R1 + R2 — overlay failure is silent & strands the session; the fingerprint map is unbounded
**File:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`. (One coherent edit: R1 fixes the
recovery/observability, R2 bounds the store; the gate read uses the cache, so they're shown together.)

**(a) New constants** — add beside `HANDLED_TURN_START_KEY_MAX`/`_TTL` (~line 93):
```ts
const SESSION_OVERLAY_FINGERPRINT_MAX = 10_000;
const SESSION_OVERLAY_FINGERPRINT_TTL = Duration.minutes(30);
```

**(b) Replace the unbounded `Ref<Map>` with the bounded cache** (R2):
```ts
// BEFORE  (the comment at lines 233–237 + the Ref)
  // ru-fork: per-thread MCP overlay fingerprint the live session spawned with. … the map's in-memory
  // lifetime is correct.
  const sessionOverlayFingerprintRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
// AFTER
  // ru-fork: per-thread MCP overlay fingerprint the live session spawned with — bounded (capacity+TTL)
  // so it can't grow unbounded; an evicted entry ⇒ a safe, history-preserving respawn on the next turn.
  const sessionOverlayFingerprints = yield* Cache.make<string, string>({
    capacity: SESSION_OVERLAY_FINGERPRINT_MAX,
    timeToLive: SESSION_OVERLAY_FINGERPRINT_TTL,
    lookup: () => Effect.succeed(""), // unused — access is via getOption + set (mirrors handledTurnStartKeys)
  });
```
Then **delete the now-unused import** `import * as Ref from "effect/Ref";` (line 21).

**(c) Log the overlay failure** (R1) — replace the silent catch:
```ts
// BEFORE
    const mcpOverlayResult = MCP_ENGINE_USE_OVERLAY
      ? yield* mcpOverlay.writeOverlay(thread.projectId).pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
// AFTER
    const mcpOverlayResult = MCP_ENGINE_USE_OVERLAY
      ? yield* mcpOverlay.writeOverlay(thread.projectId).pipe(
          Effect.catch((cause) =>
            Effect.logError("[mcp] overlay write failed — spawning without MCP overlay", {
              threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        )
      : null;
```

**(d) Record the fingerprint into the cache** (R2) — in `bindSessionToThread`:
```ts
// BEFORE
        if (currentOverlayFingerprint !== undefined) {
          yield* Ref.update(sessionOverlayFingerprintRef, (current) =>
            new Map(current).set(threadId, currentOverlayFingerprint),
          );
        }
// AFTER
        if (currentOverlayFingerprint !== undefined) {
          yield* Cache.set(sessionOverlayFingerprints, threadId, currentOverlayFingerprint);
        }
```

**(e) Read from the cache + treat an absent entry as changed** (R1+R2) — the reuse gate:
```ts
// BEFORE
      const spawnFingerprint = (yield* Ref.get(sessionOverlayFingerprintRef)).get(threadId);
      const overlayChanged =
        currentOverlayFingerprint !== undefined &&
        spawnFingerprint !== undefined &&
        spawnFingerprint !== currentOverlayFingerprint;
// AFTER
      const spawnFingerprint = Option.getOrUndefined(
        yield* Cache.getOption(sessionOverlayFingerprints, threadId),
      );
      const overlayChanged =
        currentOverlayFingerprint !== undefined && spawnFingerprint !== currentOverlayFingerprint;
```
**Why minimal:** reuses the exact `Cache` pattern + constants style already in the file; one log line; drops
one clause. No new abstraction.
**Risk:** none on the happy path — a recorded `spawnFingerprint === currentOverlayFingerprint` ⇒ still reuse.
A persistent overlay failure keeps `currentOverlayFingerprint === undefined` ⇒ first clause false ⇒ no respawn
loop (stays MCP-less but **logged**). Recovery + eviction both → one `resumeCursor` respawn (history preserved).
Memory bounded at ~3 MB (`10_000 × ~300 B`). `Option`/`Cache`/`Duration` already imported.
**Severity:** Medium-High. **Verify:** typecheck/lint; reason through the 3 cases (reuse / recover / persistent-fail).

### A2 · R3 — `deleteKeysNotIn([])` wipes the whole probe cache on an empty desired set
**File:** `apps/server/src/ru-fork/mcp/McpReactor.ts` (`reconcileNow`).
```ts
// BEFORE
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    yield* probeCache
      .deleteKeysNotIn([...liveConfigKeys])
      .pipe(
        Effect.catch((error) => Effect.logError("mcp reactor failed to GC probe cache", { error })),
      );
// AFTER
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    if (liveConfigKeys.size > 0) {
      yield* probeCache
        .deleteKeysNotIn([...liveConfigKeys])
        .pipe(
          Effect.catch((error) => Effect.logError("mcp reactor failed to GC probe cache", { error })),
        );
    }
```
**Why minimal:** one guard. Never run a delete-all on empty input; orphan rows are tiny and cleaned by the
next non-empty reconcile. **Risk:** if the user removes every server, a few stale cache rows linger (harmless,
keyed by `configKey`). **Severity:** Low-Medium. **Verify:** typecheck.

### A3 · R4 — in-flight probe slot can leak under interruption
**File:** `apps/server/src/ru-fork/mcp/McpSupervisor.ts` (`probeInstance`).
```ts
// BEFORE
  const probeInstance = (instance: SupervisorInstance) =>
    Effect.gen(function* () {
      const alreadyRunning = yield* claimInFlight(instance.hash);
      if (alreadyRunning) {
        return;
      }
      yield* publishChange;
      yield* runProbe(instance).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* releaseInFlight(instance.hash);
            yield* publishChange;
          }),
        ),
      );
    });
// AFTER  (claim+release bracketed; release always runs, even on interrupt)
  const probeInstance = (instance: SupervisorInstance) =>
    Effect.acquireUseRelease(
      claimInFlight(instance.hash),
      (alreadyRunning) =>
        alreadyRunning
          ? Effect.void
          : Effect.gen(function* () {
              yield* publishChange;
              yield* runProbe(instance);
            }),
      (alreadyRunning) =>
        alreadyRunning
          ? Effect.void
          : Effect.gen(function* () {
              yield* releaseInFlight(instance.hash);
              yield* publishChange;
            }),
    );
```
**Why minimal:** swaps the hand-rolled `claim … ensuring` for the proven `acquireUseRelease`; the acquire runs
uninterruptibly and the release is guaranteed. `claimInFlight` mutates only when it returns `false`, so
releasing only when `!alreadyRunning` is correct. **Risk:** none — identical behaviour, leak closed.
**Severity:** Low. **Verify:** typecheck; `supervisorDecisions.test.ts` is unaffected (pure helpers).

### A4 · R5 — projection stream dies on a transient repo error (runtime stream doesn't)
**File:** `apps/server/src/ru-fork/mcp/McpProjectionQuery.ts` (`changeSnapshots`).
```ts
// BEFORE
  const changeSnapshots: Stream.Stream<McpProjectionStreamEvent, McpError> =
    engine.streamDomainEvents.pipe(
      Stream.filter(isProjectionRelevant),
      Stream.mapEffect(() =>
        getSnapshot(null).pipe(
          Effect.map((snapshot): McpProjectionStreamEvent => ({ type: "snapshot", snapshot })),
        ),
      ),
    );
// AFTER  (a transient getSnapshot failure ⇒ drop THIS update, keep the stream alive)
  const changeSnapshots: Stream.Stream<McpProjectionStreamEvent, McpError> =
    engine.streamDomainEvents.pipe(
      Stream.filter(isProjectionRelevant),
      Stream.mapEffect(() =>
        getSnapshot(null).pipe(
          Effect.map((snapshot): McpProjectionStreamEvent | null => ({ type: "snapshot", snapshot })),
          Effect.catch(() => Effect.succeed(null)),
        ),
      ),
      Stream.filter((event): event is McpProjectionStreamEvent => event !== null),
    );
```
**Why minimal:** uses `Stream.filter` (already in this file) with its confirmed refinement overload; one blip
drops one update, the next event re-reads fresh — matching the runtime stream's resilience. No new imports.
**Risk:** none. **Severity:** Low-Medium. **Verify:** typecheck (the `: Stream<…, McpError>` annotation forces
the refinement to narrow — a non-narrowing build would fail loudly, not silently).

---

## Phase B — Dead-code removal & de-duplication (pure surface shrink, no behaviour)

### B1 — delete the two unused mcp-core functions
- `packages/mcp-core/src/resolver.ts`: delete `effectiveConfig`. (`McpCatalogServer` import stays — used by
  `effectiveTimeoutMs`; `McpServerConfig` stays — used by `resolveConfig`/`configCacheKey`.)
- `packages/mcp-core/src/toolPolicy.ts`: delete `pruneInertExceptions`. (`McpTool`/`McpToolPolicy` stay.)
**Verify:** typecheck (`export *`; nothing imports them — confirmed by grep).

### B2 — delete the two never-called repo methods (+ the now-orphaned input schema)
- `apps/server/src/persistence/Services/McpCatalog.ts`: remove `getById` from the interface **and** delete
  `GetCatalogServerInput` (its `Schema` + `type` on lines 9–10 — no other importer). Keep `RemoveCatalogServerInput`.
- `apps/server/src/persistence/Layers/ProjectionMcpCatalog.ts`: remove `GetCatalogServerInput` from the import,
  delete the `getRow` builder + the `getById` method, and remove the now-unused `import * as Option`.
- `apps/server/src/persistence/Services/McpProbeCache.ts`: remove `listAll` from the interface.
- `apps/server/src/persistence/Layers/ProjectionMcpProbeCache.ts`: delete the `listRows` builder + `listAll` method.
**Verify:** typecheck; grep `getById` / `probeCache` `listAll` ⇒ no hits.

### B3 — collapse the projection stream to snapshot-only
- `packages/contracts/src/ru-fork/mcp.ts`:
  ```ts
  // BEFORE: a 5-member Union (snapshot + catalog-upserted/removed + binding-upserted/removed)
  // AFTER
  export const McpProjectionStreamEvent = Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: McpSnapshot,
  });
  ```
- `apps/web/src/rpc/mcpState.ts` (`applyMcpProjectionEvent`): delete the 4 granular `case`s (keep `snapshot`),
  then delete the now-unused helpers `getCatalog`, `getBindings`, `sameBinding`. Body becomes the two
  `appAtomRegistry.set(...)` calls.
**Why minimal:** the server only ever emits `snapshot`; removes the unused alternative on both ends.
**Risk:** none — live path unchanged. **Verify:** server + web typecheck.

### B4 — trim the never-produced runtime-status values (both adapter switches)
- `packages/contracts/src/ru-fork/mcp.ts`:
  ```ts
  // BEFORE
  export const McpRuntimeStatus = Schema.Literals(["unchecked","connecting","online","degraded","offline","error"]);
  // AFTER
  export const McpRuntimeStatus = Schema.Literals(["unchecked","online","degraded","offline"]);
  ```
- `apps/web/src/ru-fork/mcp-manage/adapters.ts` · `runtimeStatusToUi`: delete `case "connecting":` (keep
  `case undefined: return "connecting"`) and delete `case "error":` (fold into `case "offline": return "error"`):
  ```ts
  // AFTER
    switch (status) {
      case "online":   return "connected";
      case "unchecked":return "unchecked";
      case undefined:  return "connecting"; // bound, but the monitor hasn't reported yet
      case "degraded": return "degraded";
      case "offline":  return "error";
    }
  ```
- `apps/web/src/ru-fork/mcp-manage/adapters.ts` · `runtimeDetail`: delete `case "connecting": return "Проверка…";`
  and delete the `case "error":` line (keep `case "offline":` with its `runtime.message ?? "Не удалось подключиться"`):
  ```ts
  // AFTER
    switch (runtime.status) {
      case "online":   return `Подключено · ${runtime.discoveredTools.length} инструментов`;
      case "unchecked":return "Не проверено — нажмите «Проверить»";
      case "degraded": return runtime.message ?? "Нестабильное соединение, повторная проверка…";
      case "offline":  return runtime.message ?? "Не удалось подключиться";
    }
  ```
- Leave the web's own `McpStatus` union (`types.ts`) untouched — `connecting`/`error` are valid *UI* states.
**Why minimal:** shrinks the contract enum to what the supervisor actually emits; both exhaustive switches then
type-check without the dead arms. **Risk:** none. **Verify:** server + web typecheck (exhaustiveness confirms).

### B5 — de-duplicate the FNV-1a hash
- `packages/mcp-core/src/resolver.ts`: add `export` to `function fnv1a` (already re-exported via `export *`).
- `apps/server/src/ru-fork/mcp/McpBuiltins.ts`:
  ```ts
  // BEFORE: inline FNV loop inside builtinHash
  // AFTER
  import { fnv1a } from "@ru-fork/mcp-core";
  export function builtinHash(config: McpServerConfig, definition: McpBuiltinDefinition): string {
    return fnv1a(
      JSON.stringify({
        name: definition.name,
        description: definition.description ?? null,
        config,
        vars: builtinShippedVars(definition),
        timeoutMs: definition.timeoutMs ?? null,
      }),
    );
  }
  ```
**Why minimal:** one export + one import; removes the second copy that could drift. Same algorithm + same
canonical JSON ⇒ byte-identical hashes. **Risk:** none — `builtins.test.ts` hash-stability cases confirm.
**Verify:** `test:fast` (builtins.test.ts).

---

## Phase C — Hygiene (no behaviour)

### C1 — fix the three contradictory/stale comments  ·  doc-only (but High-misleading)
- `McpSupervisor.ts` `isSweepDue` JSDoc → "a NEVER-checked instance is never auto-probed (no probing on load);
  its first probe comes only from a manual recheck or a config-affecting change" (replaces the "mandatory first
  probe" block). (AUDIT A1)
- `settings.ts` `mcp` block → drop the "after the mandatory first probe"/"after the first probe" wording;
  say "0 = that transport never auto re-checks". (AUDIT A2)
- `resolver.ts` `missingRequiredVars` doc → "required vars at ANY level … catalog-level ⇒ catalog incomplete;
  per-project ⇒ binding incomplete" (drop "per-project"). (AUDIT A3)
**Risk:** none (comments). **Verify:** read-through.

### C2 — `serverById` map in the secret GC  ·  Low (DRY)
**File:** `apps/server/src/ru-fork/mcp/McpReactor.ts` (`gcOrphanedSecrets`).
```ts
// BEFORE  (inside the bindings loop)
      const server = catalog.find((entry) => entry.id === binding.serverId);
      if (!server) {
        continue;
      }
// AFTER  (build the map once before the loop — matches computeDesired)
  const serverById = new Map(catalog.map((server) => [server.id, server]));
  …
      const server = serverById.get(binding.serverId);
      if (!server) {
        continue;
      }
```
**Risk:** none. **Verify:** typecheck.

### C3 (optional) — repoint load-bearing comments from `legacy/` anchors to `mcp-specs/current/`
When touching `McpReactor.start` / `ProviderCommandReactor` overlay comments, repoint `§D8`/`AMEND-1` refs to
`WORKING-LOGIC.md §5/§12`. Opportunistic; lowest priority.

---

## Deliberately NOT changing (verified, and a change would be a net negative)

- **`resolver.canonicalize`'s `value as Record<string, unknown>` cast (AUDIT E).** The "obvious" de-cast
  (`Object.entries(value).toSorted(...)`) is **rejected**: (1) `Object.entries` over `object` yields **`any`**
  values (looser than the current `unknown`), and (2) any non-default comparator (e.g. `localeCompare`) would
  **change key ordering and therefore every hash** (`configCacheKey`/`dedupHash`/`overlayFingerprint`/`builtinHash`),
  silently invalidating the probe cache. The existing cast is a documented JSON-walk — the same justified-cast
  category as `probe.ts`'s `as Transport`. **Leave it.**
- **The web `McpStatus` union's `connecting`/`error` (B4 scope).** These are *UI-computed* states (the adapter
  maps "bound, no runtime yet" → `connecting`, and `offline` → `error`) and are reachable. Only the *contract*
  enum shrinks.

---

## Execution checklist

```
[ ] Phase A  R1+R2 (one edit) · R3 · R4 · R5      → typecheck/lint/test:fast green; reason through R1's 3 cases
[ ] Phase B  B1 · B2 · B3 · B4 · B5                → typecheck/lint/test:fast green (B5 watch builtins.test.ts)
[ ] Phase C  C1 (comments) · C2 · C3(opt)          → typecheck/lint/test:fast green
[ ] Final    full pnpm typecheck 10/10 · lint 0/0 · test:fast (only the 4 baseline bin.test.ts)
```

**Behaviour that changes — all failure-path, all intended:** R1 (no-overlay session recovers + the failure is
logged), R3 (empty desired no longer wipes the cache), R4 (no slot leak on interrupt), R5 (projection stream
survives a transient blip). Everything in B and C is non-behavioural. **No remaining unknowns** — every `AFTER`
block uses an API confirmed present in `effect@4.0.0-beta.59` and already used in this codebase.
