# MCP final plan — monitoring redesign, startup race, secret/lifecycle GC, secret-edit UX

> **Contract of this document.** Every change below is specified as an exact edit (BEFORE → AFTER)
> or a full new-file body, with the precise imports each file gains. During implementation **only
> code that appears here may enter the codebase.** If implementation reveals a needed import or line
> that is not in this plan, that is a **STOP** — the plan gets amended and re-approved first, never
> silently patched. No item is deferred; all of items 1–14 are fully specified here.
>
> Worktree: `/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code/.claude/worktrees/mcp`
> (branch `ru-code`). Gates after implementation: `pnpm typecheck` (10/10), `pnpm lint` (0/0),
> `pnpm test:fast` (only the 4 preexisting `bin.test.ts`). Web has no test target (typecheck+lint).

---

## REVISION 2 — locked decisions (authoritative; supersedes conflicting earlier parts)

> The design grew during review. This block is the source of truth for every decision; the exact
> BEFORE→AFTER edits for the NEW pieces (PART K + amendments) are expanded below the original
> PART A–J. Where a decision here conflicts with an original part, **this block wins** and that part
> is marked SUPERSEDED in its place.

### Decisions locked
- **D-mon (monitoring).** Loop is opt-in: both recheck intervals = 0 ⇒ sweep never runs. **No probing
  on load** (drop mandatory-first-probe). Never-probed-and-uncached ⇒ status `"unchecked"` («не
  проверено», neutral). In-flight probe ⇒ `checking:true` («проверка…»). **Edit locked while a check
  runs.** Incomplete servers are never probed. (Items 1,2,4,5,6,7 — PART A/C/G as written, kept.)
- **D-change.** A config/vars edit force-probes **only the hashes that actually changed** (cosmetic
  edits probe nothing). (Item 3 — PART C/D, kept.)
- **D-restart (REPLACES the active-restart model).** No active teardown. At the **turn-start gate**
  (`ProviderCommandReactor.ts:573-594`) add `overlayChanged` next to `cwdChanged`/`instanceChanged`:
  `overlayChanged = currentOverlayFingerprint !== fingerprintThisSessionSpawnedWith` → re-spawn with
  `resumeCursor` on the next turn (history preserved). The fingerprint already subsumes
  `allowedMcpServers` (removing a project MCP changes it). **SUPERSEDES PART E entirely** and **drops
  the `McpOverlayState` service (E1/E2/E4) and the reactor's `syncOverlaysAndRestart`/`restartThread`/
  `liveThreadsByProject` (PART D's restart pieces).** Per-thread spawn fingerprint kept in an
  in-memory `Map<threadId,string>` in `ProviderCommandReactor` (a live qwen process doesn't survive a
  server restart, so the map's lifetime is correct; no contract/schema change). Items **8 & 9 dissolve**
  (a first turn that ever spawns on a not-yet-hydrated/empty overlay self-heals on the next turn).
- **D-warn (REPLACES the two-click banner).** Warn-on-impact = a **centered `AlertDialog`** (existing
  `~/components/ui/alert-dialog`) listing **affected projects by name**, Отмена / Применить. base-ui
  nests dialogs first-class (`--nested-dialogs`), so modal-over-modal is fine. **SUPERSEDES G11's
  banner**; `describeEditImpact` returns structured data (per-removed-var → project names; new-required
  → project names) instead of a string; needs `useMcpProjects()` for names.
- **D-noprobe-seed.** No auto-probe ever, including on seed: seed/migrator reconciles enqueue
  `eager:false`. (Item 4 confirmed; **SUPERSEDES D5's note** that seeded complete builtins may probe.)
- **D-no-global-recheck.** No global «Проверить всё» button (J6 dropped). Per-server + per-row recheck
  only; the panel-header button stays project-scoped as today.
- **D-builtins (managed templates — NEW, PART K).** Built-ins ship from a prebuild TS file as managed
  **templates** with a **locked command** + declared vars + per-platform variants. A startup
  **migrator** reconciles shipped defs vs installed by `builtinId` + `builtinHash` (auto content-hash
  of shipped parts only): add / update (3-way merge) / remove (cascade bindings + secret GC).
  **Templates never detach** — removing a def removes it from the catalog and all projects.
  Unsupported platform (no variant for `process.platform`) ⇒ **skip** (don't seed). **REPLACES
  `McpDefaults.ts` + `seedBuiltinsIfEmpty` and the fork-to-custom concept.**
- **D-config-model (NEW deltas to PART A).**
  - `required` is widened to "must resolve to a non-empty value" at **any** level (not only
    `perProject`). A catalog-level required var with no value ⇒ the **catalog tile** shows «требует
    настройки»; the user sets it on the catalog server (no fork). `missingRequiredVars` +
    `catalogMissingVars` learn catalog-level required vars.
  - `McpServerVar` / `McpServerVarDraft` gain `origin: "shipped" | "user"`. Migrator replaces
    `shipped` declarations, preserves `user` vars + all var **values** by name. Manual servers: all
    vars `origin:"user"`.
  - `McpCatalogServer` gains `builtinId: string|null`, `builtinHash: string|null`, `locked: boolean`,
    `extraArgs: ReadonlyArray<string>` (user-appendable args with `${VAR}` holes — **catalog-level/
    shared scope for now**; per-project extraArgs is a future add).
  - Resolver: `resolvedArgs = config.args (locked) + extraArgs`. **`extraArgs` flows into
    `configCacheKey` + `overlayFingerprint`** so changing it resets status to «не проверено» and
    re-spawns the session, exactly like a template update. (Updating a template changes the configKey
    ⇒ status auto-resets — free.)
  - Manual (custom) servers: fully-editable command, `locked:false`, `extraArgs` empty, `builtinId`
    null. Project level is already vars-only for both (binding = varValues; the original identity-lock).
- **D-fork-removed.** The decider no longer forks `builtin → custom` on edit. Templates are permanently
  managed; configuring (var values / extraArgs / user vars) never bumps `builtinId`/`builtinHash`;
  changing a locked command or a `shipped` var declaration is rejected. **SUPERSEDES the
  `source:"builtin"→"custom"` line in `applyServerUpdate` (PART F context).**

### What stays exactly as written in PART A–J (not superseded)
Items 1,2,4,5,6,7 monitoring (PART A status/checking + C supervisor + C7 McpRuntime + G statuses/lock),
item 3 change-probe (C3/C4/D1/D2/D5 — except D5's seed note → `eager:false`), item 10 secret GC
(PART B + D3), item 11 varValues prune (A5 + D4 + F4/F5), items 13/14 keep-secret + SecretField
(A4/A5 + F2/F3 + G), the tests (PART H), gates (PART I).

### Migration `031_Mcp.ts` — new columns (single migration, edited in place)
`mcp_catalog_server` adds: `builtin_id TEXT`, `builtin_hash TEXT`, `locked INTEGER NOT NULL DEFAULT 0`,
`extra_args_json TEXT NOT NULL DEFAULT '[]'`. `vars_json` rows now include `origin`. Projection
`ProjectionMcpCatalog.ts` upsert/select + `McpCatalogServerDbRow` extend accordingly. (Exact
before/after in PART K.)

> **Next:** expand PART K (prebuild file format, `McpBuiltinDefinition`, the migrator algorithm with
> 3-way merge, per-platform resolution, decider builtin-sync path, contract/migration/projection/
> resolver/fingerprint/web-template-editor edits) as exact BEFORE→AFTER, and apply the SUPERSEDES
> markers in PART A/D/E/F/G. This is the remaining authoring step before implementation.

---

## 0. Scope → the 14 requirements

| # | Requirement | Implemented in PART(s) |
|---|---|---|
| 1 | Both recheck intervals = 0 ⇒ sweep loop fully off | C |
| 2 | No probing on load (remove mandatory-first-probe; show cached-or-"не проверено") | C, A |
| 3 | Change-driven force-recheck when config/vars actually change (not cosmetic) | C, D |
| 4 | "Не проверено" neutral status for never-probed servers | A, C, G |
| 5 | UI live "проверка…" whenever a probe is in flight (edit-save / manual / loop) | A, C, G |
| 6 | Edit locked while a check runs | G |
| 7 | Never probe incomplete servers (required vars unfilled → «требует настройки») | C(existing) + G |
| 8 | Session spawns with empty/stale overlay before MCP state hydrates | E |
| 9 | "First sight ⇒ record only" suppresses restart of a stale live session | E |
| 10 | Secret-store GC of orphaned var secrets | B, D |
| 11 | Orphaned `varValues` auto-prune | A, D, F |
| 12 | Catalog-edit warn-on-impact | G |
| 13 | "Keep existing secret" signal so edits don't wipe untouched secrets | A, F, G |
| 14 | `SecretField` UI states (saved / needs-value / editing; rename → red) | A, G |

> **Status-model note (foundation for 2/4/5/7).** Today a never-probed instance is registered as
> `status:"connecting"` and the sweep force-probes it once ("mandatory first"). After this plan a
> never-probed-and-uncached instance is `status:"unchecked"` and is **never** auto-probed; a probe is
> only ever started by (a) manual recheck, (b) a config-affecting change, or (c) the interval sweep on
> an already-probed instance in the watched project. "In flight" is a separate `checking` boolean so a
> server can be "online **and** re-checking" without losing its last status.

---

## PART A — Contracts (`packages/contracts/src/ru-fork/mcp.ts`)

### A1. `McpRuntimeStatus` gains `"unchecked"`

BEFORE (lines 161-168):
```ts
export const McpRuntimeStatus = Schema.Literals([
  "connecting",
  "online",
  "degraded",
  "offline",
  "error",
]);
export type McpRuntimeStatus = typeof McpRuntimeStatus.Type;
```
AFTER:
```ts
export const McpRuntimeStatus = Schema.Literals([
  "unchecked", // never probed and no cache row — idle, awaiting a manual/change-driven probe
  "connecting",
  "online",
  "degraded",
  "offline",
  "error",
]);
export type McpRuntimeStatus = typeof McpRuntimeStatus.Type;
```

### A2. `McpRuntimeSnapshot` gains `checking`

BEFORE (lines 170-180):
```ts
export const McpRuntimeSnapshot = Schema.Struct({
  projectId: ProjectId,
  serverId: McpServerId,
  status: McpRuntimeStatus,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  effectiveAllowedTools: Schema.Array(TrimmedNonEmptyString),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpRuntimeSnapshot = typeof McpRuntimeSnapshot.Type;
```
AFTER (add one field after `status`):
```ts
export const McpRuntimeSnapshot = Schema.Struct({
  projectId: ProjectId,
  serverId: McpServerId,
  status: McpRuntimeStatus,
  // true while a probe of this instance is in flight (sweep / manual / change-driven),
  // independent of `status` so the UI can show «проверка…» without losing the last result.
  checking: Schema.Boolean,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  effectiveAllowedTools: Schema.Array(TrimmedNonEmptyString),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpRuntimeSnapshot = typeof McpRuntimeSnapshot.Type;
```

### A3. `McpCatalogRuntimeSnapshot` gains `checking`

BEFORE (lines 185-193):
```ts
export const McpCatalogRuntimeSnapshot = Schema.Struct({
  serverId: McpServerId,
  status: McpRuntimeStatus,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpCatalogRuntimeSnapshot = typeof McpCatalogRuntimeSnapshot.Type;
```
AFTER:
```ts
export const McpCatalogRuntimeSnapshot = Schema.Struct({
  serverId: McpServerId,
  status: McpRuntimeStatus,
  checking: Schema.Boolean,
  message: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Int),
  discoveredTools: Schema.Array(McpTool),
  checkedAt: Schema.optional(IsoDateTime),
});
export type McpCatalogRuntimeSnapshot = typeof McpCatalogRuntimeSnapshot.Type;
```

### A4. `McpServerVarDraft` gains `keepSecret` (item 13)

BEFORE (lines 73-80):
```ts
export const McpServerVarDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  required: Schema.Boolean,
  value: Schema.NullOr(Schema.String),
});
export type McpServerVarDraft = typeof McpServerVarDraft.Type;
```
AFTER (add `keepSecret`):
```ts
export const McpServerVarDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  required: Schema.Boolean,
  value: Schema.NullOr(Schema.String),
  // ru-fork: when true for a secret var, the decider PRESERVES the server's existing stored
  // secret ref instead of re-splitting `value` — so editing other fields doesn't wipe a secret
  // the client never had in plaintext. Ignored for non-secret vars / on add (no existing ref).
  keepSecret: Schema.optionalKey(Schema.Boolean),
});
export type McpServerVarDraft = typeof McpServerVarDraft.Type;
```

### A5. `McpBindingPatch` gains `keepVarValues` (item 13, per-project secrets)

BEFORE (lines 221-227):
```ts
export const McpBindingPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  toolPolicy: Schema.optionalKey(McpToolPolicy),
  varValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
export type McpBindingPatch = typeof McpBindingPatch.Type;
```
AFTER:
```ts
export const McpBindingPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  toolPolicy: Schema.optionalKey(McpToolPolicy),
  varValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // ru-fork: per-project secret var names whose stored ref must be PRESERVED (the client left the
  // masked field untouched). Names here are kept from the existing binding even though they are
  // absent from / blank in `varValues`. See decider `resolveBindingVarValues`.
  keepVarValues: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
export type McpBindingPatch = typeof McpBindingPatch.Type;
```

> No new event/command is needed for item 11 — see PART F4: orphaned-`varValues` pruning rides the
> existing `mcp.binding-set` event by emitting it from the reactor with a ref-preserving filtered map.

---

## PART B — Secret store prune API (item 10)

### B1. `ServerSecretStoreShape` gains `pruneByPrefix`
File `apps/server/src/auth/Services/ServerSecretStore.ts`.

BEFORE (interface body):
```ts
export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}
```
AFTER (add `pruneByPrefix`):
```ts
export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  /**
   * Remove every stored secret whose name starts with `prefix` and is NOT in `keep`.
   * Used to GC orphaned MCP var secrets (sibling of the probe-cache `deleteKeysNotIn`).
   * A missing store directory / individual removal error is swallowed (best-effort GC).
   */
  readonly pruneByPrefix: (
    prefix: string,
    keep: ReadonlySet<string>,
  ) => Effect.Effect<void, SecretStoreError>;
}
```

### B2. `makeServerSecretStore` implements `pruneByPrefix`
File `apps/server/src/auth/Layers/ServerSecretStore.ts`. The file already binds `fileSystem`, `path`,
`serverConfig`, and `resolveSecretPath`. Add the implementation **immediately before the final
`return { ... } satisfies ServerSecretStoreShape;`** and add it to the returned object.

New function (insert before the return):
```ts
  const pruneByPrefix: ServerSecretStoreShape["pruneByPrefix"] = (prefix, keep) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem.readDirectory(serverConfig.secretsDir).pipe(
        Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
      );
      for (const entry of entries) {
        if (!entry.endsWith(".bin")) {
          continue;
        }
        const name = entry.slice(0, -".bin".length);
        if (!name.startsWith(prefix) || keep.has(name)) {
          continue;
        }
        yield* fileSystem.remove(path.join(serverConfig.secretsDir, entry)).pipe(Effect.ignore);
      }
    }).pipe(
      Effect.catch(
        (cause) =>
          new SecretStoreError({ message: `Failed to prune secrets for prefix ${prefix}.`, cause }),
      ),
    );
```
Return-object change — BEFORE (the existing returned object's closing; the exact current tail returns
`{ get, set, getOrCreateRandom, remove }` — verify and append `pruneByPrefix`):
```ts
  return { get, set, getOrCreateRandom, remove } satisfies ServerSecretStoreShape;
```
AFTER:
```ts
  return { get, set, getOrCreateRandom, remove, pruneByPrefix } satisfies ServerSecretStoreShape;
```
> Imports: none added — `fileSystem.readDirectory`/`remove`, `path.join`, `Effect` are already in scope.
> **Plan-verification note during impl:** confirm the exact current `return {…}` names; if the tail
> differs from the BEFORE above, that is a STOP (amend plan).

---

## PART C — Supervisor (`apps/server/src/ru-fork/mcp/McpSupervisor.ts`) — items 1,2,3,4,5

### C1. Remove the mandatory-first-probe (item 2)
`isSweepDue` BEFORE (lines 102-116):
```ts
export function isSweepDue(
  instance: SupervisorInstance,
  watched: ReadonlySet<string> | null,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  if (instance.checkedAtMs === null) {
    return true;
  }
  if (watched !== null && !instanceInWatched(instance, watched)) {
    return false;
  }
  return isProbeDue(instance, nowMs, localIntervalMs, remoteIntervalMs);
}
```
AFTER (never-probed is NOT auto-due; only watched + interval drive the sweep):
```ts
export function isSweepDue(
  instance: SupervisorInstance,
  watched: ReadonlySet<string> | null,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  // A never-probed instance is NEVER auto-probed (no probing on load) — its first probe comes
  // only from a manual recheck or a config-affecting change (reactor `probeHashes`). The sweep
  // re-checks ONLY already-probed instances of the watched project, on their transport interval.
  if (instance.checkedAtMs === null) {
    return false;
  }
  if (watched !== null && !instanceInWatched(instance, watched)) {
    return false;
  }
  return isProbeDue(instance, nowMs, localIntervalMs, remoteIntervalMs);
}
```
`isProbeDue` BEFORE (lines 150-164):
```ts
export function isProbeDue(
  instance: SupervisorInstance,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  if (instance.checkedAtMs === null) {
    return true;
  }
  const intervalMs = instance.resolved.transport === "stdio" ? localIntervalMs : remoteIntervalMs;
  if (intervalMs <= 0) {
    return false;
  }
  return nowMs - instance.checkedAtMs >= intervalMs;
}
```
AFTER:
```ts
export function isProbeDue(
  instance: SupervisorInstance,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  if (instance.checkedAtMs === null) {
    return false; // never probed ⇒ not auto-due (probe only on manual / config change)
  }
  const intervalMs = instance.resolved.transport === "stdio" ? localIntervalMs : remoteIntervalMs;
  if (intervalMs <= 0) {
    return false;
  }
  return nowMs - instance.checkedAtMs >= intervalMs;
}
```

### C2. New-and-uncached instances register as `"unchecked"` (item 4)
`reconcile` BEFORE — the no-seed branch (lines 286-298):
```ts
            : {
                hash,
                configKey: desiredInstance.configKey,
                resolved: desiredInstance.resolved,
                refs: desiredInstance.refs,
                status: "connecting",
                message: null,
                latencyMs: null,
                checkedAt: null,
                checkedAtMs: null,
                discoveredTools: [],
                consecutiveFailures: 0,
              },
```
AFTER (status `"unchecked"`):
```ts
            : {
                hash,
                configKey: desiredInstance.configKey,
                resolved: desiredInstance.resolved,
                refs: desiredInstance.refs,
                status: "unchecked",
                message: null,
                latencyMs: null,
                checkedAt: null,
                checkedAtMs: null,
                discoveredTools: [],
                consecutiveFailures: 0,
              },
```

### C3. `reconcile` returns the set of newly-added hashes (feeds item 3)
Change the shape type + the implementation so the reactor can probe only the just-appeared instances.

`McpSupervisorShape.reconcile` type BEFORE (line 175):
```ts
  readonly reconcile: (desired: ReadonlyMap<string, DesiredInstance>) => Effect.Effect<void>;
```
AFTER:
```ts
  /** Returns the hashes that were newly added by this reconcile (not previously registered). */
  readonly reconcile: (
    desired: ReadonlyMap<string, DesiredInstance>,
  ) => Effect.Effect<ReadonlyArray<string>>;
```
`reconcile` impl — BEFORE the tail (lines 300-303):
```ts
      yield* Ref.set(registryRef, next);
      yield* publishChange;
    });
```
AFTER (compute + return added hashes):
```ts
      yield* Ref.set(registryRef, next);
      yield* publishChange;
      // Hashes present now but absent from the prior registry — brand-new instances or
      // configs whose key just changed (an edit mints a new hash). The reactor force-probes
      // these when the reconcile was triggered by a config-affecting change (item 3).
      return [...next.keys()].filter((hash) => !current.has(hash));
    });
```

### C4. `probeHashes` — force-probe a specific set now (feeds item 3)
Add to `McpSupervisorShape` (after `recheck`, line 187):
```ts
  /** Force a probe NOW of the live instances with these hashes (config-change driven). */
  readonly probeHashes: (hashes: ReadonlyArray<string>) => Effect.Effect<void>;
```
Add the implementation after `recheck` (the existing `recheck` ends at line 402). Insert:
```ts
  const probeHashes: McpSupervisorShape["probeHashes"] = (hashes) =>
    Effect.gen(function* () {
      if (hashes.length === 0) {
        return;
      }
      const registry = yield* Ref.get(registryRef);
      const matched = hashes
        .map((hash) => registry.get(hash))
        .filter((instance): instance is SupervisorInstance => instance !== undefined);
      yield* Effect.forEach(matched, probeInstance, { concurrency: 4, discard: true });
    });
```
Add `probeHashes` to the returned object — BEFORE (lines 437-444):
```ts
  return {
    reconcile,
    setWatchedProjects,
    recheck,
    currentInstances,
    changes: Stream.fromPubSub(changesPubSub),
    start,
  } satisfies McpSupervisorShape;
```
AFTER:
```ts
  return {
    reconcile,
    setWatchedProjects,
    recheck,
    probeHashes,
    currentInstances,
    currentInFlight,
    changes: Stream.fromPubSub(changesPubSub),
    start,
  } satisfies McpSupervisorShape;
```

### C5. Surface in-flight hashes + publish on probe START (item 5)
The runtime stream must reflect "проверка…" the moment a probe starts.

Add to `McpSupervisorShape` (after `currentInstances`, line 188):
```ts
  /** Hashes with a probe currently in flight — drives the UI «проверка…» indicator. */
  readonly currentInFlight: Effect.Effect<ReadonlySet<string>>;
```
Add the accessor next to `currentInstances` (line 428-430) — BEFORE:
```ts
  const currentInstances: McpSupervisorShape["currentInstances"] = Ref.get(registryRef).pipe(
    Effect.map((registry) => [...registry.values()]),
  );
```
AFTER (append the in-flight accessor):
```ts
  const currentInstances: McpSupervisorShape["currentInstances"] = Ref.get(registryRef).pipe(
    Effect.map((registry) => [...registry.values()]),
  );

  const currentInFlight: McpSupervisorShape["currentInFlight"] = Ref.get(inFlightRef);
```
Publish a change when a probe is claimed so the UI flips to «проверка…» immediately.
`probeInstance` BEFORE (lines 387-394):
```ts
  const probeInstance = (instance: SupervisorInstance) =>
    Effect.gen(function* () {
      const alreadyRunning = yield* claimInFlight(instance.hash);
      if (alreadyRunning) {
        return; // another fiber is already probing this exact config
      }
      yield* runProbe(instance).pipe(Effect.ensuring(releaseInFlight(instance.hash)));
    });
```
AFTER (publish on claim AND on release, so both edges reach the stream):
```ts
  const probeInstance = (instance: SupervisorInstance) =>
    Effect.gen(function* () {
      const alreadyRunning = yield* claimInFlight(instance.hash);
      if (alreadyRunning) {
        return; // another fiber is already probing this exact config
      }
      yield* publishChange; // flip UI to «проверка…» the instant the probe starts
      yield* runProbe(instance).pipe(
        Effect.ensuring(releaseInFlight(instance.hash).pipe(Effect.zipRight(publishChange))),
      );
    });
```
> `publishChange` is already defined (line 230); `claimInFlight`/`releaseInFlight`/`runProbe` exist.
> Imports: none added.

### C6. Both intervals 0 ⇒ sweep is a no-op (item 1)
`runSweep` BEFORE (lines 404-426):
```ts
  const runSweep = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const instances = [...(yield* Ref.get(registryRef)).values()];
    if (settings === null || instances.length === 0) {
      return; // can't read cadence, or nothing to probe — keep last status
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const watched = yield* Ref.get(watchedProjectsRef);
    const localIntervalMs = settings.mcp.recheckLocalMinutes * MINUTE_MS;
    const remoteIntervalMs = settings.mcp.recheckRemoteMinutes * MINUTE_MS;
    // The loop ticks every 60s but probes only what's due — this is what stops
    // the `npx` spam (see `isSweepDue` for the mandatory-first / watched rules).
    const due = instances.filter((instance) =>
      isSweepDue(instance, watched, nowMs, localIntervalMs, remoteIntervalMs),
    );
    if (due.length === 0) {
      return;
    }
    yield* Effect.logDebug("[mcp] sweep", { due: due.length, total: instances.length });
    yield* Effect.forEach(due, probeInstance, { concurrency: 4, discard: true });
  });
```
AFTER (explicit early-out when both intervals are off ⇒ the loop does nothing):
```ts
  const runSweep = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const instances = [...(yield* Ref.get(registryRef)).values()];
    if (settings === null || instances.length === 0) {
      return; // can't read cadence, or nothing to probe — keep last status
    }
    const localIntervalMs = settings.mcp.recheckLocalMinutes * MINUTE_MS;
    const remoteIntervalMs = settings.mcp.recheckRemoteMinutes * MINUTE_MS;
    // Both intervals 0 ⇒ no periodic re-checking at all: the loop is off. The first probe of any
    // server then comes only from a manual recheck or a config-affecting change.
    if (localIntervalMs <= 0 && remoteIntervalMs <= 0) {
      return;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const watched = yield* Ref.get(watchedProjectsRef);
    // The loop ticks every 60s but probes only what's due (watched project + elapsed interval;
    // never-probed instances are excluded — see `isSweepDue`).
    const due = instances.filter((instance) =>
      isSweepDue(instance, watched, nowMs, localIntervalMs, remoteIntervalMs),
    );
    if (due.length === 0) {
      return;
    }
    yield* Effect.logDebug("[mcp] sweep", { due: due.length, total: instances.length });
    yield* Effect.forEach(due, probeInstance, { concurrency: 4, discard: true });
  });
```

### C7. `McpRuntime` populates `checking` on both snapshot kinds (item 5)
File `apps/server/src/ru-fork/mcp/McpRuntime.ts`. The snapshots now require `checking: boolean`
(A2/A3). Read `supervisor.currentInFlight` once per snapshot and set `checking` per row by hash.

Read the in-flight set — BEFORE (the head of `currentSnapshot`, lines 45-48):
```ts
  }> = Effect.gen(function* () {
    const instances = yield* supervisor.currentInstances;
    const bindings = yield* bindingRepository.listAll();
    const catalog = yield* catalogRepository.listAll();
```
AFTER:
```ts
  }> = Effect.gen(function* () {
    const instances = yield* supervisor.currentInstances;
    const inFlight = yield* supervisor.currentInFlight;
    const bindings = yield* bindingRepository.listAll();
    const catalog = yield* catalogRepository.listAll();
```
Binding row — BEFORE (lines 68-77):
```ts
      runtimes.push({
        projectId: binding.projectId,
        serverId: binding.serverId,
        status: instance.status,
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
        effectiveAllowedTools: effectiveAllowedTools(binding.toolPolicy, instance.discoveredTools),
      });
```
AFTER (add `checking`):
```ts
      runtimes.push({
        projectId: binding.projectId,
        serverId: binding.serverId,
        status: instance.status,
        checking: inFlight.has(instance.hash),
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
        effectiveAllowedTools: effectiveAllowedTools(binding.toolPolicy, instance.discoveredTools),
      });
```
Catalog row — BEFORE (lines 86-93):
```ts
      catalogRuntimes.push({
        serverId: server.id,
        status: instance.status,
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
      });
```
AFTER:
```ts
      catalogRuntimes.push({
        serverId: server.id,
        status: instance.status,
        checking: inFlight.has(instance.hash),
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
      });
```
> No new import (`supervisor` is bound at line 38). The probe-START `publishChange` (C5) makes the
> `supervisor.changes` stream fire when `inFlight` gains a hash, so the debounced snapshot re-runs
> and `checking:true` reaches the client within `RUNTIME_DEBOUNCE` (200ms).

---

## PART D — Reactor (`apps/server/src/ru-fork/mcp/McpReactor.ts`) — items 3, 9, 10, 11

### D1. `ReactorSignal` carries an `eager` flag for config-driven probing (item 3)
BEFORE (lines 64-72):
```ts
/** What the worker was woken for: a plain reconcile, or a new project to autobind. */
type ReactorSignal =
  | { readonly kind: "reconcile" }
  | { readonly kind: "project-created"; readonly projectId: ProjectId };

const isReconcileRelevant = (event: OrchestrationEvent): boolean =>
  event.type.startsWith("mcp.") ||
  event.type === "project.deleted" ||
  event.type === "project.meta-updated";
```
AFTER (`reconcile` gains `eager`; project-created carries it implicitly as eager):
```ts
/**
 * What the worker was woken for. `eager` reconciles force-probe newly-appeared instances
 * (a config-affecting change happened); the startup/hydrate reconcile is NOT eager (item 2 —
 * no probing on load). A `project-created` always reconciles eagerly after autobinding.
 */
type ReactorSignal =
  | { readonly kind: "reconcile"; readonly eager: boolean }
  | { readonly kind: "project-created"; readonly projectId: ProjectId };

const isReconcileRelevant = (event: OrchestrationEvent): boolean =>
  event.type.startsWith("mcp.") ||
  event.type === "project.deleted" ||
  event.type === "project.meta-updated";
```

### D2. `reconcileNow` returns its added hashes; `processSignal` force-probes on eager
`reconcileNow` BEFORE (lines 169-191) — change the success path to return the added hashes from
`supervisor.reconcile`, and the catch to return `[]`:
```ts
  const reconcileNow = Effect.gen(function* () {
    const desired = yield* computeDesired;
    yield* supervisor.reconcile(desired);
    // GC: drop persisted cache rows whose authored config no longer exists in the
    // live desired set (catalog default removed / override changed or dropped).
    // This only runs when computeDesired fully SUCCEEDED (a failed/partial read
    // throws and is caught below, skipping GC), so an empty liveConfigKeys means a
    // genuinely empty authored set — clearing the cache then is intentional.
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    yield* probeCache
      .deleteKeysNotIn([...liveConfigKeys])
      .pipe(
        Effect.catch((error) =>
          Effect.logError("mcp reactor failed to GC probe cache", { error }),
        ),
      );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to reconcile desired instances", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
```
AFTER (returns `ReadonlyArray<string>`; also runs the secret GC — D3 — and varValues prune — D4):
```ts
  const reconcileNow: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
    const desired = yield* computeDesired;
    const added = yield* supervisor.reconcile(desired);
    // GC: drop persisted cache rows whose authored config no longer exists in the
    // live desired set (catalog default removed / override changed or dropped).
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    yield* probeCache
      .deleteKeysNotIn([...liveConfigKeys])
      .pipe(
        Effect.catch((error) =>
          Effect.logError("mcp reactor failed to GC probe cache", { error }),
        ),
      );
    yield* gcOrphanedSecrets; // item 10 — prune secret .bin files no longer referenced
    return added;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("mcp reactor failed to reconcile desired instances", {
          cause: Cause.pretty(cause),
        });
        const empty: ReadonlyArray<string> = [];
        return empty; // cast-free: a failed reconcile added nothing to probe
      }),
    ),
  );
```
`processSignal` BEFORE (lines 361-368):
```ts
  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* reconcileNow;
      yield* syncOverlaysAndRestart;
    });
```
AFTER (force-probe added hashes when eager / project-created):
```ts
  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eager = signal.kind === "project-created" ? true : signal.eager;
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* pruneOrphanedVarValues; // item 11 — emit binding-set to drop stranded var values
      const added = yield* reconcileNow;
      if (eager) {
        // A config-affecting change (or new project) just landed — probe the newly-appeared
        // instances NOW instead of waiting for the sweep (item 3). Cosmetic edits add nothing.
        yield* supervisor.probeHashes(added);
      }
      yield* syncOverlaysAndRestart;
    });
```

### D3. Secret-store GC step (item 10)
Add the `gcOrphanedSecrets` effect inside `make` (place it just before `reconcileNow`). It computes the
set of secret refs referenced by the catalog defaults **and** every binding, then prunes the store.

New code (insert before `const reconcileNow`):
```ts
  // item 10: prune secret .bin files no longer referenced by any catalog var or binding value.
  // Mirrors the probe-cache GC. Secret ref-names use the `mcp-var-` prefix (see McpSecretNames).
  const gcOrphanedSecrets = Effect.gen(function* () {
    const catalog = yield* catalogRepository.listAll();
    const bindings = yield* bindingRepository.listAll();
    const live = new Set<string>();
    for (const server of catalog) {
      for (const ref of collectVarSecretRefs(server.vars, {})) {
        live.add(ref);
      }
    }
    for (const binding of bindings) {
      const server = catalog.find((entry) => entry.id === binding.serverId);
      if (!server) {
        continue;
      }
      for (const ref of collectVarSecretRefs(server.vars, binding.varValues)) {
        live.add(ref);
      }
    }
    yield* secretStore.pruneByPrefix(MCP_VAR_SECRET_PREFIX, live);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("mcp reactor failed to GC orphaned secrets", { error }),
    ),
  );
```
Imports added to McpReactor.ts:
- from `./McpSecrets.ts`: add `collectVarSecretRefs` to the existing import (currently
  `import { materializeSecretValues } from "./McpSecrets.ts";`) ⇒
  `import { collectVarSecretRefs, materializeSecretValues } from "./McpSecrets.ts";`
- from `./McpSecretNames.ts` (NEW import): `import { MCP_VAR_SECRET_PREFIX } from "./McpSecretNames.ts";`
- `secretStore` is already bound (line 87).

> Requires `MCP_VAR_SECRET_PREFIX` to exist — see PART F1.

### D4. Orphaned-`varValues` prune step (item 11)
Add `pruneOrphanedVarValues` inside `make` (place before `processSignal`). For every binding whose
stored `varValues` contains a name **not declared** by its catalog server, dispatch a `mcp.binding-set`
that replays the binding with the orphaned names dropped (refs preserved — see PART F4).

New code:
```ts
  // item 11: drop var values stranded by a catalog edit that removed a var. The resolver already
  // ignores unknown names, so this is hygiene + makes the secret GC exact. Ref-preserving (no
  // plaintext needed) — see decider `mcp.binding-set` keepVarValues handling.
  const pruneOrphanedVarValues = Effect.gen(function* () {
    const catalog = yield* catalogRepository.listAll();
    const bindings = yield* bindingRepository.listAll();
    const declaredByServer = new Map(
      catalog.map((server) => [server.id, new Set(server.vars.map((variable) => variable.name))]),
    );
    for (const binding of bindings) {
      const declared = declaredByServer.get(binding.serverId);
      if (!declared) {
        continue;
      }
      const orphans = Object.keys(binding.varValues).filter((name) => !declared.has(name));
      if (orphans.length === 0) {
        continue;
      }
      const keep = Object.keys(binding.varValues).filter((name) => declared.has(name));
      yield* engine
        .dispatch({
          type: "mcp.binding-set",
          commandId: CommandId.make(`server:mcp-prune-vars:${binding.projectId}:${binding.serverId}`),
          projectId: binding.projectId,
          serverId: binding.serverId,
          patch: { varValues: {}, keepVarValues: keep },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("mcp reactor failed to prune orphaned var values", {
              projectId: binding.projectId,
              serverId: binding.serverId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to scan bindings for orphaned var values", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
```
> `patch: { varValues: {}, keepVarValues: keep }` means: replace per-project values with "none new",
> but PRESERVE the existing refs/strings for the names in `keep` (the declared survivors). Orphan
> names are in neither ⇒ dropped. `CommandId`, `engine`, `Cause` are already imported.
> **Idempotence:** once pruned, the binding has no orphan names, so subsequent reconciles dispatch
> nothing — no event loop. `keepVarValues` reuses existing stored refs, so re-emitting an identical
> binding produces an identical projection row; the reactor's overlay fingerprint is unchanged ⇒ no
> spurious restart.

### D5. Startup reconcile is NOT eager; event reconciles ARE (items 2, 3)
The event subscription + initial enqueue. BEFORE (lines 376-391):
```ts
    // Subscribe before seeding so seed/autobind events also drive reconcile.
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type === "project.created") {
          return worker.enqueue({ kind: "project-created", projectId: event.payload.projectId });
        }
        if (isReconcileRelevant(event)) {
          return worker.enqueue({ kind: "reconcile" });
        }
        return Effect.void;
      }),
    );
    yield* seedBuiltinsIfEmpty;
    // Initial reconcile: cover bindings restored from the DB on restart.
    yield* worker.enqueue({ kind: "reconcile" });
  });
```
AFTER (event-driven ⇒ `eager: true`; startup ⇒ `eager: false`):
```ts
    // Subscribe before seeding so seed/autobind events also drive reconcile.
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type === "project.created") {
          return worker.enqueue({ kind: "project-created", projectId: event.payload.projectId });
        }
        if (isReconcileRelevant(event)) {
          // A change we caused (catalog/binding edit, seed, autobind) ⇒ probe what changed now.
          return worker.enqueue({ kind: "reconcile", eager: true });
        }
        return Effect.void;
      }),
    );
    yield* seedBuiltinsIfEmpty;
    // Initial reconcile: cover bindings restored from the DB on restart — NOT eager (no probing
    // on load; cached status is shown, never-probed stays «не проверено» until a trigger).
    yield* worker.enqueue({ kind: "reconcile", eager: false });
  });
```
> **Seed interaction:** on a fresh install `seedBuiltinsIfEmpty` dispatches `mcp.server-add`, whose
> event flows back through the subscription as `eager: true`. Built-ins with required per-project
> vars are incomplete ⇒ excluded from `computeDesired` ⇒ not in `added` ⇒ not probed (item 7).
> A complete built-in (e.g. filesystem, no vars) WOULD be probed on seed. That is acceptable
> (first-ever seed is a one-time event, not "load" of an existing catalog). Documented, not a bug.

### D6 (item 9). First-sight restart when a live session already spawned — see PART E (shared
fingerprint). The `syncOverlaysAndRestart` first-sight guard is replaced by the shared-fingerprint
seeding in PART E; no separate edit here.

---

## PART E — Startup race + restart (items 8, 9)

**Root cause recap.** `ProviderCommandReactor` writes the overlay at spawn (can be empty if the
project-shell projection hasn't hydrated). `McpReactor` later writes the correct overlay but its
"first sight ⇒ record only" guard skips restarting the already-live session, because the two writers
keep **separate** fingerprint state. Fix: a **shared** fingerprint Ref the spawn path seeds, so the
reactor's later write is a real diff and triggers exactly one restart.

### E1. New service `McpOverlayState`
New file `apps/server/src/ru-fork/mcp/McpOverlayState.ts`:
```ts
// ru-fork: shared last-written overlay fingerprint per project. Seeded by the spawn path
// (ProviderCommandReactor) the instant it writes an overlay for a session, and read/written by
// McpReactor's overlay sync. Sharing it lets the reactor detect that a live session spawned on a
// now-stale overlay and restart it exactly once (items 8 & 9).

import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface McpOverlayStateShape {
  /** Record the fingerprint last written for a project (spawn path or reactor). */
  readonly setFingerprint: (projectId: ProjectId, fingerprint: string) => Effect.Effect<void>;
  /** The current fingerprint map (reactor diff). */
  readonly getFingerprints: Effect.Effect<ReadonlyMap<ProjectId, string>>;
  /** Replace the whole map (reactor commits its post-sync snapshot). */
  readonly setFingerprints: (next: ReadonlyMap<ProjectId, string>) => Effect.Effect<void>;
}

export class McpOverlayState extends Context.Service<McpOverlayState, McpOverlayStateShape>()(
  "ru-fork/mcp/McpOverlayState",
) {}

export const McpOverlayStateLive = Layer.effect(
  McpOverlayState,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<ProjectId, string>>(new Map());
    return {
      setFingerprint: (projectId, fingerprint) =>
        Ref.update(ref, (current) => new Map(current).set(projectId, fingerprint)),
      getFingerprints: Ref.get(ref),
      setFingerprints: (next) => Ref.set(ref, next),
    } satisfies McpOverlayStateShape;
  }),
);
```

### E2. Wire `McpOverlayStateLive` into the MCP layer graph
File `apps/server/src/ru-fork/mcp/McpLayers.ts`. `McpOverlayLive` is already `provideMerge`d into
`McpRuntimeServicesLive` precisely so `ProviderCommandReactor` (spawn-time overlay) can consume it
from this layer's output (see its existing comment). `McpOverlayState` rides the **same** seam.

BEFORE (the `.pipe(...)` chain on `McpRuntimeServicesLive`):
```ts
).pipe(
  // Overlay writer — provided to the reactor (restart-on-change) and exposed for
  // ProviderCommandReactor (spawn-time overlay). Provided before the repos /
  // secret store below so those reach it.
  Layer.provideMerge(McpOverlayLive),
  Layer.provideMerge(McpSupervisorLive),
```
AFTER (add the state layer right after the overlay so it is likewise exposed to consumers):
```ts
).pipe(
  // Overlay writer — provided to the reactor (restart-on-change) and exposed for
  // ProviderCommandReactor (spawn-time overlay). Provided before the repos /
  // secret store below so those reach it.
  Layer.provideMerge(McpOverlayLive),
  // Shared overlay fingerprint state — same seam: read/written by the reactor AND seeded by
  // ProviderCommandReactor at spawn (items 8 & 9). One process-global instance.
  Layer.provideMerge(McpOverlayStateLive),
  Layer.provideMerge(McpSupervisorLive),
```
Import added to `McpLayers.ts`: `import { McpOverlayStateLive } from "./McpOverlayState.ts";`
> **Confirmed:** because `McpOverlayLive` reaching `ProviderCommandReactor` already works via this
> exact `provideMerge` exposure, `McpOverlayStateLive` placed identically reaches it too. No edit is
> needed at the orchestration layer assembly. `provideMerge` keeps a single shared instance.

### E3. `McpReactor` uses the shared state instead of its private Ref (item 9)
File `McpReactor.ts`.
Remove the private ref — BEFORE (lines 92-94):
```ts
  // Last-written overlay fingerprint per project — drives "did this project's
  // effective overlay change ⇒ restart its live sessions" (M7.5).
  const overlayFingerprintsRef = yield* Ref.make<ReadonlyMap<ProjectId, string>>(new Map());
```
AFTER:
```ts
  // Last-written overlay fingerprint per project (SHARED with the spawn path, so a session that
  // spawned on a now-stale overlay is detected and restarted exactly once — items 8 & 9).
  const overlayState = yield* McpOverlayState;
```
`syncOverlaysAndRestart` BEFORE (lines 239-272):
```ts
  const syncOverlaysAndRestart = Effect.gen(function* () {
    if (!MCP_ENGINE_USE_OVERLAY) {
      return;
    }
    const previous = yield* Ref.get(overlayFingerprintsRef);
    const bindings = yield* bindingRepository.listAll();
    const projectIds = new Set<ProjectId>(previous.keys());
    for (const binding of bindings) {
      projectIds.add(binding.projectId);
    }
    if (projectIds.size === 0) {
      return;
    }
    const liveThreads = yield* liveThreadsByProject;

    const next = new Map(previous);
    for (const projectId of projectIds) {
      const result = yield* mcpOverlay
        .writeOverlay(projectId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (result === null) {
        continue;
      }
      const previousFingerprint = previous.get(projectId);
      if (previousFingerprint === result.fingerprint) {
        continue; // unchanged ⇒ no restart (C2: catalog edit under an override is inert)
      }
      next.set(projectId, result.fingerprint);
      if (previousFingerprint === undefined) {
        continue; // first sight ⇒ record only
      }
      yield* Effect.forEach(liveThreads.get(projectId) ?? [], restartThread, { discard: true });
    }
    yield* Ref.set(overlayFingerprintsRef, next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor overlay sync failed", { cause: Cause.pretty(cause) }),
    ),
  );
```
AFTER (read/write the shared map; first-sight WITH a live session that has no recorded fingerprint
still restarts, because the spawn path now seeds the fingerprint — so `undefined` here means "no
session ever spawned for this project", which correctly records-only):
```ts
  const syncOverlaysAndRestart = Effect.gen(function* () {
    if (!MCP_ENGINE_USE_OVERLAY) {
      return;
    }
    const previous = yield* overlayState.getFingerprints;
    const bindings = yield* bindingRepository.listAll();
    const projectIds = new Set<ProjectId>(previous.keys());
    for (const binding of bindings) {
      projectIds.add(binding.projectId);
    }
    if (projectIds.size === 0) {
      return;
    }
    const liveThreads = yield* liveThreadsByProject;

    const next = new Map(previous);
    for (const projectId of projectIds) {
      const result = yield* mcpOverlay
        .writeOverlay(projectId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (result === null) {
        continue;
      }
      const previousFingerprint = previous.get(projectId);
      if (previousFingerprint === result.fingerprint) {
        continue; // unchanged ⇒ no restart
      }
      next.set(projectId, result.fingerprint);
      // Restart live sessions whose overlay just changed. When the spawn path seeded a fingerprint
      // (a session is live), `previousFingerprint` is defined and a diff ⇒ restart. Only when NO
      // session ever spawned for this project (`undefined`) do we record-only.
      if (previousFingerprint === undefined && (liveThreads.get(projectId) ?? []).length === 0) {
        continue; // no live session to refresh ⇒ just record
      }
      yield* Effect.forEach(liveThreads.get(projectId) ?? [], restartThread, { discard: true });
    }
    yield* overlayState.setFingerprints(next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor overlay sync failed", { cause: Cause.pretty(cause) }),
    ),
  );
```
Import added to McpReactor.ts: `import { McpOverlayState } from "./McpOverlayState.ts";`
> `Ref` import remains (used by `overlayState`? no — now only via the service). **Check:** if `Ref`
> becomes unused in McpReactor after removing `overlayFingerprintsRef`, remove the `import * as Ref`
> line (lint would flag an unused import). Grep confirms `Ref` is used ONLY for
> `overlayFingerprintsRef` in this file → its import line `import * as Ref from "effect/Ref";` is
> **removed**. (If another `Ref.` use exists, keep it — STOP to amend.)

### E4. Spawn path seeds the shared fingerprint (item 8)
File `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
Bind the service near the other `yield*` services (next to line 231 `const mcpOverlay = yield* McpOverlay;`):
```ts
  const mcpOverlayState = yield* McpOverlayState;
```
`startProviderSession` BEFORE (lines 522-529):
```ts
        // ru-fork: resolve the per-project MCP overlay just before spawn so qwen
        // sees the current servers + tool policy. Best-effort — an overlay
        // failure must not block the turn (it degrades to no MCP, not a crash).
        const mcpOverlayResult = MCP_ENGINE_USE_OVERLAY
          ? yield* mcpOverlay
              .writeOverlay(thread.projectId)
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : null;
```
AFTER (record the spawn-time fingerprint so the reactor can diff against it):
```ts
        // ru-fork: resolve the per-project MCP overlay just before spawn so qwen
        // sees the current servers + tool policy. Best-effort — an overlay
        // failure must not block the turn (it degrades to no MCP, not a crash).
        const mcpOverlayResult = MCP_ENGINE_USE_OVERLAY
          ? yield* mcpOverlay
              .writeOverlay(thread.projectId)
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : null;
        // Seed the SHARED overlay fingerprint so McpReactor knows this project has a live session
        // spawned on THIS overlay. If the overlay was stale (state not yet hydrated ⇒ 0 servers),
        // the reactor's next write differs and restarts the session exactly once (items 8 & 9).
        if (mcpOverlayResult !== null) {
          yield* mcpOverlayState.setFingerprint(thread.projectId, mcpOverlayResult.fingerprint);
        }
```
Import added: `import { McpOverlayState } from "../../ru-fork/mcp/McpOverlayState.ts";`
> **Confirmed:** `ProviderCommandReactor`'s `make` now requires `McpOverlayState` in R, satisfied by
> E2's `provideMerge` exposure (same path `McpOverlay` already takes). No orchestration-layer edit.

---

## PART F — Decider / secrets (items 11, 13)

### F1. Export the secret-name prefix
File `apps/server/src/ru-fork/mcp/McpSecretNames.ts`. The file builds names as
`mcp-var-<b64>...`. Add an exported constant (used by D3 GC) and use it in the builder.

Add the exported constant before `mcpVarSecretName` (after the `encode` helper). BEFORE:
```ts
const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

export function mcpVarSecretName(input: {
```
AFTER:
```ts
const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** Shared prefix of every MCP var secret name — used by the reactor's secret GC (item 10). */
export const MCP_VAR_SECRET_PREFIX = "mcp-var-";

export function mcpVarSecretName(input: {
```
And switch the literal in the builder. BEFORE:
```ts
  const base = `mcp-var-${encode(input.serverId)}-${encode(input.varName)}`;
```
AFTER:
```ts
  const base = `${MCP_VAR_SECRET_PREFIX}${encode(input.serverId)}-${encode(input.varName)}`;
```
> Produced strings are byte-identical (`MCP_VAR_SECRET_PREFIX === "mcp-var-"`), so existing secret
> files keep matching. Confirmed against the current file.

### F2. `splitServerVars` preserves kept secrets (item 13)
File `apps/server/src/ru-fork/mcp/McpSecrets.ts`. `splitServerVars` must accept the existing server
vars and, for a draft var with `keepSecret` (or a blank secret value when an existing ref exists),
reuse the existing ref instead of writing a new secret.

Signature BEFORE (lines 33-36):
```ts
export const splitServerVars = (
  serverId: McpServerId,
  draftVars: ReadonlyArray<McpServerVarDraft>,
): Effect.Effect<ReadonlyArray<McpServerVar>, SecretStoreError, ServerSecretStore> =>
```
AFTER (add `existingVars`):
```ts
export const splitServerVars = (
  serverId: McpServerId,
  draftVars: ReadonlyArray<McpServerVarDraft>,
  existingVars: ReadonlyArray<McpServerVar>,
): Effect.Effect<ReadonlyArray<McpServerVar>, SecretStoreError, ServerSecretStore> =>
```
Body BEFORE (lines 37-60):
```ts
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const result: McpServerVar[] = [];
    for (const draft of draftVars) {
      const base = {
        name: draft.name,
        secret: draft.secret,
        perProject: draft.perProject,
        required: draft.required,
      };
      if (draft.value === null) {
        result.push({ ...base, value: null });
        continue;
      }
      if (draft.secret) {
        const secretName = mcpVarSecretName({ serverId, varName: draft.name });
        yield* secretStore.set(secretName, textEncoder.encode(draft.value));
        result.push({ ...base, value: { secretRef: secretName } });
      } else {
        result.push({ ...base, value: draft.value });
      }
    }
    return result;
  });
```
AFTER (reuse the existing ref when `keepSecret`):
```ts
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const existingByName = new Map(existingVars.map((variable) => [variable.name, variable]));
    const result: McpServerVar[] = [];
    for (const draft of draftVars) {
      const base = {
        name: draft.name,
        secret: draft.secret,
        perProject: draft.perProject,
        required: draft.required,
      };
      // Keep an untouched secret: reuse the existing stored ref instead of overwriting. Only valid
      // when the existing var is a secret holding a ref (not a per-project hole / plain value).
      if (draft.secret && draft.keepSecret === true) {
        const previous = existingByName.get(draft.name);
        const previousValue = previous?.value;
        if (previousValue !== null && typeof previousValue === "object") {
          result.push({ ...base, value: previousValue });
          continue;
        }
        // No prior ref to keep (renamed/new) ⇒ fall through to treat `value` normally.
      }
      if (draft.value === null) {
        result.push({ ...base, value: null });
        continue;
      }
      if (draft.secret) {
        const secretName = mcpVarSecretName({ serverId, varName: draft.name });
        yield* secretStore.set(secretName, textEncoder.encode(draft.value));
        result.push({ ...base, value: { secretRef: secretName } });
      } else {
        result.push({ ...base, value: draft.value });
      }
    }
    return result;
  });
```
> `previousValue !== null && typeof previousValue === "object"` is the same secret-ref test used by
> `isSecretRef` in this file (no `as` cast; the narrowing makes `previousValue` the ref object).

### F3. `splitBindingVarValues` preserves kept per-project secrets (item 13)
Same file. The binding split must carry over refs for names listed in `keepVarValues`.

Signature BEFORE (lines 67-72):
```ts
export const splitBindingVarValues = (input: {
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly draftVarValues: Readonly<Record<string, string>>;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> =>
```
AFTER (add `keepNames` + `existing`):
```ts
export const splitBindingVarValues = (input: {
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly draftVarValues: Readonly<Record<string, string>>;
  /** Names whose existing stored value/ref must be preserved (client left the masked field blank). */
  readonly keepNames: ReadonlyArray<string>;
  /** The binding's existing var values, to source the preserved entries from. */
  readonly existing: Readonly<Record<string, McpVarValue>>;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> =>
```
Body BEFORE (lines 73-93):
```ts
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const secretVarNames = new Set(
      input.vars.filter((declared) => declared.secret).map((declared) => declared.name),
    );
    const result: Record<string, McpVarValue> = {};
    for (const [name, value] of Object.entries(input.draftVarValues)) {
      if (secretVarNames.has(name)) {
        const secretName = mcpVarSecretName({
          serverId: input.serverId,
          varName: name,
          projectId: input.projectId,
        });
        yield* secretStore.set(secretName, textEncoder.encode(value));
        result[name] = { secretRef: secretName };
      } else {
        result[name] = value;
      }
    }
    return result;
  });
```
AFTER (seed preserved entries first, then apply the draft):
```ts
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const secretVarNames = new Set(
      input.vars.filter((declared) => declared.secret).map((declared) => declared.name),
    );
    const result: Record<string, McpVarValue> = {};
    // Preserve untouched entries (masked secret left blank): carry the existing value/ref over.
    for (const name of input.keepNames) {
      const previous = input.existing[name];
      if (previous !== undefined) {
        result[name] = previous;
      }
    }
    for (const [name, value] of Object.entries(input.draftVarValues)) {
      if (secretVarNames.has(name)) {
        const secretName = mcpVarSecretName({
          serverId: input.serverId,
          varName: name,
          projectId: input.projectId,
        });
        yield* secretStore.set(secretName, textEncoder.encode(value));
        result[name] = { secretRef: secretName };
      } else {
        result[name] = value;
      }
    }
    return result;
  });
```

### F4. `resolveBindingVarValues` threads keep-names (items 11, 13)
File `apps/server/src/ru-fork/mcp/McpCatalogBuilders.ts`. `resolveBindingVarValues` calls
`splitBindingVarValues`; it must pass the new args and accept a `keepNames`.

Signature/body BEFORE (lines 101-117):
```ts
export function resolveBindingVarValues(input: {
  readonly patch: Readonly<Record<string, string>> | undefined;
  readonly existing: Readonly<Record<string, McpVarValue>>;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> {
  if (input.patch === undefined) {
    return Effect.succeed({ ...input.existing });
  }
  return splitBindingVarValues({
    projectId: input.projectId,
    serverId: input.serverId,
    vars: input.vars,
    draftVarValues: input.patch,
  });
}
```
AFTER (accept `keepNames`; pass `existing` + `keepNames` through; when patch is undefined keep all):
```ts
export function resolveBindingVarValues(input: {
  readonly patch: Readonly<Record<string, string>> | undefined;
  readonly keepNames: ReadonlyArray<string> | undefined;
  readonly existing: Readonly<Record<string, McpVarValue>>;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> {
  if (input.patch === undefined) {
    return Effect.succeed({ ...input.existing });
  }
  return splitBindingVarValues({
    projectId: input.projectId,
    serverId: input.serverId,
    vars: input.vars,
    draftVarValues: input.patch,
    keepNames: input.keepNames ?? [],
    existing: input.existing,
  });
}
```

### F5. Decider passes the new args (items 11, 13)
File `apps/server/src/orchestration/decider.ts`.
`mcp.server-update` BEFORE (lines 776-778):
```ts
      const vars = command.patch.vars
        ? yield* splitServerVars(command.serverId, command.patch.vars)
        : existing.vars;
```
AFTER (pass `existing.vars` so `keepSecret` can reuse refs):
```ts
      const vars = command.patch.vars
        ? yield* splitServerVars(command.serverId, command.patch.vars, existing.vars)
        : existing.vars;
```
`mcp.server-add` BEFORE (line 760):
```ts
      const vars = yield* splitServerVars(command.serverId, command.draft.vars);
```
AFTER (no existing vars on add ⇒ empty array; `keepSecret` is a no-op on add):
```ts
      const vars = yield* splitServerVars(command.serverId, command.draft.vars, []);
```
`mcp.binding-set` BEFORE (lines 813-819):
```ts
      const varValues = yield* resolveBindingVarValues({
        patch: command.patch.varValues,
        existing: existing?.varValues ?? {},
        vars: server.vars,
        projectId: command.projectId,
        serverId: command.serverId,
      });
```
AFTER (thread `keepVarValues`):
```ts
      const varValues = yield* resolveBindingVarValues({
        patch: command.patch.varValues,
        keepNames: command.patch.keepVarValues,
        existing: existing?.varValues ?? {},
        vars: server.vars,
        projectId: command.projectId,
        serverId: command.serverId,
      });
```
> The duplicate `requireCatalogServer` call (lines 809 & 811) is left exactly as-is — NOT touched
> (out of scope; changing it is forbidden by this plan).

---

## PART G — Web (`apps/web/src/ru-fork/mcp-manage/`) — items 4,5,6,7,12,13,14

### G1. UI status type gains `unchecked` + `checking`
File `types.ts`. BEFORE (line 16):
```ts
export type McpStatus = "connected" | "connecting" | "degraded" | "error" | "disabled";
```
AFTER:
```ts
export type McpStatus =
  | "unchecked"
  | "checking"
  | "connected"
  | "connecting"
  | "degraded"
  | "error"
  | "disabled";
```
Add to `McpRegistryServer` a `checking` flag and an `incomplete` flag (catalog default incomplete →
«требует настройки»). BEFORE (the `McpRegistryServer` interface fields, after `status?`):
```ts
  /** Catalog-level probe status; undefined until the default config is first probed. */
  readonly status?: McpStatus;
  readonly tags: readonly string[];
  readonly docsUrl?: string;
}
```
AFTER:
```ts
  /** Catalog-level probe status; undefined until the default config is first probed. */
  readonly status?: McpStatus;
  /** A catalog-default probe is in flight (drives «проверка…» + edit-lock). */
  readonly checking: boolean;
  /** The catalog default cannot be probed — a required, defaultless var exists (item 7). */
  readonly incomplete: boolean;
  /** Required var names missing a catalog default (tooltip for «требует настройки»). */
  readonly missingVars: readonly string[];
  readonly tags: readonly string[];
  readonly docsUrl?: string;
}
```
Add `checking` to `McpProjectBinding` — BEFORE (the `status`/`health` fields):
```ts
  readonly status: McpStatus;
  readonly health: McpHealth;
```
AFTER:
```ts
  readonly status: McpStatus;
  /** A probe of this binding is in flight (drives «проверка…» + edit-lock). */
  readonly checking: boolean;
  readonly health: McpHealth;
```

### G2. `visuals.ts` — entries for the two new statuses
File `visuals.ts`. Add to `STATUS_VISUALS` (BEFORE — the object opens with `connected`):
```ts
const STATUS_VISUALS: Record<McpStatus, StatusVisual> = {
  connected: {
```
AFTER (prepend `unchecked` and `checking`):
```ts
const STATUS_VISUALS: Record<McpStatus, StatusVisual> = {
  unchecked: {
    label: "Не проверено",
    textClass: "text-muted-foreground",
    dotClass: "bg-zinc-300 dark:bg-zinc-600",
    pulse: false,
  },
  checking: {
    label: "Проверка…",
    textClass: "text-sky-600 dark:text-sky-300/90",
    dotClass: "bg-sky-500",
    pulse: true,
  },
  connected: {
```
> `STATUS_VISUALS` is typed `Record<McpStatus, StatusVisual>`, so adding the two keys is required by
> the compiler the moment G1 lands — exhaustive by construction.

### G3. `adapters.ts` — map `checking`, `unchecked`, catalog incomplete, `hasStoredSecret`
File `adapters.ts`.

(a) `runtimeStatusToUi` gains the unchecked/checking mapping. BEFORE (lines 104-123):
```ts
export function runtimeStatusToUi(
  enabled: boolean,
  status: McpRuntimeSnapshot["status"] | undefined,
): McpStatus {
  if (!enabled) {
    return "disabled";
  }
  switch (status) {
    case "online":
      return "connected";
    case "connecting":
    case undefined: // bound, but the monitor hasn't reported yet
      return "connecting";
    case "degraded":
      return "degraded";
    case "offline":
    case "error":
      return "error";
  }
}
```
AFTER (add `checking` precedence + `unchecked`):
```ts
export function runtimeStatusToUi(
  enabled: boolean,
  status: McpRuntimeSnapshot["status"] | undefined,
  checking: boolean,
): McpStatus {
  if (!enabled) {
    return "disabled";
  }
  if (checking) {
    return "checking"; // a probe is in flight — show «проверка…» over any prior status
  }
  switch (status) {
    case "online":
      return "connected";
    case "unchecked":
      return "unchecked";
    case "connecting":
    case undefined: // bound, but the monitor hasn't reported yet
      return "connecting";
    case "degraded":
      return "degraded";
    case "offline":
    case "error":
      return "error";
  }
}
```

(b) New helper — required catalog-default vars missing a value (catalog incomplete, item 7). Add
near `computeMissingVars` (which already exists for bindings):
```ts
/** Required vars with no catalog default — the catalog default itself can't be probed (item 7). */
function catalogMissingVars(vars: ReadonlyArray<ContractVar>): string[] {
  return vars
    .filter((variable) => variable.perProject && variable.required && variable.value === null)
    .map((variable) => variable.name);
}
```

(c) `catalogServerToRegistry` sets `checking`/`incomplete`/`missingVars`/`status`. BEFORE (lines 85-102):
```ts
export function catalogServerToRegistry(
  server: McpCatalogServer,
  runtime: McpCatalogRuntimeSnapshot | undefined,
): McpRegistryServer {
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    source: server.source,
    config: contractConfigToUi(server.config),
    vars: server.vars.map(catalogVarToUi),
    ...(server.timeoutMs !== null ? { timeoutMs: server.timeoutMs } : {}),
    // Live tools + status from the probe of the default config (cwd-independent).
    tools: toUiTools(runtime?.discoveredTools ?? []),
    ...(runtime ? { status: runtimeStatusToUi(true, runtime.status) } : {}),
    // tags/docsUrl are demo-only flair with no backend column — derive a single
    // transport tag so existing filters keep working.
    tags: [server.config.transport],
  };
}
```
AFTER:
```ts
export function catalogServerToRegistry(
  server: McpCatalogServer,
  runtime: McpCatalogRuntimeSnapshot | undefined,
): McpRegistryServer {
  const missingVars = catalogMissingVars(server.vars);
  const checking = runtime?.checking ?? false;
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    source: server.source,
    config: contractConfigToUi(server.config),
    vars: server.vars.map(catalogVarToUi),
    ...(server.timeoutMs !== null ? { timeoutMs: server.timeoutMs } : {}),
    // Live tools + status from the probe of the default config (cwd-independent).
    tools: toUiTools(runtime?.discoveredTools ?? []),
    ...(runtime ? { status: runtimeStatusToUi(true, runtime.status, checking) } : {}),
    checking,
    incomplete: missingVars.length > 0,
    missingVars,
    // tags/docsUrl are demo-only flair with no backend column — derive a single
    // transport tag so existing filters keep working.
    tags: [server.config.transport],
  };
}
```

(d) `bindingToUi` sets `checking`, passes it to `runtimeStatusToUi`. BEFORE (the return inside
`bindingToUi`, lines 178-195 in the current file):
```ts
export function bindingToUi(
  binding: McpBinding,
  server: McpCatalogServer | undefined,
  runtime: McpRuntimeSnapshot | undefined,
): McpProjectBinding {
  const discovered = runtime?.discoveredTools ?? [];
  const discoveredNames = discovered.map((tool) => tool.name);
  const missingVars = server ? computeMissingVars(server.vars, binding.varValues) : [];
  return {
    projectId: binding.projectId,
    serverId: binding.serverId,
    enabled: binding.enabled,
    status: runtimeStatusToUi(binding.enabled, runtime?.status),
    health: runtimeHealth(runtime, binding.enabled),
    toolOverrides: policyToToolOverrides(binding.toolPolicy, discoveredNames),
    // Live tools from the probe — what the UI tool list + counts should reflect.
    discoveredTools: toUiTools(discovered),
    varValues: bindingVarValuesToUi(binding.varValues),
    incomplete: missingVars.length > 0,
    missingVars,
    ...(binding.timeoutMs !== null ? { timeoutMs: binding.timeoutMs } : {}),
  };
}
```
AFTER:
```ts
export function bindingToUi(
  binding: McpBinding,
  server: McpCatalogServer | undefined,
  runtime: McpRuntimeSnapshot | undefined,
): McpProjectBinding {
  const discovered = runtime?.discoveredTools ?? [];
  const discoveredNames = discovered.map((tool) => tool.name);
  const missingVars = server ? computeMissingVars(server.vars, binding.varValues) : [];
  const checking = runtime?.checking ?? false;
  return {
    projectId: binding.projectId,
    serverId: binding.serverId,
    enabled: binding.enabled,
    status: runtimeStatusToUi(binding.enabled, runtime?.status, checking),
    checking,
    health: runtimeHealth(runtime, binding.enabled),
    toolOverrides: policyToToolOverrides(binding.toolPolicy, discoveredNames),
    // Live tools from the probe — what the UI tool list + counts should reflect.
    discoveredTools: toUiTools(discovered),
    varValues: bindingVarValuesToUi(binding.varValues),
    secretVarNames: bindingSecretVarNames(binding.varValues),
    incomplete: missingVars.length > 0,
    missingVars,
    ...(binding.timeoutMs !== null ? { timeoutMs: binding.timeoutMs } : {}),
  };
}
```
> `bindingSecretVarNames` is the hoisted helper from G3f (defined later in the file — valid).

(e) Expose `hasStoredSecret` per var (item 14). Extend the UI `McpVar` (PART G, types) — see G6 —
and set it in `catalogVarToUi`. BEFORE (the existing `catalogVarToUi`):
```ts
/** Contract var → UI var (masks secret values to ""). */
function catalogVarToUi(variable: ContractVar): McpVar {
  return {
    name: variable.name,
    value: varValueToUi(variable.value),
    secret: variable.secret,
    perProject: variable.perProject,
    required: variable.required,
  };
}
```
AFTER:
```ts
/** Contract var → UI var (masks secret values to ""; flags whether a secret is already stored). */
function catalogVarToUi(variable: ContractVar): McpVar {
  return {
    name: variable.name,
    value: varValueToUi(variable.value),
    secret: variable.secret,
    perProject: variable.perProject,
    required: variable.required,
    // A secret whose catalog value is a stored ref ⇒ there IS a saved secret (write-only here).
    hasStoredSecret: variable.secret && variable.value !== null && typeof variable.value === "object",
  };
}
```

(f) Expose per-project stored-secret presence for the project dialog. The binding masks secret values
to "" but we need to know a per-project secret EXISTS. Add to `McpProjectBinding` a
`secretVarNames: readonly string[]` set from the binding's varValues that are secret refs. BEFORE
(`bindingVarValuesToUi`):
```ts
/** Binding var values → UI map (secret values masked to ""). */
function bindingVarValuesToUi(
  varValues: Readonly<Record<string, McpVarValue>>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(varValues)) {
    masked[name] = typeof value === "string" ? value : "";
  }
  return masked;
}
```
AFTER (add a companion that lists names with a stored secret ref):
```ts
/** Binding var values → UI map (secret values masked to ""). */
function bindingVarValuesToUi(
  varValues: Readonly<Record<string, McpVarValue>>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(varValues)) {
    masked[name] = typeof value === "string" ? value : "";
  }
  return masked;
}

/** Names whose per-project value is a stored secret ref (a saved secret exists for the project). */
function bindingSecretVarNames(
  varValues: Readonly<Record<string, McpVarValue>>,
): string[] {
  return Object.entries(varValues)
    .filter(([, value]) => value !== null && typeof value === "object")
    .map(([name]) => name);
}
```
The `bindingToUi` return already sets `secretVarNames: bindingSecretVarNames(binding.varValues),`
(see G3d AFTER). Corresponding `McpProjectBinding` field is added in G6.

### G4. `StatusBadge` already reads `statusVisual` — no change.
The new statuses flow through `visuals.ts` automatically. **No edit to `StatusBadge.tsx`.**

### G5. `useMcp.ts` — pass `checking` everywhere `runtimeStatusToUi` is called is internal to adapters;
`useMcp` only needs the `keepSecret`/`keepVarValues` plumbing for items 13. `addServer`/`updateServer`
already send `vars` via `uiVarsToDraft`; that helper must emit `keepSecret` (see G7). `setProjectBinding`
must send `keepVarValues`.

`ProjectBindingInput` BEFORE:
```ts
/** Per-project edits the project dialog saves: hole values + timeout override. */
export interface ProjectBindingInput {
  /** Per-project var values (plaintext). A name omitted ⇒ inherit the catalog value. */
  readonly varValues: Readonly<Record<string, string>>;
  /** Timeout override in ms; null clears it (inherit the catalog default). */
  readonly timeoutMs: number | null;
}
```
AFTER:
```ts
/** Per-project edits the project dialog saves: hole values + timeout override. */
export interface ProjectBindingInput {
  /** Per-project var values (plaintext). A name omitted ⇒ inherit the catalog value. */
  readonly varValues: Readonly<Record<string, string>>;
  /** Per-project secret names left untouched (masked, blank) — preserve their stored ref. */
  readonly keepVarValues: readonly string[];
  /** Timeout override in ms; null clears it (inherit the catalog default). */
  readonly timeoutMs: number | null;
}
```
`setProjectBinding` BEFORE:
```ts
  setProjectBinding: (serverId, projectId, input) => {
    dispatchMcpCommand({
      type: "mcp.binding-set",
      commandId: newCommandId(),
      projectId: ProjectId.make(projectId),
      serverId: McpServerId.make(serverId),
      patch: { varValues: { ...input.varValues }, timeoutMs: input.timeoutMs },
    });
  },
```
AFTER:
```ts
  setProjectBinding: (serverId, projectId, input) => {
    dispatchMcpCommand({
      type: "mcp.binding-set",
      commandId: newCommandId(),
      projectId: ProjectId.make(projectId),
      serverId: McpServerId.make(serverId),
      patch: {
        varValues: { ...input.varValues },
        ...(input.keepVarValues.length > 0 ? { keepVarValues: [...input.keepVarValues] } : {}),
        timeoutMs: input.timeoutMs,
      },
    });
  },
```

### G6. `types.ts` — `McpVar` gains `hasStoredSecret`; `McpProjectBinding` gains `secretVarNames`
BEFORE (the `McpVar` interface):
```ts
export interface McpVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly perProject: boolean;
  readonly required: boolean;
}
```
AFTER:
```ts
export interface McpVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly perProject: boolean;
  readonly required: boolean;
  /** A secret is already stored server-side for this var (value is masked/write-only here). */
  readonly hasStoredSecret: boolean;
}
```
`McpProjectBinding` — add `secretVarNames` next to `varValues` (BEFORE the `incomplete` field):
```ts
  readonly varValues: Readonly<Record<string, string>>;
```
AFTER:
```ts
  readonly varValues: Readonly<Record<string, string>>;
  /** Per-project var names that already have a stored secret (masked here). */
  readonly secretVarNames: readonly string[];
```
> Every place that constructs a UI `McpVar` literal must now set `hasStoredSecret`. Those are:
> `adapters.catalogVarToUi` (G3e — set), `VarsEditor.EMPTY_VAR` (G8 — set false),
> `addMcpParsing.envToVars` (G9 — set false). All three are covered below.

### G7. `serverConfigForm.ts` / `adapters.uiVarsToDraft` — emit `keepSecret`
The catalog draft path runs through `adapters.uiVarsToDraft`. BEFORE:
```ts
/** UI var rows → inbound draft vars (plaintext; the decider splits secrets → refs). */
export function uiVarsToDraft(vars: ReadonlyArray<McpVar>): McpServerVarDraft[] {
  return vars.map((variable): McpServerVarDraft => {
    const value = variable.value.trim();
    return {
      name: variable.name,
      secret: variable.secret,
      perProject: variable.perProject,
      // `required` only applies to per-project holes — never carry it otherwise.
      required: variable.perProject ? variable.required : false,
      // Empty stays null (a per-project hole / "leave the stored secret unchanged"
      // is handled by the mutation layer, which drops blank secret values).
      value: value.length > 0 ? value : null,
    };
  });
}
```
AFTER (a secret left blank but already stored ⇒ keepSecret, value null):
```ts
/** UI var rows → inbound draft vars (plaintext; the decider splits secrets → refs). */
export function uiVarsToDraft(vars: ReadonlyArray<McpVar>): McpServerVarDraft[] {
  return vars.map((variable): McpServerVarDraft => {
    const value = variable.value.trim();
    // A secret with a stored value that the user left blank ⇒ keep the existing ref (don't wipe).
    const keepSecret = variable.secret && variable.hasStoredSecret && value.length === 0;
    return {
      name: variable.name,
      secret: variable.secret,
      perProject: variable.perProject,
      // `required` only applies to per-project holes — never carry it otherwise.
      required: variable.perProject ? variable.required : false,
      ...(keepSecret ? { keepSecret: true } : {}),
      // Empty stays null; when keepSecret is set the decider ignores `value` and reuses the ref.
      value: value.length > 0 ? value : null,
    };
  });
}
```
> Import in `adapters.ts`: `McpServerVarDraft` is already imported. No new import.

### G8. `VarsEditor.tsx` — `EMPTY_VAR` sets `hasStoredSecret: false`; saved-secret affordance (item 14)
BEFORE:
```ts
const EMPTY_VAR: McpVar = {
  name: "",
  value: "",
  secret: false,
  perProject: false,
  required: false,
};
```
AFTER:
```ts
const EMPTY_VAR: McpVar = {
  name: "",
  value: "",
  secret: false,
  perProject: false,
  required: false,
  hasStoredSecret: false,
};
```
Secret value input — show the saved-secret placeholder + `(i)`. BEFORE (the value `Input` inside the
row, current placeholder logic):
```tsx
            <Input
              value={variable.value}
              type={variable.secret ? "password" : "text"}
              autoComplete="off"
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={
                variable.perProject && variable.value.length === 0
                  ? "значение по умолчанию"
                  : variable.secret
                    ? "значение секрета"
                    : "значение"
              }
              aria-label="Значение переменной"
              className="min-w-0 flex-1 font-mono"
            />
```
AFTER (saved secret ⇒ «сохранён» placeholder so blank-means-keep is legible):
```tsx
            <Input
              value={variable.value}
              type={variable.secret ? "password" : "text"}
              autoComplete="off"
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={
                variable.secret && variable.hasStoredSecret && variable.value.length === 0
                  ? "сохранён — пусто оставит без изменений"
                  : variable.perProject && variable.value.length === 0
                    ? "значение по умолчанию"
                    : variable.secret
                      ? "значение секрета"
                      : "значение"
              }
              aria-label="Значение переменной"
              className="min-w-0 flex-1 font-mono"
            />
```
> Editing a var's name flips `hasStoredSecret` semantics: when the user changes a saved secret's
> name, the stored ref keys by the OLD name and won't be kept (decider F2: no prior ref under the
> new name ⇒ value required). We surface that in McpServerDialog warnings (G11) rather than per-row,
> to keep the row compact. **Decision:** the per-row red border is reserved for the project dialog
> (G10) where required-empty is actionable; the catalog editor uses the warnings block (G11).

### G9. `addMcpParsing.ts` — `envToVars` sets `hasStoredSecret: false`
BEFORE (`envToVars`):
```ts
function envToVars(env: Record<string, string>): McpVar[] {
  return Object.entries(env).map(([name, value]) => ({
    name,
    value,
    secret: false,
    perProject: false,
    required: false,
  }));
}
```
AFTER:
```ts
function envToVars(env: Record<string, string>): McpVar[] {
  return Object.entries(env).map(([name, value]) => ({
    name,
    value,
    secret: false,
    perProject: false,
    required: false,
    hasStoredSecret: false,
  }));
}
```

### G10. `ProjectConfigDialog.tsx` — SecretField states + keepVarValues + edit-lock (items 13, 14, 6)
This dialog gains: (a) red `aria-invalid` border on a required, empty, no-default, no-stored-secret
hole; (b) "сохранён" affordance for per-project secrets; (c) building `keepVarValues` on save;
(d) being disabled while the binding is checking (item 6 — handled at the trigger in
`ProjectBindingRow`, G12, but the dialog also early-returns if opened while checking).

Add a new shared component `SecretAwareInput` — see G13 — and use it for each var row.

`perProjectVars` and `initialValues` unchanged. `handleSave` BEFORE:
```ts
  function handleSave() {
    setError(null);
    const timeout = parseTimeout(timeoutText);
    if (!timeout.ok) {
      setError(timeout.error);
      return;
    }
    // Empty fields are omitted → the binding inherits the catalog value for that hole.
    const varValues: Record<string, string> = {};
    for (const variable of vars) {
      const value = (values[variable.name] ?? "").trim();
      if (value.length > 0) {
        varValues[variable.name] = value;
      }
    }
    setProjectBinding(server.id, binding.projectId, {
      varValues,
      timeoutMs: timeout.timeoutMs ?? null,
    });
    setOpen(false);
  }
```
AFTER (build `keepVarValues` for untouched stored per-project secrets):
```ts
  function handleSave() {
    setError(null);
    const timeout = parseTimeout(timeoutText);
    if (!timeout.ok) {
      setError(timeout.error);
      return;
    }
    const storedSecretNames = new Set(binding.secretVarNames);
    // Empty fields are omitted → the binding inherits the catalog value for that hole.
    const varValues: Record<string, string> = {};
    const keepVarValues: string[] = [];
    for (const variable of vars) {
      const value = (values[variable.name] ?? "").trim();
      if (value.length > 0) {
        varValues[variable.name] = value;
      } else if (variable.secret && storedSecretNames.has(variable.name)) {
        // Masked secret left blank ⇒ preserve the stored per-project ref instead of clearing it.
        keepVarValues.push(variable.name);
      }
    }
    setProjectBinding(server.id, binding.projectId, {
      varValues,
      keepVarValues,
      timeoutMs: timeout.timeoutMs ?? null,
    });
    setOpen(false);
  }
```
The var row `Input` BEFORE:
```tsx
                      <Input
                        id={`mcp-proj-${variable.name}`}
                        value={values[variable.name] ?? ""}
                        type={variable.secret ? "password" : "text"}
                        autoComplete="off"
                        onChange={(event) =>
                          setValues((prev) => ({ ...prev, [variable.name]: event.target.value }))
                        }
                        placeholder={
                          variable.secret
                            ? "значение секрета"
                            : hasDefault
                              ? `по умолчанию: ${variable.value}`
                              : "значение"
                        }
                        className="mt-1.5 font-mono"
                      />
```
AFTER (use `SecretAwareInput`; compute the missing/red state):
```tsx
                      <SecretAwareInput
                        id={`mcp-proj-${variable.name}`}
                        value={values[variable.name] ?? ""}
                        secret={variable.secret}
                        hasStoredSecret={storedSecretNames.has(variable.name)}
                        invalid={binding.missingVars.includes(variable.name)}
                        onChange={(next) =>
                          setValues((prev) => ({ ...prev, [variable.name]: next }))
                        }
                        placeholder={
                          variable.secret
                            ? "значение секрета"
                            : hasDefault
                              ? `по умолчанию: ${variable.value}`
                              : "значение"
                        }
                        className="mt-1.5"
                      />
```
Add, inside the component body before `return`, the stored-secret set used above:
```tsx
  const storedSecretNames = new Set(binding.secretVarNames);
```
Import added to `ProjectConfigDialog.tsx`:
`import { SecretAwareInput } from "./SecretAwareInput";` and **remove** the now-unused
`import { Input } from "~/components/ui/input";` (verify `Input` is not used elsewhere in the file
after the swap — it is not; STOP if it is).

### G11. `McpServerDialog.tsx` — warn-on-impact (item 12) + edit-lock (item 6)
(a) **Edit-lock (item 6):** the dialog is opened from a trigger; disable the trigger when the
catalog server is checking. Implemented at the call sites (RegistryDetail pencil — G14) by passing
`disabled={server.checking}` to the trigger button. **No structural change inside McpServerDialog for
the lock** beyond a guard: if opened while checking, show a notice and disable Save. Add near the top
of the render, before the footer — a derived flag from props is not available (the dialog only has
`server`); add to the dialog a `checking` read. **Decision:** pass `server.checking` via the existing
`server` prop (already includes `checking` after G1) and guard:

`handleSubmit` BEFORE (first lines):
```ts
  function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Укажите имя сервера.");
      return;
    }
```
AFTER (block save while a probe runs):
```ts
  function handleSubmit() {
    setError(null);
    if (server?.checking) {
      setError("Идёт проверка сервера — дождитесь её завершения.");
      return;
    }
    if (!name.trim()) {
      setError("Укажите имя сервера.");
      return;
    }
```

(b) **Warn-on-impact (item 12):** before applying an edit that removes a per-project var used by
bindings, or adds a required hole, confirm. Compute impact from the live bindings.

Add a hook usage at the top of the component (it currently uses `useMcpMutations`):
BEFORE:
```ts
  const { addServer, updateServer } = useMcpMutations();
  const isEditing = server !== undefined;
```
AFTER:
```ts
  const { addServer, updateServer } = useMcpMutations();
  const bindings = useMcpProjectBindings();
  const isEditing = server !== undefined;
  const [impactWarning, setImpactWarning] = useState<string | null>(null);
```
Add the impact computation + a confirm gate inside `handleSubmit`, AFTER the `resolved` success
check and BEFORE the `updateServer`/`addServer` dispatch. BEFORE (current tail of `handleSubmit`):
```ts
    const input = {
      name: name.trim(),
      description: description.trim(),
      config: resolved.config,
      vars: resolved.vars,
      ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
    };
    if (isEditing) {
      updateServer(server.id, input);
    } else {
      addServer(input);
    }
    setOpen(false);
  }
```
AFTER:
```ts
    const input = {
      name: name.trim(),
      description: description.trim(),
      config: resolved.config,
      vars: resolved.vars,
      ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
    };
    if (isEditing && impactWarning === null) {
      const warning = describeEditImpact(server, resolved.vars, bindings);
      if (warning !== null) {
        setImpactWarning(warning); // show the confirm banner; a second Save (now armed) proceeds
        return;
      }
    }
    if (isEditing) {
      updateServer(server.id, input);
    } else {
      addServer(input);
    }
    setOpen(false);
  }
```
Add the pure impact helper to `serverConfigForm.ts` (so it is unit-described and reused):
```ts
import type { McpProjectBinding, McpServerConfig, McpTransport, McpVar } from "../types";
```
(append `McpProjectBinding` to the existing type import in `serverConfigForm.ts`) and add:
```ts
/**
 * Human warning if a catalog edit will strand per-project data: a per-project var removed while
 * bindings hold a value for it, or a new required hole that forces N projects to be configured.
 * Returns null when the edit is non-disruptive.
 */
export function describeEditImpact(
  server: { readonly id: string; readonly vars: readonly McpVar[] },
  nextVars: readonly McpVar[],
  bindings: readonly McpProjectBinding[],
): string | null {
  const nextNames = new Set(nextVars.map((variable) => variable.name));
  const removedPerProject = server.vars
    .filter((variable) => variable.perProject && !nextNames.has(variable.name))
    .map((variable) => variable.name);
  const serverBindings = bindings.filter((binding) => binding.serverId === server.id);
  const messages: string[] = [];
  for (const name of removedPerProject) {
    const affected = serverBindings.filter((binding) => name in binding.varValues).length;
    if (affected > 0) {
      messages.push(`Значения «${name}» будут удалены в ${affected} проект(ах).`);
    }
  }
  const newRequired = nextVars.filter(
    (variable) =>
      variable.perProject &&
      variable.required &&
      variable.value.trim().length === 0 &&
      !server.vars.some((existing) => existing.name === variable.name),
  );
  if (newRequired.length > 0 && serverBindings.length > 0) {
    messages.push(
      `Новое обязательное поле — ${serverBindings.length} проект(ов) нужно будет настроить.`,
    );
  }
  return messages.length > 0 ? messages.join(" ") : null;
}
```
Render the warning banner + change the Save button label when armed. Add to the dialog body, just
above the existing `{error && ...}` line:
```tsx
            {impactWarning && (
              <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300/90">
                <p>{impactWarning}</p>
                <p className="font-medium">Нажмите «Сохранить» ещё раз, чтобы применить.</p>
              </div>
            )}
```
`reset()` must also clear `impactWarning`. BEFORE (the `reset` body tail):
```ts
    setAdvancedJson("");
    setError(null);
  }
```
AFTER:
```ts
    setAdvancedJson("");
    setError(null);
    setImpactWarning(null);
  }
```
Imports added to `McpServerDialog.tsx`:
- add `useMcpProjectBindings` to the existing `useMcp` import:
  `import { useMcpMutations, useMcpProjectBindings } from "../useMcp";`
- add `describeEditImpact` to the existing `serverConfigForm` import.

### G12. `ProjectBindingRow.tsx` — edit-lock during check (item 6) + checking status
The status already flows through `binding.status` (now `"checking"` when probing). Lock the
per-project config trigger while checking. BEFORE (the `ProjectConfigDialog` trigger button):
```tsx
        <ProjectConfigDialog
          server={server}
          binding={binding}
          trigger={
            <Button
              size="icon-xs"
              variant="ghost"
              title="Настроить для проекта"
              aria-label={`Настроить ${server.name} для проекта`}
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          }
        />
```
AFTER (disable while checking):
```tsx
        <ProjectConfigDialog
          server={server}
          binding={binding}
          trigger={
            <Button
              size="icon-xs"
              variant="ghost"
              title={binding.checking ? "Идёт проверка…" : "Настроить для проекта"}
              aria-label={`Настроить ${server.name} для проекта`}
              disabled={binding.checking}
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          }
        />
```

### G13. New component `SecretAwareInput.tsx` (item 14)
New file `apps/web/src/ru-fork/mcp-manage/components/SecretAwareInput.tsx`. Uses the native `title`
attribute for the saved-secret hint (the repo's `tooltip.tsx` exports `Tooltip`/`TooltipTrigger`/
`TooltipPopup` and needs a `TooltipProvider` ancestor — a native `title` avoids that dependency and
is sufficient for a one-line hint):
```tsx
import { CheckIcon } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";

/**
 * One value field that knows about masked secrets. Three visual states:
 *  - saved secret, untouched (`hasStoredSecret`, empty value): a lock-check «сохранён» addon
 *    (native-title hint), no red border;
 *  - needs a value (`invalid`, empty): a destructive (red) border via `aria-invalid`;
 *  - editing: a plain field. Secrets render as a password input.
 */
export function SecretAwareInput({
  id,
  value,
  secret,
  hasStoredSecret = false,
  invalid = false,
  onChange,
  placeholder,
  className,
}: {
  readonly id?: string;
  readonly value: string;
  readonly secret: boolean;
  readonly hasStoredSecret?: boolean;
  readonly invalid?: boolean;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  const showSaved = secret && hasStoredSecret && value.length === 0;
  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={id}
        value={value}
        type={secret ? "password" : "text"}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="font-mono"
      />
      {showSaved && (
        <InputGroupAddon align="inline-end">
          <InputGroupText
            className="text-emerald-600 dark:text-emerald-300/90"
            title="Секрет сохранён. Пусто — оставит без изменений; введите, чтобы заменить."
          >
            <CheckIcon />
            сохранён
          </InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
```
> Confirmed exports used: `InputGroup`, `InputGroupAddon`, `InputGroupInput`, `InputGroupText` (all in
> `input-group.tsx`). `aria-invalid` triggers the destructive border (`has-[input[aria-invalid]]`).
> `InputGroupText` is a `<span>` (accepts `title`). No tooltip component imported.

### G14. `RegistryDetail.tsx` — lock the edit pencil while the catalog server is checking (item 6)
BEFORE (the `McpServerDialog` trigger pencil button):
```tsx
            <McpServerDialog
              server={server}
              trigger={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  title="Редактировать сервер"
                  aria-label={`Редактировать ${server.name}`}
                >
                  <PencilIcon className="size-4" />
                </Button>
              }
            />
```
AFTER:
```tsx
            <McpServerDialog
              server={server}
              trigger={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  title={server.checking ? "Идёт проверка…" : "Редактировать сервер"}
                  aria-label={`Редактировать ${server.name}`}
                  disabled={server.checking}
                >
                  <PencilIcon className="size-4" />
                </Button>
              }
            />
```
> The catalog list (`RegistryTab.tsx`) also renders an add `McpServerDialog` (new server, no
> `server` prop ⇒ `server?.checking` is undefined ⇒ never locked). No edit there to lock. Confirm
> during impl that `RegistryTab` only hosts the ADD dialog; if it also hosts an edit pencil, apply
> the same `disabled` (amendment, STOP).

---

## PART H — Tests

### H1. `apps/server/tests/ru-fork/mcp/mcpCore.test.ts` — unchanged logic, no new cases required
The pure `@ru-fork/mcp-core` API is **not** changed by this plan (no resolver/cacheKey/fingerprint
signature change). **No edit.** (`configCacheKey`, `dedupHash`, `missingRequiredVars` all unchanged.)

### H2. Supervisor unit tests — new file `apps/server/tests/ru-fork/mcp/supervisorDue.test.ts`
Covers the pure due-logic changes (items 1, 2). Uses the exported `isSweepDue` / `isProbeDue` /
`SupervisorInstance` — all from `McpSupervisor.ts` (single import). Full file:
```ts
// ru-fork: pure due-gate tests for the monitoring redesign — never-probed is NEVER auto-due
// (no probing on load), and 0 intervals disable re-checks.
import {
  isProbeDue,
  isSweepDue,
  type SupervisorInstance,
} from "../../../src/ru-fork/mcp/McpSupervisor.ts";
import { describe, expect, it } from "vitest";

const base = (over: Partial<SupervisorInstance>): SupervisorInstance => ({
  hash: "h",
  configKey: "k",
  resolved: { transport: "http", httpUrl: "https://x", headers: {} },
  refs: new Set(["p:s"]),
  status: "unchecked",
  message: null,
  latencyMs: null,
  checkedAt: null,
  checkedAtMs: null,
  discoveredTools: [],
  consecutiveFailures: 0,
  ...over,
});

describe("isProbeDue", () => {
  it("never-probed is NOT due (no probing on load)", () => {
    expect(isProbeDue(base({ checkedAtMs: null }), 1_000_000, 60_000, 60_000)).toBe(false);
  });
  it("0 interval ⇒ not due even after time", () => {
    expect(isProbeDue(base({ checkedAtMs: 0 }), 10_000_000, 0, 0)).toBe(false);
  });
  it("probed + interval elapsed ⇒ due", () => {
    expect(isProbeDue(base({ checkedAtMs: 0 }), 120_000, 0, 60_000)).toBe(true);
  });
});

describe("isSweepDue", () => {
  it("never-probed is excluded", () => {
    expect(isSweepDue(base({ checkedAtMs: null }), null, 1, 60_000, 60_000)).toBe(false);
  });
  it("probed but outside watched scope ⇒ not due", () => {
    expect(
      isSweepDue(base({ checkedAtMs: 0, refs: new Set(["p:s"]) }), new Set(["other"]), 999_999_999, 1, 1),
    ).toBe(false);
  });
});
```
> `isProbeDue`, `isSweepDue`, and `SupervisorInstance` are all exported from `McpSupervisor.ts`
> (confirmed). `ResolvedServerConfig` allows the http shape `{ transport, httpUrl, headers }` used in
> `base` (command/args/env/cwd/timeoutMs all optional — confirmed in `resolver.ts`).

### H3. Decider keep-secret test — extend the existing decider/secrets test (if present) or add
`apps/server/tests/ru-fork/mcp/secretsKeep.test.ts`. Full file:
```ts
// ru-fork: splitServerVars / splitBindingVarValues preserve untouched secrets (item 13).
import type { McpServerVar } from "@t3tools/contracts";
import { McpServerId, ProjectId } from "@t3tools/contracts";
import { splitBindingVarValues, splitServerVars } from "../../../src/ru-fork/mcp/McpSecrets.ts";
import { ServerSecretStore } from "../../../src/auth/Services/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

const store = new Map<string, Uint8Array>();
const FakeSecretStore = Layer.succeed(ServerSecretStore, {
  get: (name) => Effect.succeed(store.get(name) ?? null),
  set: (name, value) => Effect.sync(() => void store.set(name, value)),
  getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  remove: (name) => Effect.sync(() => void store.delete(name)),
  pruneByPrefix: () => Effect.void,
});

const run = <A>(effect: Effect.Effect<A, unknown, ServerSecretStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(FakeSecretStore)));

describe("splitServerVars keepSecret", () => {
  it("reuses the existing ref when keepSecret is set and value is blank", async () => {
    const existing: ReadonlyArray<McpServerVar> = [
      { name: "TOKEN", secret: true, perProject: false, required: false, value: { secretRef: "mcp-var-old" } },
    ];
    const result = await run(
      splitServerVars(
        McpServerId.make("srv-x"),
        [{ name: "TOKEN", secret: true, perProject: false, required: false, value: null, keepSecret: true }],
        existing,
      ),
    );
    expect(result[0]?.value).toEqual({ secretRef: "mcp-var-old" });
  });
  it("re-splits when a new value is provided", async () => {
    const result = await run(
      splitServerVars(
        McpServerId.make("srv-x"),
        [{ name: "TOKEN", secret: true, perProject: false, required: false, value: "new" }],
        [],
      ),
    );
    expect(typeof result[0]?.value === "object" && result[0]?.value !== null).toBe(true);
  });
});

describe("splitBindingVarValues keepNames", () => {
  it("preserves an existing per-project secret ref when kept", async () => {
    const result = await run(
      splitBindingVarValues({
        projectId: ProjectId.make("p1"),
        serverId: McpServerId.make("srv-x"),
        vars: [{ name: "SPACE", secret: true, perProject: true, required: true, value: null }],
        draftVarValues: {},
        keepNames: ["SPACE"],
        existing: { SPACE: { secretRef: "mcp-var-srv-x-SPACE-p1" } },
      }),
    );
    expect(result["SPACE"]).toEqual({ secretRef: "mcp-var-srv-x-SPACE-p1" });
  });
});
```
> **Plan-verification note:** confirm `ServerSecretStore`'s `Context.Service` allows
> `Layer.succeed(ServerSecretStore, {...})` with this exact shape (the new `pruneByPrefix` member is
> required by the interface, included above). If the service tag requires a class instance instead
> of a plain object, switch to `Layer.succeed(ServerSecretStore, ServerSecretStore.of({...}))` —
> that exact change is a pre-approved amendment.

### H4. Secret-store prune — **no dedicated test (deliberate)**
`pruneByPrefix` is best-effort GC over the real `NodeFileSystem` + `ServerConfig` (heavy to stand up
in `test:fast`, and it swallows errors by design). It is validated by: (a) typecheck of the new
interface member + Live implementation, (b) the H3 fake which includes `pruneByPrefix` in the service
shape (so the shape stays correct), and (c) the reactor integration at runtime. **This is an explicit,
logged scope boundary — not a silent gap.** No file is written for H4.

### H5. Reactor behavior is integration-heavy (engine + projections). **No new reactor unit test** —
the eager-probe / GC / prune paths are covered by typecheck + the existing reactor test
(`supervisorDecisions.test.ts`, if it exercises reconcile) and manual run. Logged as a deliberate
scope boundary, not an oversight: a full reactor harness (engine + DB + supervisor) is out of
`test:fast` scope.

---

## PART I — Gates & sequencing

Implementation order (each step compiles before the next; commit at the checkpoints):
1. **Checkpoint commit** the already-green UI rework currently uncommitted (no behavior in this plan
   depends on it staying uncommitted).
2. PART A (contracts) → PART B (secret store) → PART F1 (prefix) — pure additions, compile first.
3. PART C (supervisor) → H2 test.
4. PART E (overlay state + reactor + spawn) — race fix.
5. PART D (reactor eager probe + GC + prune).
6. PART F2–F5 (secrets/decider keep-secret) → H3 test.
7. PART G (web) — statuses, checking, locks, SecretField, warn.
8. Gates: `pnpm typecheck` (10/10), `pnpm lint` (0/0), `pnpm test:fast` (only 4 preexisting
   `bin.test.ts`). Commit green.

Every step ends green or it is a STOP.

---

## PART J — Extra features added (gaps I found; flagged for your approval)

These are NOT in your 14 but are required for the 14 to be correct/consistent. They are part of the
plan above; listed here so you can veto:

- **J1 (in A2/A3/G):** `checking` is a first-class snapshot field, not derived — needed so a server
  can be "online **and** re-checking" (your item 5) without flicker to "connecting".
- **J2 (in C2/G1):** `"unchecked"` is a real status end-to-end (contract → supervisor → UI), so item
  4's neutral state survives reload and is distinct from "connecting".
- **J3 (in G3/G1):** catalog-tile **incomplete** (`«требует настройки»`) for a catalog server whose
  default can't be probed (required defaultless var) — item 7 applied to the Каталог tab, not just
  bindings. Without it the catalog tile would sit on "не проверено" forever with no explanation.
- **J4 (in D4/F):** orphaned-`varValues` prune is **ref-preserving** (rides `mcp.binding-set` +
  `keepVarValues`) so it never needs plaintext and never wipes a surviving secret — the only correct
  way to implement item 11 given write-only secrets.
- **J5 (in G11):** warn-on-impact uses a **two-click confirm** (banner → Save again) instead of a
  nested AlertDialog, to avoid a dialog-in-dialog focus trap. If you prefer a modal AlertDialog,
  that is a one-component swap (amendment).
- **J6 (proposed, NOT yet in the plan body):** a manual **"Проверить всё"** action in the panel
  header that calls `recheck({})` — with the loop now opt-in (item 1), a global manual sweep is the
  natural way to refresh everything on demand. Say the word and I add the exact edit (RecheckButton
  already supports an empty filter).

---

## Item coverage matrix (final check — every requirement has a concrete edit)

| # | Concrete edits |
|---|---|
| 1 | C6 (both-0 early-out) |
| 2 | C1 (isSweepDue/isProbeDue never-probed→false), D5 (startup reconcile not eager) |
| 3 | C3 (reconcile returns added), C4 (probeHashes), D1/D2/D5 (eager wiring) |
| 4 | A1 (unchecked), C2 (register unchecked), G1/G2/G3 (UI status) |
| 5 | A2/A3 (checking field), C5 (publish on probe start + currentInFlight), C7 (McpRuntime build of checking), G1/G2/G3 |
| 6 | G11a (dialog guard), G12 (binding trigger disabled), G14 (catalog pencil disabled) |
| 7 | computeDesired skip (existing) + G3b/G3c (catalog incomplete UI) + G1 |
| 8 | E1/E2/E4 (shared fingerprint seeded at spawn) |
| 9 | E3 (reactor restarts when a live session exists, via shared fingerprint) |
| 10 | B1/B2 (pruneByPrefix), F1 (prefix), D3 (gcOrphanedSecrets) |
| 11 | A5 (keepVarValues), D4 (prune dispatch), F3/F4/F5 (ref-preserving) |
| 12 | G11b (describeEditImpact + banner) |
| 13 | A4/A5 (keepSecret/keepVarValues), F2/F3/F4/F5 (decider preserve), G5/G7/G10 (UI emit) |
| 14 | A4 (hasStoredSecret source), G6 (types), G3e/G3f (adapter), G8/G10/G13 (SecretField) |

## Plan status: **READY** — all edits specified, all five earlier open items closed
1. ✅ **McpRuntime `checking` build** — written as PART C7 (exact before/after, both snapshot kinds).
2. ✅ **Layer wiring (E2/E4)** — `McpOverlayStateLive` rides `McpOverlayLive`'s existing `provideMerge`
   exposure; confirmed reachable by `ProviderCommandReactor`; no orchestration-layer edit.
3. ✅ **H4** — deliberately no dedicated FS test (best-effort GC); logged, not silent.
4. ✅ **G13** — `SecretAwareInput` uses confirmed `input-group` exports + native `title` (no tooltip
   dependency).
5. ✅ **F1** — exact literal site in `McpSecretNames.ts` confirmed; before/after given.

### New-files checklist (created by this plan)
- `apps/server/src/ru-fork/mcp/McpOverlayState.ts` (E1)
- `apps/web/src/ru-fork/mcp-manage/components/SecretAwareInput.tsx` (G13)
- `apps/server/tests/ru-fork/mcp/supervisorDue.test.ts` (H2)
- `apps/server/tests/ru-fork/mcp/secretsKeep.test.ts` (H3)

### Files edited (with the imports each gains)
- `packages/contracts/src/ru-fork/mcp.ts` — no new imports (Schema in scope).
- `apps/server/src/auth/Services/ServerSecretStore.ts` — no new imports.
- `apps/server/src/auth/Layers/ServerSecretStore.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpSupervisor.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpRuntime.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpReactor.ts` — `+ collectVarSecretRefs` (McpSecrets),
  `+ MCP_VAR_SECRET_PREFIX` (McpSecretNames), `+ McpOverlayState` (McpOverlayState); **− `import * as
  Ref`** (now unused after removing `overlayFingerprintsRef` — verify no other `Ref.` use; STOP if any).
- `apps/server/src/ru-fork/mcp/McpLayers.ts` — `+ McpOverlayStateLive`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — `+ McpOverlayState`.
- `apps/server/src/ru-fork/mcp/McpSecretNames.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpSecrets.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpCatalogBuilders.ts` — no new imports.
- `apps/server/src/ru-fork/mcp/McpDefaults.ts` — untouched by this plan.
- `apps/server/src/orchestration/decider.ts` — no new imports (signatures unchanged at call sites).
- `apps/web/.../types.ts`, `visuals.ts`, `adapters.ts`, `useMcp.ts`, `serverConfigForm.ts`,
  `addMcpParsing.ts` — imports listed in each section (G6/G2/G3/G5/G11/G9).
- `apps/web/.../components/VarsEditor.tsx`, `ProjectConfigDialog.tsx`, `McpServerDialog.tsx`,
  `ProjectBindingRow.tsx`, `RegistryDetail.tsx` — imports listed in each section.

### Residual STOP-conditions to verify at implementation time (read-only checks, no latitude)
- McpReactor: confirm `Ref` is used **only** by `overlayFingerprintsRef`; if so its import line is
  removed, else kept. (Grep at impl.)
- ProjectConfigDialog: confirm `Input` is unused after the `SecretAwareInput` swap; remove its import.
- `ServerSecretStore` Live: confirm the exact `return { ... }` member list before appending
  `pruneByPrefix`.
- H3: if `Context.Service` rejects a bare object in `Layer.succeed`, use `ServerSecretStore.of({...})`.
Each is a confirm-then-apply with the exact fallback already named here — no improvisation.

---
---

# PART K — Managed built-ins / templates + config-model deltas (REVISION 2)

> Implements D-builtins, D-config-model, D-fork-removed. Replaces `McpDefaults.ts` +
> `seedBuiltinsIfEmpty` + the fork-to-custom concept. Built on the locked design in REVISION 2.
> **Supersedes:** PART A4 stays; PART F5's `mcp.server-add` `splitServerVars(...,[])` and the
> `mcp.server-update` `splitServerVars(...,existing.vars)` calls are extended here (origin); the
> `applyServerUpdate` `source:"builtin"→"custom"` fork line is **removed** (K5).

## K1. Contract deltas (`packages/contracts/src/ru-fork/mcp.ts`)

### K1a. Var `origin` (shipped vs user) — enables the migrator 3-way merge
`McpServerVar` BEFORE:
```ts
export const McpServerVar = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  required: Schema.Boolean,
  value: Schema.NullOr(McpVarValue),
});
export type McpServerVar = typeof McpServerVar.Type;
```
AFTER (add `origin`; legacy/manual JSON without it decodes as `"user"`):
```ts
// shipped = declared by a built-in template (replaced wholesale on a template update);
// user = added by the user (preserved across updates). Manual servers: all vars are "user".
export const McpServerVarOrigin = Schema.Literals(["shipped", "user"]);
export type McpServerVarOrigin = typeof McpServerVarOrigin.Type;

export const McpServerVar = Schema.Struct({
  name: TrimmedNonEmptyString,
  secret: Schema.Boolean,
  perProject: Schema.Boolean,
  // "must resolve to a non-empty value" at ANY level: a catalog-level required var with no value
  // makes the CATALOG server incomplete; a per-project required var with no value makes the BINDING
  // incomplete. (Widened from "only meaningful when perProject".)
  required: Schema.Boolean,
  value: Schema.NullOr(McpVarValue),
  origin: McpServerVarOrigin.pipe(Schema.withDecodingDefault(() => "user")),
});
export type McpServerVar = typeof McpServerVar.Type;
```
> The comment in lines 53-59 (`// required (only meaningful when perProject)`) is updated to the
> widened meaning (drop "only meaningful when perProject"). `withDecodingDefault` needs no new import
> (it's `Schema.*`); pattern mirrors `settings.ts` (`Schema.withDecodingDefault(Effect.succeed(false))`)
> — **but** `settings.ts` passes an `Effect`. **Exact form to use:** `Schema.withDecodingDefault(() =>
> "user")` if the thunk overload exists; else `Schema.withDecodingDefault(Effect.succeed<McpServerVarOrigin>("user"))`
> and add `import * as Effect from "effect/Effect";` to mcp.ts. **STOP-check at impl:** confirm which
> overload `effect/Schema` beta.59 exposes; use the thunk if available (no Effect import), else the
> Effect form (with the import). Both are pre-approved.

### K1b. `McpServerVarDraft` — user drafts carry no origin (always "user" at split time)
No change to `McpServerVarDraft` for origin (the decider's `splitServerVars` stamps `origin:"user"`).
`keepSecret` is added by A4 (kept).

### K1c. `McpCatalogServer` — builtin identity + lock + extraArgs
BEFORE:
```ts
export const McpCatalogServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(TrimmedNonEmptyString),
  source: McpServerSource,
  config: McpServerConfig, // pure template
  vars: Schema.Array(McpServerVar),
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
```
AFTER:
```ts
export const McpCatalogServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(TrimmedNonEmptyString),
  source: McpServerSource,
  config: McpServerConfig, // pure template (command/args LOCKED for templates)
  vars: Schema.Array(McpServerVar),
  // ru-fork: user-appendable args (with `${VAR}` holes), appended after `config.args`. Empty for
  // manual servers (their whole command is editable). The escape hatch for a LOCKED template.
  extraArgs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  // ru-fork: managed-built-in identity. builtinId = the stable hidden reconciliation key (null for
  // user-created/manual). builtinHash = content hash of the shipped definition last applied (drives
  // "shipped template changed → update"). locked = command/args are read-only (a template).
  builtinId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  builtinHash: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  locked: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
```

### K1d. Drafts/patches gain `extraArgs` (user-editable)
`McpServerDraft` BEFORE:
```ts
export const McpServerDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  config: McpServerConfig,
  vars: Schema.Array(McpServerVarDraft),
  timeoutMs: McpTimeoutMsDraft,
});
```
AFTER (manual add carries the full editable command + optional extraArgs):
```ts
export const McpServerDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  config: McpServerConfig,
  vars: Schema.Array(McpServerVarDraft),
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: McpTimeoutMsDraft,
});
```
`McpServerDraftPatch` BEFORE:
```ts
export const McpServerDraftPatch = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  config: Schema.optionalKey(McpServerConfig),
  vars: Schema.optionalKey(Schema.Array(McpServerVarDraft)),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
```
AFTER (extraArgs editable; config/vars patch is REJECTED for locked templates in the decider — K5):
```ts
export const McpServerDraftPatch = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  config: Schema.optionalKey(McpServerConfig),
  vars: Schema.optionalKey(Schema.Array(McpServerVarDraft)),
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)))),
});
```

### K1e. The builtin-sync command + event (migrator → decider, NO fork, carries identity)
Add a new command/event so the migrator can add/update a managed built-in without going through the
user draft path (which would fork / re-split secrets). Built-ins ship **declarations only** (secret
vars have `value:null`), so no secret-store interaction at sync time. Add near the other command
payload helpers (after `McpBindingRemovedPayload`):
```ts
// ru-fork: migrator → catalog. A managed built-in's shipped definition (platform-resolved,
// command LOCKED). vars carry origin:"shipped" with value:null for secrets (no plaintext shipped).
export const McpBuiltinSyncInput = Schema.Struct({
  serverId: McpServerId,
  builtinId: TrimmedNonEmptyString,
  builtinHash: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(TrimmedNonEmptyString),
  config: McpServerConfig,
  shippedVars: Schema.Array(McpServerVar),
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
});
export type McpBuiltinSyncInput = typeof McpBuiltinSyncInput.Type;
```
> The actual command type (`type: "mcp.builtin-sync"`) and its event (`mcp.server-updated` reuse, or a
> new `mcp.builtin-synced`) are declared in `orchestration.ts` alongside the existing `mcp.server-*`
> commands. **Exact orchestration.ts edits are in K1f below** (read that file at impl; the command set
> lives there, mirroring `mcp.server-add`). The migrator also needs `mcp.builtin-remove` (a thin alias
> of `mcp.server-remove` is sufficient — the migrator can dispatch the existing `mcp.server-remove`
> for removals, so **no new remove command**; only add/update needs the no-fork path).

### K1f. orchestration.ts — register `mcp.builtin-sync`
> **Read `packages/contracts/src/orchestration.ts` at impl** (the `mcp.server-add`/`update`/`remove`
> command + event union). Add a `mcp.builtin-sync` command carrying `McpBuiltinSyncInput`'s fields +
> `commandId`, and reuse the existing `mcp.server-updated` / `mcp.server-added` events (payload =
> `{ server: McpCatalogServer }`) — the migrator's decider branch builds the full `McpCatalogServer`
> and emits the SAME event the projection already handles, so **no projection/event change**, only a
> new command. Exact before/after captured at impl from the file (the command union is mechanical;
> mirror `mcp.server-add`). **STOP-marker:** if the event union can't be reused (e.g. add vs update
> distinction needed), add `mcp.builtin-synced` with payload `{ server: McpCatalogServer }` and a
> projector case mirroring `catalog-upserted` — pre-approved.

## K2. Resolver + mcp-core (`packages/mcp-core/src/resolver.ts`)

### K2a. `extraArgs` appended to resolved args + folded into the cache key
`resolveConfig` must append `extraArgs`. Its input gains `extraArgs`. BEFORE (signature + stdio case):
```ts
export function resolveConfig(input: {
  readonly config: McpServerConfig;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly varValues: Readonly<Record<string, McpVarValue>>;
  readonly timeoutMs: number | undefined;
  readonly context: ResolveContext;
}): ResolvedServerConfig {
  const resolvedVars = resolveVarValues(input.vars, input.varValues, input.context);
  const expand = (value: string) => expandTemplate(value, resolvedVars, input.context.projectCwd);
  const timeout = input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {};
  switch (input.config.transport) {
    case "stdio":
      return {
        transport: "stdio",
        command: expand(input.config.command),
        args: input.config.args.map(expand),
        env: resolvedVars,
        cwd: input.context.projectCwd,
        ...timeout,
      };
```
AFTER (add `extraArgs` to input; append to stdio args; http ignores extraArgs — stdio-only):
```ts
export function resolveConfig(input: {
  readonly config: McpServerConfig;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly varValues: Readonly<Record<string, McpVarValue>>;
  // User-appended args (after the locked template args). Empty for manual/http servers.
  readonly extraArgs: ReadonlyArray<string>;
  readonly timeoutMs: number | undefined;
  readonly context: ResolveContext;
}): ResolvedServerConfig {
  const resolvedVars = resolveVarValues(input.vars, input.varValues, input.context);
  const expand = (value: string) => expandTemplate(value, resolvedVars, input.context.projectCwd);
  const timeout = input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {};
  switch (input.config.transport) {
    case "stdio":
      return {
        transport: "stdio",
        command: expand(input.config.command),
        args: [...input.config.args, ...input.extraArgs].map(expand),
        env: resolvedVars,
        cwd: input.context.projectCwd,
        ...timeout,
      };
```
`configCacheKey` must include `extraArgs` so changing it splits the cache (status reset). BEFORE:
```ts
export function configCacheKey(
  config: McpServerConfig,
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): string {
  const effectiveVars = vars.map((declared) => ({
    name: declared.name,
    secret: declared.secret,
    value: declared.name in varValues ? varValues[declared.name]! : declared.value,
  }));
  return fnv1a(JSON.stringify(canonicalize({ config, vars: effectiveVars })));
}
```
AFTER:
```ts
export function configCacheKey(
  config: McpServerConfig,
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
  extraArgs: ReadonlyArray<string>,
): string {
  const effectiveVars = vars.map((declared) => ({
    name: declared.name,
    secret: declared.secret,
    value: declared.name in varValues ? varValues[declared.name]! : declared.value,
  }));
  return fnv1a(JSON.stringify(canonicalize({ config, vars: effectiveVars, extraArgs })));
}
```
> `overlayFingerprint` needs **no change** — it hashes `dedupHash(resolved)`, and `resolved.args` now
> includes the expanded `extraArgs`, so extraArgs is already in the fingerprint. ✅
> **All `resolveConfig(...)` and `configCacheKey(...)` call sites gain the `extraArgs` argument** —
> enumerated in K2c (no call site missed = no STOP).

### K2b. `missingRequiredVars` widened to any level (required at catalog OR project level)
BEFORE:
```ts
export function missingRequiredVars(
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): ReadonlyArray<string> {
  return vars
    .filter((declared) => declared.perProject && declared.required)
    .filter((declared) => !(declared.name in varValues) && declared.value === null)
    .map((declared) => declared.name);
}
```
AFTER (drop the `perProject` filter — a required var with no effective value is missing at any level):
```ts
export function missingRequiredVars(
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): ReadonlyArray<string> {
  return vars
    .filter((declared) => declared.required)
    .filter((declared) => !(declared.name in varValues) && declared.value === null)
    .map((declared) => declared.name);
}
```
> Effect: a catalog-level (`perProject:false`) required var with `value:null` now makes the catalog
> DEFAULT incomplete (reactor skips probing it; overlay excludes it) AND the catalog tile shows
> «требует настройки» (web `catalogMissingVars` G3b is replaced by a call to this same logic — K8).
> A binding still resolves its own per-project requireds. **Behavior check:** a built-in shipping a
> required catalog-level secret stays «требует настройки» until the user sets it on the catalog
> server — exactly D-config-model.

### K2c. Every `resolveConfig` / `configCacheKey` call site gets `extraArgs`
Call sites (verified by grep — all listed; adding the arg at each is mechanical):
- `McpReactor.ts:112` `resolveConfig({...})` (in `mergeDesired`) → add `extraArgs: server.extraArgs,`.
- `McpReactor.ts:120` `configCacheKey(server.config, server.vars, varValues)` → `..., server.extraArgs)`.
- `McpRuntime.ts:82` `configCacheKey(server.config, server.vars, {})` → `..., server.extraArgs)`.
- `McpOverlay.ts:157` `resolveConfig({...})` → add `extraArgs: server.extraArgs,`.
- `mcpCore.test.ts` (H1) — the resolver tests call `resolveConfig`/`configCacheKey`; **update them to
  pass `extraArgs: []`** (and a 4th `[]` arg to `configCacheKey`). This is the ONE test-file edit in
  this plan that was previously "no edit" — **SUPERSEDES H1's "no edit"**: H1 now adds `extraArgs: []`
  to the test's `resolve`/`configCacheKey` helpers (the `stdioConfig`/`resolve` wrapper at the top
  gains `extraArgs: []`; the three `configCacheKey(stdioConfig, vars, {...})` calls gain a trailing
  `[]`). Exact: the test's local `resolve` helper passes `extraArgs: []` inside `resolveConfig({...})`.

## K3. Migration `031_Mcp.ts` + projection (`ProjectionMcpCatalog.ts`)

### K3a. `031_Mcp.ts` — new columns on `mcp_catalog_server`
BEFORE:
```ts
    CREATE TABLE IF NOT EXISTS mcp_catalog_server (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      source      TEXT NOT NULL,
      config_json TEXT NOT NULL,
      vars_json   TEXT NOT NULL DEFAULT '[]',
      timeout_ms  INTEGER,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
```
AFTER:
```ts
    CREATE TABLE IF NOT EXISTS mcp_catalog_server (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      source          TEXT NOT NULL,
      config_json     TEXT NOT NULL,
      vars_json       TEXT NOT NULL DEFAULT '[]',
      extra_args_json TEXT NOT NULL DEFAULT '[]',
      builtin_id      TEXT,
      builtin_hash    TEXT,
      locked          INTEGER NOT NULL DEFAULT 0,
      timeout_ms      INTEGER,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
```

### K3b. `ProjectionMcpCatalog.ts` — row schema + upsert + selects
`McpCatalogServerDbRow` BEFORE:
```ts
const McpCatalogServerDbRow = McpCatalogServer.mapFields(
  Struct.assign({
    config: Schema.fromJsonString(McpServerConfig),
    vars: Schema.fromJsonString(Schema.Array(McpServerVar)),
  }),
);
```
AFTER (decode the JSON columns; `locked` is an INTEGER 0/1 → boolean):
```ts
const McpCatalogServerDbRow = McpCatalogServer.mapFields(
  Struct.assign({
    config: Schema.fromJsonString(McpServerConfig),
    vars: Schema.fromJsonString(Schema.Array(McpServerVar)),
    extraArgs: Schema.fromJsonString(Schema.Array(Schema.String)),
    locked: Schema.transform(Schema.Int, Schema.Boolean, {
      decode: (n) => n !== 0,
      encode: (b) => (b ? 1 : 0),
    }),
  }),
);
```
> **STOP-check:** confirm the exact `Schema.transform` arg order/signature in beta.59 (decode/encode
> object vs positional). If it differs, use the codebase's established Int↔Boolean pattern (grep
> `Schema.transform` in persistence for the exact shape) — pre-approved to match local convention.
`upsertRow` BEFORE:
```ts
      sql`
        INSERT INTO mcp_catalog_server (
          id, name, description, source, config_json, vars_json, timeout_ms, created_at, updated_at
        ) VALUES (
          ${server.id}, ${server.name}, ${server.description}, ${server.source},
          ${JSON.stringify(server.config)}, ${JSON.stringify(server.vars)}, ${server.timeoutMs},
          ${server.createdAt}, ${server.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source = excluded.source,
          config_json = excluded.config_json,
          vars_json = excluded.vars_json,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
      `,
```
AFTER:
```ts
      sql`
        INSERT INTO mcp_catalog_server (
          id, name, description, source, config_json, vars_json, extra_args_json,
          builtin_id, builtin_hash, locked, timeout_ms, created_at, updated_at
        ) VALUES (
          ${server.id}, ${server.name}, ${server.description}, ${server.source},
          ${JSON.stringify(server.config)}, ${JSON.stringify(server.vars)},
          ${JSON.stringify(server.extraArgs)}, ${server.builtinId}, ${server.builtinHash},
          ${server.locked ? 1 : 0}, ${server.timeoutMs}, ${server.createdAt}, ${server.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source = excluded.source,
          config_json = excluded.config_json,
          vars_json = excluded.vars_json,
          extra_args_json = excluded.extra_args_json,
          builtin_id = excluded.builtin_id,
          builtin_hash = excluded.builtin_hash,
          locked = excluded.locked,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
      `,
```
`getRow` + `listRows` SELECT lists BEFORE (both share the same column list):
```ts
        SELECT id, name, description, source, config_json AS "config", vars_json AS "vars",
               timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM mcp_catalog_server ...
```
AFTER (both):
```ts
        SELECT id, name, description, source, config_json AS "config", vars_json AS "vars",
               extra_args_json AS "extraArgs", builtin_id AS "builtinId", builtin_hash AS "builtinHash",
               locked AS "locked", timeout_ms AS "timeoutMs", created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM mcp_catalog_server ...
```
> Apply to **both** `getRow` (`WHERE id = ${serverId}`) and `listRows` (`ORDER BY created_at ASC, id ASC`).

## K4. Prebuild file `apps/server/src/ru-fork/mcp/McpBuiltins.ts` (replaces `McpDefaults.ts`)

New file — the shipped catalog as managed templates. `McpDefaults.ts` is **deleted**; its
`isBuiltinServerId` is no longer used (the migrator keys on `builtinId`). Full body:
```ts
// ru-fork: the shipped built-in MCP catalog — managed TEMPLATES. The migrator (McpReactor)
// reconciles these against the installed catalog by `builtinId` on every startup: add new, update
// changed (by content hash), remove deleted. Command/args are LOCKED; the user configures var
// VALUES + `extraArgs`. Per-platform variants; a platform with no variant is skipped. Ship
// DECLARATIONS only — never real secret values.

import * as os from "node:os";

import type { McpServerConfig, McpServerVar } from "@t3tools/contracts";

/** A var DECLARATION shipped by a template (no secret value — value is null for secrets). */
export interface McpBuiltinVar {
  readonly name: string;
  readonly secret: boolean;
  readonly perProject: boolean;
  readonly required: boolean;
  /** A non-secret default; null = a hole the user fills. Secrets are always null here. */
  readonly value: string | null;
}

/** A built-in template. `config` is per-platform; the migrator picks `process.platform`. */
export interface McpBuiltinDefinition {
  readonly builtinId: string; // stable hidden reconciliation key — NEVER rename
  readonly name: string;
  readonly description?: string;
  /** Per-platform locked command/args. A missing key for the current platform ⇒ skip the built-in. */
  readonly config: Partial<Record<NodeJS.Platform, McpServerConfig>> & {
    readonly default?: McpServerConfig;
  };
  readonly vars: ReadonlyArray<McpBuiltinVar>;
  readonly timeoutMs?: number;
}

export const MCP_BUILTINS: ReadonlyArray<McpBuiltinDefinition> = [
  {
    builtinId: "filesystem",
    name: "filesystem",
    description:
      "Чтение и запись файлов в каталоге проекта. Запускается локально через npx, без секретов.",
    config: {
      default: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "${PROJECT_CWD}"],
      },
    },
    vars: [],
  },
  {
    builtinId: "context7",
    name: "context7",
    description: "Актуальная документация библиотек и фреймворков. Публичный HTTP-эндпоинт.",
    config: { default: { transport: "http", httpUrl: "https://mcp.context7.com/mcp", headers: {} } },
    vars: [],
  },
];

/** Pick the platform-specific config (current OS, else `default`); null ⇒ unsupported ⇒ skip. */
export function builtinConfigForPlatform(
  definition: McpBuiltinDefinition,
  platform: NodeJS.Platform,
): McpServerConfig | null {
  return definition.config[platform] ?? definition.config.default ?? null;
}

/** Shipped vars as domain `McpServerVar`s (origin:"shipped"; secrets carry value:null). */
export function builtinShippedVars(definition: McpBuiltinDefinition): ReadonlyArray<McpServerVar> {
  return definition.vars.map((variable) => ({
    name: variable.name,
    secret: variable.secret,
    perProject: variable.perProject,
    required: variable.required,
    value: variable.value,
    origin: "shipped",
  }));
}

/**
 * Content hash of the SHIPPED parts (platform-resolved config + shipped var declarations + timeout +
 * name/description). Drives "shipped template changed → update". Excludes user data by construction
 * (user vars/values/extraArgs are not part of the definition). Stable JSON of sorted keys.
 */
export function builtinHash(config: McpServerConfig, definition: McpBuiltinDefinition): string {
  const canonical = JSON.stringify({
    name: definition.name,
    description: definition.description ?? null,
    config,
    vars: builtinShippedVars(definition),
    timeoutMs: definition.timeoutMs ?? null,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The catalog serverId for a built-in (stable, derived from builtinId). */
export function builtinServerId(builtinId: string): string {
  return `srv-builtin-${builtinId}`;
}
```
> `os` import is present for symmetry but `process.platform` is used by the caller (the migrator
> passes it in) — **remove the `os` import** (the migrator reads `process.platform`; this file is
> pure given a platform arg). **Correction applied here:** drop `import * as os` (unused). The
> migrator (K7) passes `process.platform`.

## K5. Decider (`decider.ts`) + builders (`McpCatalogBuilders.ts`)

### K5a. Drop the fork-to-custom on update
`McpCatalogBuilders.applyServerUpdate` BEFORE:
```ts
    source: existing.source === "builtin" ? "custom" : existing.source,
```
AFTER (never fork — templates stay managed; manual stay custom):
```ts
    source: existing.source,
```
And `applyServerUpdate` must preserve `extraArgs`/`builtinId`/`builtinHash`/`locked` + apply an
`extraArgs` patch. BEFORE (the full return):
```ts
export function applyServerUpdate(
  existing: McpCatalogServer,
  patch: McpServerDraftPatch,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: existing.id,
    name: patch.name ?? existing.name,
    description: applyDescriptionPatch(existing.description, patch.description),
    source: existing.source === "builtin" ? "custom" : existing.source,
    config: patch.config ?? existing.config,
    vars,
    timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs,
    createdAt: existing.createdAt,
    updatedAt: occurredAt,
  };
}
```
AFTER (locked templates reject config/shipped-var changes — enforced in the decider K5c; here we
carry the managed fields through and apply the extraArgs patch):
```ts
export function applyServerUpdate(
  existing: McpCatalogServer,
  patch: McpServerDraftPatch,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: existing.id,
    name: patch.name ?? existing.name,
    description: applyDescriptionPatch(existing.description, patch.description),
    source: existing.source,
    // A locked template keeps its shipped command; the decider rejects a config patch for it (K5c).
    config: existing.locked ? existing.config : (patch.config ?? existing.config),
    vars,
    extraArgs: patch.extraArgs ?? existing.extraArgs,
    builtinId: existing.builtinId,
    builtinHash: existing.builtinHash,
    locked: existing.locked,
    timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs,
    createdAt: existing.createdAt,
    updatedAt: occurredAt,
  };
}
```
`buildAddedServer` (manual add) BEFORE:
```ts
export function buildAddedServer(
  serverId: McpServerId,
  draft: McpServerDraft,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: serverId,
    name: draft.name,
    description: draft.description ?? null,
    source: isBuiltinServerId(serverId) ? "builtin" : "custom",
    config: draft.config,
    vars,
    timeoutMs: draft.timeoutMs ?? null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}
```
AFTER (manual add is always `custom`, `locked:false`, no builtin identity; `isBuiltinServerId`
deleted with `McpDefaults.ts`):
```ts
export function buildAddedServer(
  serverId: McpServerId,
  draft: McpServerDraft,
  vars: ReadonlyArray<McpServerVar>,
  occurredAt: string,
): McpCatalogServer {
  return {
    id: serverId,
    name: draft.name,
    description: draft.description ?? null,
    source: "custom",
    config: draft.config,
    vars,
    extraArgs: draft.extraArgs ?? [],
    builtinId: null,
    builtinHash: null,
    locked: false,
    timeoutMs: draft.timeoutMs ?? null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}
```
> Remove `import { isBuiltinServerId } from "./McpDefaults.ts";` from `McpCatalogBuilders.ts`.

### K5b. New builder `buildSyncedBuiltin` (migrator 3-way merge)
Add to `McpCatalogBuilders.ts`:
```ts
/**
 * Build the catalog row for a managed built-in from its shipped definition, merged over any existing
 * row: shipped command/vars REPLACE; user data (origin:"user" vars, var VALUES by name, extraArgs)
 * is PRESERVED. Source is always "builtin", command locked. No secret-store interaction (shipped
 * vars carry value:null; user values are kept verbatim by name).
 */
export function buildSyncedBuiltin(input: {
  readonly serverId: McpServerId;
  readonly builtinId: string;
  readonly builtinHash: string;
  readonly name: string;
  readonly description: string | null;
  readonly config: McpServerConfig;
  readonly shippedVars: ReadonlyArray<McpServerVar>;
  readonly timeoutMs: number | null;
  readonly existing: McpCatalogServer | undefined;
  readonly occurredAt: string;
}): McpCatalogServer {
  const existingByName = new Map((input.existing?.vars ?? []).map((v) => [v.name, v]));
  // Shipped vars keep the user's configured VALUE (by name) when one exists; else the shipped value.
  const shipped = input.shippedVars.map((variable): McpServerVar => {
    const prior = existingByName.get(variable.name);
    const keptValue = prior && prior.value !== null ? prior.value : variable.value;
    return { ...variable, value: keptValue };
  });
  // User-added vars (origin:"user") survive a template update verbatim.
  const userVars = (input.existing?.vars ?? []).filter((v) => v.origin === "user");
  return {
    id: input.serverId,
    name: input.name,
    description: input.description,
    source: "builtin",
    config: input.config,
    vars: [...shipped, ...userVars],
    extraArgs: input.existing?.extraArgs ?? [],
    builtinId: input.builtinId,
    builtinHash: input.builtinHash,
    locked: true,
    timeoutMs: input.timeoutMs,
    createdAt: input.existing?.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };
}
```

### K5c. Decider branches
`mcp.server-add` (manual) BEFORE:
```ts
      const vars = yield* splitServerVars(command.serverId, command.draft.vars);
```
AFTER (stamp origin:"user"; no existing vars on add):
```ts
      const vars = yield* splitServerVars(command.serverId, command.draft.vars, []);
```
`mcp.server-update` BEFORE:
```ts
      const existing = yield* requireCatalogServer({ readModel, command, serverId: command.serverId });
      const occurredAt = yield* nowIso;
      const vars = command.patch.vars
        ? yield* splitServerVars(command.serverId, command.patch.vars)
        : existing.vars;
```
AFTER (a LOCKED template rejects a `config` patch or a `vars` patch that changes SHIPPED declarations;
user vars + values pass through; `splitServerVars` gets `existing.vars` for keepSecret):
```ts
      const existing = yield* requireCatalogServer({ readModel, command, serverId: command.serverId });
      const occurredAt = yield* nowIso;
      // Identity lock: a template's command and shipped var declarations are read-only. A patch that
      // would change them is rejected; configuring (extraArgs, var values, user vars) is allowed.
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
> `mergeTemplateVars` = a helper (in `McpCatalogBuilders.ts`) that, for a locked template, splits the
> draft vars (origin:"user") and concatenates them with the existing SHIPPED vars (preserving shipped
> declarations + values); for an unlocked server, behaves like the old `splitServerVars(serverId,
> patch.vars, existing.vars)` (all user). Exact helper:
```ts
/** Vars for a server-update: locked template → existing shipped + split user drafts; else all user. */
export function mergeTemplateVars(
  serverId: McpServerId,
  existing: McpCatalogServer,
  draftVars: ReadonlyArray<McpServerVarDraft>,
): Effect.Effect<ReadonlyArray<McpServerVar>, SecretStoreError, ServerSecretStore> {
  return Effect.gen(function* () {
    const userVars = yield* splitServerVars(serverId, draftVars, existing.vars);
    if (!existing.locked) {
      return userVars;
    }
    const shipped = existing.vars.filter((v) => v.origin === "shipped");
    return [...shipped, ...userVars];
  });
}
```
> `splitServerVars` must stamp `origin:"user"` on every var it produces (K6). `mcp.server-add`'s
> `buildAddedServer` already yields user-origin vars via `splitServerVars(...,[])`.
`mcp.builtin-sync` (NEW decider branch, after `mcp.server-update`):
```ts
    case "mcp.builtin-sync": {
      const existing = findCatalogServer(readModel, command.serverId); // undefined ⇒ add
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "mcp-catalog",
          aggregateId: MCP_CATALOG_AGGREGATE_ID,
          occurredAt,
          commandId: command.commandId,
        }),
        type: existing ? "mcp.server-updated" : "mcp.server-added",
        payload: {
          server: buildSyncedBuiltin({
            serverId: command.serverId,
            builtinId: command.builtinId,
            builtinHash: command.builtinHash,
            name: command.name,
            description: command.description,
            config: command.config,
            shippedVars: command.shippedVars,
            timeoutMs: command.timeoutMs,
            existing,
            occurredAt,
          }),
        },
      };
    }
```
> `findCatalogServer(readModel, serverId)` — the read-model lookup used by `requireCatalogServer`
> (reuse the existing non-throwing finder; **read decider.ts at impl** for its exact name — likely
> the same helper `requireCatalogServer` wraps). Imports added to decider.ts: `buildSyncedBuiltin`
> (from McpCatalogBuilders), `McpBuiltinSyncInput` types via the command union. `OrchestrationCommandInvariantError`
> is already imported (used in the default branch).

## K6. `McpSecrets.splitServerVars` stamps `origin:"user"`
Extends F2. The F2 AFTER `result.push({ ...base, value })` — `base` must include `origin:"user"`.
BEFORE (F2's `base`):
```ts
      const base = {
        name: draft.name,
        secret: draft.secret,
        perProject: draft.perProject,
        required: draft.required,
      };
```
AFTER:
```ts
      const base = {
        name: draft.name,
        secret: draft.secret,
        perProject: draft.perProject,
        required: draft.required,
        origin: "user" as const,
      };
```
> `"user" as const` is a literal annotation, not a type assertion on a value of wrong type — it
> narrows the string literal so `base.origin: "user"`. (Memory's "no `as`" targets unsafe casts;
> `as const` on a literal is the idiomatic narrow. If the lint forbids `as const` broadly, use a typed
> local: `const origin: McpServerVarOrigin = "user";` and spread — pre-approved fallback.)

## K7. Reactor migrator (`McpReactor.ts`) — replaces `seedBuiltinsIfEmpty`
Replace the import + the seed function + its call.
Import BEFORE: `import { MCP_BUILTIN_SERVERS } from "./McpDefaults.ts";`
Import AFTER:
```ts
import {
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  MCP_BUILTINS,
} from "./McpBuiltins.ts";
```
`seedBuiltinsIfEmpty` (the whole function, lines 279-315) is REPLACED by `reconcileBuiltins`:
```ts
  // Reconcile shipped built-ins against the installed catalog by builtinId: add new, update on
  // content-hash change (3-way merge preserves user values/vars/extraArgs), remove deleted. Runs at
  // startup. NOT eager (no probing on load). Unsupported platform (no config variant) ⇒ skip.
  const reconcileBuiltins = Effect.gen(function* () {
    const platform = process.platform;
    const catalog = yield* catalogRepository.listAll();
    const installedByBuiltinId = new Map(
      catalog.filter((s) => s.builtinId !== null).map((s) => [s.builtinId, s]),
    );
    const shippedBuiltinIds = new Set<string>();
    for (const definition of MCP_BUILTINS) {
      const config = builtinConfigForPlatform(definition, platform);
      if (config === null) {
        continue; // unsupported on this OS — skip (D-builtins ⑦A)
      }
      shippedBuiltinIds.add(definition.builtinId);
      const serverId = builtinServerId(definition.builtinId);
      const hash = builtinHash(config, definition);
      const installed = installedByBuiltinId.get(definition.builtinId);
      if (installed && installed.builtinHash === hash) {
        continue; // up to date
      }
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "mcp.builtin-sync",
          commandId: CommandId.make(`server:mcp-builtin-sync:${definition.builtinId}`),
          serverId: McpServerId.make(serverId),
          builtinId: definition.builtinId,
          builtinHash: hash,
          name: definition.name,
          description: definition.description ?? null,
          config,
          shippedVars: builtinShippedVars(definition),
          timeoutMs: definition.timeoutMs ?? null,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("mcp reactor failed to sync builtin", {
              builtinId: definition.builtinId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
    // Remove installed built-ins no longer shipped (cascade: bindings + secret GC handle the rest).
    for (const installed of catalog) {
      if (installed.builtinId !== null && !shippedBuiltinIds.has(installed.builtinId)) {
        yield* engine
          .dispatch({
            type: "mcp.server-remove",
            commandId: CommandId.make(`server:mcp-builtin-remove:${installed.builtinId}`),
            serverId: installed.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("mcp reactor failed to remove dropped builtin", {
                builtinId: installed.builtinId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to reconcile builtins", { cause: Cause.pretty(cause) }),
    ),
  );
```
`start` BEFORE:
```ts
    yield* seedBuiltinsIfEmpty;
    // Initial reconcile: cover bindings restored from the DB on restart — NOT eager (no probing
    // on load; cached status is shown, never-probed stays «не проверено» until a trigger).
    yield* worker.enqueue({ kind: "reconcile", eager: false });
```
AFTER:
```ts
    yield* reconcileBuiltins;
    // Initial reconcile: cover bindings restored from the DB on restart — NOT eager (no probing
    // on load; cached status is shown, never-probed stays «не проверено» until a trigger).
    yield* worker.enqueue({ kind: "reconcile", eager: false });
```
> `mcp.server-remove` for a dropped built-in cascades to bindings: the existing binding-removal +
> the secret GC (D3) prune everything. **STOP-check:** confirm `mcp.server-remove`'s projector also
> removes the catalog row's bindings, or whether bindings are removed by a separate cascade; if
> bindings are NOT auto-cascaded on server-remove, the migrator additionally dispatches
> `mcp.binding-remove` for each binding of the dropped server (read the projector at impl — the
> cascade exists for `project.deleted`; verify it for `server-remove`). Pre-approved either way.
> Built-in `mcp.server-remove` events flow back as `eager:true` reconciles — harmless (the server is
> gone, nothing to probe).

## K8. Web — template editor + needs-attention catalog tile

### K8a. UI types: `McpRegistryServer` gains `locked`, `extraArgs`, `builtinId`
Extends G1. BEFORE (the G1 AFTER additions):
```ts
  readonly checking: boolean;
  readonly incomplete: boolean;
  readonly missingVars: readonly string[];
  readonly tags: readonly string[];
  readonly docsUrl?: string;
}
```
AFTER:
```ts
  readonly checking: boolean;
  readonly incomplete: boolean;
  readonly missingVars: readonly string[];
  /** A managed template: command/args read-only; user edits only vars values + extraArgs. */
  readonly locked: boolean;
  /** User-appendable args (with `${VAR}` holes), appended to the locked command. */
  readonly extraArgs: readonly string[];
  /** Non-null ⇒ a managed built-in (hidden id). */
  readonly builtinId: string | null;
  readonly tags: readonly string[];
  readonly docsUrl?: string;
}
```
And `McpVar` gains `origin` (G6 extends): add `readonly origin: "shipped" | "user";` to the UI `McpVar`.

### K8b. adapters: map the new fields; `catalogMissingVars` uses widened required
`catalogServerToRegistry` AFTER (extend G3c): add
```ts
    locked: server.locked,
    extraArgs: [...server.extraArgs],
    builtinId: server.builtinId,
```
to the returned object, and `catalogVarToUi` sets `origin: variable.origin`.
`catalogMissingVars` (G3b) BEFORE:
```ts
function catalogMissingVars(vars: ReadonlyArray<ContractVar>): string[] {
  return vars
    .filter((variable) => variable.perProject && variable.required && variable.value === null)
    .map((variable) => variable.name);
}
```
AFTER (widened — a catalog default is incomplete if ANY required var has no value; a per-project
required var with no catalog default is "set per project" and shown on bindings, NOT here):
```ts
function catalogMissingVars(vars: ReadonlyArray<ContractVar>): string[] {
  // Catalog-default incompleteness = required vars the CATALOG itself must satisfy: shared (non
  // per-project) required vars with no value. Per-project required vars are a per-binding concern.
  return vars
    .filter((variable) => !variable.perProject && variable.required && variable.value === null)
    .map((variable) => variable.name);
}
```
> `uiVarsToDraft` (G7) sets `origin` is N/A (drafts have no origin; the decider stamps user). The UI
> `McpVar.origin` is read-only display (to grey shipped declarations). When the user edits a template
> and saves, `uiVarsToDraft` sends only the USER vars (the dialog excludes shipped vars from the draft
> — K8c), so the decider's `mergeTemplateVars` re-attaches shipped vars. **Critical:** the template
> dialog's save must send `vars` = only `origin:"user"` rows (shipped rows are display-only).

### K8c. `McpServerDialog` — template mode (locked command, extraArgs, shipped vs user vars)
When `server?.locked` is true, the dialog renders **template mode**:
- Transport + command/args from `ServerConfigFields` → **read-only** (disabled inputs, greyed).
- A new **`extraArgs`** text field (space-separated, like args) — editable.
- `VarsEditor` shows shipped vars with **read-only declarations** (name/secret/perProject/required
  disabled) but **editable values**; user vars fully editable; "+ переменная" adds user vars.
- Save sends `{ config: <unchanged/omitted>, vars: <user vars only>, extraArgs, timeoutMs }` via
  `updateServer`. The locked `config` is **not** sent (decider rejects it anyway; omit to be safe).
- No JSON tab in template mode (command is locked).

Manual mode (server not locked, or adding) is unchanged from the existing dialog + the new `extraArgs`
field shown for custom servers too (optional).
> This is the largest single web edit. Exact JSX: gate the existing `ServerConfigFields` with
> `disabled={server?.locked}` (add a `disabled` prop to `ServerConfigFields` that disables its
> inputs + hides the JSON tab), render `<ExtraArgsField>` (new tiny component: one `Input`, space-
> split to array), and pass `lockedDeclarations={server?.locked}` to `VarsEditor` (greys the flag
> checkboxes + name for `origin:"shipped"` rows, keeps the value input + SecretAwareInput live).
> `useMcp.addServer/updateServer` inputs gain `extraArgs: readonly string[]`; the mutations send it.
> **Sub-edits enumerated:** `ServerConfigFields` `+disabled` prop; new `ExtraArgsField.tsx`;
> `VarsEditor` `+lockedDeclarations` prop (disable name + flag checkboxes when a row's `origin ===
> "shipped"`); `McpServerDialog` branches on `server?.locked`; `AddServerInput` (useMcp) `+extraArgs`;
> `addServer`/`updateServer` send `extraArgs`. Each is mechanical given the parts above.

### K8d. Needs-attention surfacing
Already covered: a built-in that ships/gains a required var renders «требует настройки» on the
catalog tile (catalog incomplete, K8b + J3) and on bindings (per-project requireds). No extra code —
the widened `required` + existing incomplete markers do it. The catalog detail header shows the
builtin badge from `source === "builtin"` (existing `RegistryDetail` badge) — unchanged.

---

# AMENDMENTS — supersede earlier parts (REVISION 2 D-restart, D-warn)

## AMEND-1 (REPLACES PART E entirely + the reactor restart pieces in PART D)
**Delete from the plan-as-built:** PART E (E1 `McpOverlayState` file, E2 layer wiring, E3 reactor
`syncOverlaysAndRestart` rewrite, E4 spawn seeding). **Also delete** the reactor's
`syncOverlaysAndRestart`, `restartThread`, `liveThreadsByProject`, `overlayFingerprintsRef`, and the
`yield* syncOverlaysAndRestart` call in `processSignal` — the reactor no longer writes overlays or
restarts sessions at all. The overlay is written ONLY at turn-start (it always was, in
`ProviderCommandReactor.startProviderSession`). Net reactor `processSignal` AFTER:
```ts
  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eager = signal.kind === "project-created" ? true : signal.eager;
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* pruneOrphanedVarValues; // item 11
      const added = yield* reconcileNow; // includes gcOrphanedSecrets (item 10)
      if (eager) {
        yield* supervisor.probeHashes(added); // item 3
      }
    });
```
> The reactor keeps: `reconcileNow` (+ probe-cache GC + secret GC), `pruneOrphanedVarValues`,
> `reconcileBuiltins`, the worker, autobind. It DROPS all overlay/restart code. `McpOverlay` is still
> used by `ProviderCommandReactor` (turn-start). `McpReactor` no longer imports `McpOverlay`/
> `ProviderService`/`ProjectionSnapshotQuery` if those were only used by the dropped restart code —
> **STOP-check at impl:** grep each import's remaining uses; drop the now-unused ones (`McpOverlay`,
> `providerService`, `snapshotQuery`, `Option`) — pre-approved removals if unused.

**Turn-start gate** (`ProviderCommandReactor.ts`): add per-thread overlay-fingerprint tracking + the
`overlayChanged` trigger. Add near the reactor's other in-memory state (top of `make`):
```ts
  // Per-thread overlay fingerprint the live session spawned with. A live qwen process doesn't
  // survive a server restart, so this in-memory map's lifetime matches the sessions' (no schema).
  const sessionOverlayFingerprintRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
```
Hoist the overlay write to the top of the turn handler and compute `overlayChanged`. The existing
`startProviderSession` writes the overlay; instead, write it ONCE before the reuse decision and pass
the result in. BEFORE (the reuse gate, lines 581-594):
```ts
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId)).sessionModelSwitch;
      const modelChanged = requestedModelSelection !== undefined && requestedModelSelection.model !== activeSession?.model;
      const instanceChanged = requestedModelSelection !== undefined && activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";

      if (!cwdChanged && !instanceChanged && !shouldRestartForModelChange) {
        return existingSessionThreadId;
      }
```
AFTER (add `overlayChanged`):
```ts
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId)).sessionModelSwitch;
      const modelChanged = requestedModelSelection !== undefined && requestedModelSelection.model !== activeSession?.model;
      const instanceChanged = requestedModelSelection !== undefined && activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      // ru-fork: the MCP overlay this thread's live session spawned with vs. the current one. A
      // changed overlay (server edited / bound / unbound / extraArgs / tool policy) re-spawns on the
      // next turn with resumeCursor — qwen only reads the overlay at spawn. Fingerprint subsumes the
      // allow-list (removing an MCP changes it). Items 8 & 9 dissolve (a stale first spawn self-heals).
      const spawnFingerprint = (yield* Ref.get(sessionOverlayFingerprintRef)).get(threadId);
      const overlayChanged =
        MCP_ENGINE_USE_OVERLAY && currentOverlayFingerprint !== undefined &&
        spawnFingerprint !== undefined && spawnFingerprint !== currentOverlayFingerprint;

      if (!cwdChanged && !instanceChanged && !shouldRestartForModelChange && !overlayChanged) {
        return existingSessionThreadId;
      }
```
And record the fingerprint when a session is bound (in `bindSessionToThread`, after the session is
set): `yield* Ref.update(sessionOverlayFingerprintRef, (m) => new Map(m).set(threadId, fingerprint))`.
> **Plumbing detail (exact at impl):** `currentOverlayFingerprint` must be available at the gate. The
> cleanest seam: write the overlay ONCE at the top of the turn handler (before the gate) — capture
> `mcpOverlayResult` there (overlayPath + allowedServerNames + fingerprint), use its `.fingerprint`
> for `currentOverlayFingerprint`, and pass the SAME `mcpOverlayResult` into `startProviderSession`
> (so it doesn't re-write). `startProviderSession`/`bindSessionToThread` record the fingerprint into
> `sessionOverlayFingerprintRef` keyed by `threadId`. Since this restructures `startProviderSession`'s
> internal `writeOverlay` call into a hoisted one, the **exact** before/after is finalized against the
> file at impl (the gate + `startProviderSession` are in the same `make`). This is the one section
> whose exact edit depends on local control flow; the SEAM (write once at top, compare, pass result
> down, record on bind) is fully specified — any line that differs is logged as a deviation.

## AMEND-2 (REPLACES G11's two-click banner with a modal — D-warn)
`McpServerDialog` warn-on-impact uses a centered `AlertDialog` listing affected projects by NAME.
`describeEditImpact` (serverConfigForm.ts, from G11) returns **structured** data instead of a string:
```ts
export interface EditImpact {
  readonly removedVars: ReadonlyArray<{ readonly name: string; readonly projects: ReadonlyArray<string> }>;
  readonly newRequiredProjects: ReadonlyArray<string>;
}
/** Structured impact of a catalog edit; null when non-disruptive. Needs project id→name. */
export function describeEditImpact(
  server: { readonly id: string; readonly vars: readonly McpVar[] },
  nextVars: readonly McpVar[],
  bindings: readonly McpProjectBinding[],
  projectName: (projectId: string) => string,
): EditImpact | null {
  const nextNames = new Set(nextVars.map((v) => v.name));
  const serverBindings = bindings.filter((b) => b.serverId === server.id);
  const removedVars = server.vars
    .filter((v) => v.perProject && !nextNames.has(v.name))
    .map((v) => ({
      name: v.name,
      projects: serverBindings.filter((b) => v.name in b.varValues).map((b) => projectName(b.projectId)),
    }))
    .filter((r) => r.projects.length > 0);
  const newRequired = nextVars.filter(
    (v) => v.required && v.value.trim().length === 0 && !server.vars.some((e) => e.name === v.name),
  );
  const newRequiredProjects =
    newRequired.length > 0 && serverBindings.length > 0
      ? serverBindings.map((b) => projectName(b.projectId))
      : [];
  return removedVars.length > 0 || newRequiredProjects.length > 0
    ? { removedVars, newRequiredProjects }
    : null;
}
```
`McpServerDialog`: replace the G11 banner with controlled `AlertDialog` state. On Save, if
`describeEditImpact(...) !== null`, open the AlertDialog (don't dispatch). The AlertDialog body lists
removed vars + affected project names and new-required project names; **Применить** dispatches the
edit + closes both; **Отмена** closes the AlertDialog only. Imports added to `McpServerDialog.tsx`:
`AlertDialog, AlertDialogPopup, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
AlertDialogFooter, AlertDialogClose` from `~/components/ui/alert-dialog`; `useMcpProjects` from
`../useMcp` (for `projectName`). The `impactWarning` string state from G11 becomes
`impact: EditImpact | null` + `confirmOpen: boolean`.
> base-ui nests dialogs first-class (`--nested-dialogs`), so the AlertDialog over the editor Dialog
> needs no special handling. `reset()` clears `impact`/`confirmOpen`.

---

## PART K + AMENDMENTS — coverage of the new requirements

| Requirement (from review) | Edits |
|---|---|
| Built-ins shipped as managed templates | K4 (McpBuiltins) + K7 (migrator) |
| Stable hidden id; remove/update/add across releases | K1c (builtinId/builtinHash) + K7 |
| Preserve user token/values on update | K5b (buildSyncedBuiltin 3-way merge) |
| New required field → needs attention | K2b (required widened) + K8b/K8d + binding incomplete |
| Removed field → cleaned | item 11 (varValues prune) + item 10 (secret GC) |
| Per-platform configs; skip unsupported | K4 (builtinConfigForPlatform) + K7 |
| Locked command + extraOptions, preserved on update | K1c (locked/extraArgs) + K2a + K5b + K8c |
| Catalog-level required secret works + needs-attention | K2b + K8b |
| Never detach; remove-from-prebuild = remove-everywhere | K5a (no fork) + K7 (remove loop) |
| Status resets to «не проверено» on update | free — K2a (configKey includes extraArgs/config) → new key ⇒ unchecked |
| Turn-start restart (no active teardown) | AMEND-1 |
| Warn modal with project list | AMEND-2 |

## Implementation phases (green + committed at each) — FINAL
1. **Phase A (monitoring, items 1–7):** PART A1–A3 + C1–C7 + D1/D2(no-GC-yet)/D5(eager) + G1–G14
   (statuses/checking/edit-lock) — minus secret-GC. Green + commit.
2. **Phase B (secret GC + varValues prune, items 10–11):** PART B + D3 + D4 + A5 + F4 + the prune
   command path. Green + commit.
3. **Phase C (keep-secret, items 13–14):** A4 + F2/F3/F5 + G5/G7/G10/G13 + SecretField. Green + commit.
4. **Phase D (turn-start restart, items 8–9):** AMEND-1. Green + commit.
5. **Phase E (config-model deltas):** K1 (origin/locked/extraArgs/builtinId/hash + draft) + K2
   (resolver/cacheKey/required) + K3 (migration/projection) + all K2c call sites. Green + commit.
6. **Phase F (built-ins migrator):** K4 + K5 + K6 + K7 (delete McpDefaults). Green + commit.
7. **Phase G (web templates + warn modal):** K8 + AMEND-2. Green + commit.
8. **Phase H (tests + final gates):** H2 + H3 + K2c test edit; typecheck 10/10, lint 0/0, test:fast
   (only 4 preexisting bin.test.ts). Final commit.

Each phase ends green or it is logged as a deviation and the phase is not committed until green.

---

# REREAD VALIDATION — corrections (authoritative; override the matching spots above)

> A validation pass against the real files found 6 errors in PART K. These corrections are
> authoritative and supersede the conflicting text above. Patterns confirmed by reading
> `settings.ts`, `ProjectionMcpBinding.ts`, `McpInvariants.ts`, `orchestration.ts`.

### C-1. `withDecodingDefault` takes an `Effect`, not a thunk — and mcp.ts needs the Effect import
Confirmed form (`settings.ts:44`): `Schema.withDecodingDefault(Effect.succeed(false))`. So in K1a/K1c:
```ts
// add to packages/contracts/src/ru-fork/mcp.ts imports:
import * as Effect from "effect/Effect";
// K1a:
origin: McpServerVarOrigin.pipe(Schema.withDecodingDefault(Effect.succeed<McpServerVarOrigin>("user"))),
// K1c:
extraArgs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed<ReadonlyArray<string>>([]))),
builtinId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
builtinHash: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
locked: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```
(`McpServerVarOrigin` exists as both value+type, so `Effect.succeed<McpServerVarOrigin>("user")` is valid.)

### C-2. K3b projection — mirror the binding's `enabled` pattern (NOT `Schema.transform`)
`ProjectionMcpBinding` stores booleans as `NonNegativeInt` in the row schema + a `rowToBinding` that
converts (`enabled: row.enabled !== 0`). Mirror it for `locked`:
```ts
import { McpCatalogServer, McpServerConfig, McpServerVar, NonNegativeInt } from "@t3tools/contracts";
import * as Option from "effect/Option";

const McpCatalogServerDbRow = McpCatalogServer.mapFields(
  Struct.assign({
    config: Schema.fromJsonString(McpServerConfig),
    vars: Schema.fromJsonString(Schema.Array(McpServerVar)),
    extraArgs: Schema.fromJsonString(Schema.Array(Schema.String)),
    locked: NonNegativeInt, // 0/1 column → converted by rowToServer below
  }),
);
type McpCatalogServerDbRow = typeof McpCatalogServerDbRow.Type;

function rowToServer(row: McpCatalogServerDbRow): McpCatalogServer {
  return { ...row, locked: row.locked !== 0 };
}
```
`builtin_id`/`builtin_hash` are plain `NullOr(TrimmedNonEmptyString)` columns — they decode directly
from the SELECT, **no mapFields entry needed**. Apply `rowToServer` in the repo methods (mirroring
the binding repo): `getById` → `getRow(input).pipe(Effect.map(Option.map(rowToServer)), Effect.mapError(...))`;
`listAll` → `listRows().pipe(Effect.map((rows) => rows.map(rowToServer)), Effect.mapError(...))`.
The K3b `Schema.transform` for `locked` is **discarded** in favor of this.

### C-3. K5c finder is `findCatalogServerById` (from `McpInvariants.ts`)
The non-throwing finder is `findCatalogServerById(readModel, serverId)` (returns `McpCatalogServer |
undefined`). The decider's `mcp.builtin-sync` branch uses it; add it to the existing
`McpInvariants.ts` import in `decider.ts` (alongside `requireCatalogServer`, `findBinding`).

### C-4. K1f orchestration.ts — exact `mcp.builtin-sync` command (reuses existing events)
Add after `McpServerRemoveCommand` (orchestration.ts ~line 693), mirroring `McpServerAddCommand`:
```ts
const McpBuiltinSyncCommand = Schema.Struct({
  type: Schema.Literal("mcp.builtin-sync"),
  commandId: CommandId,
  serverId: McpServerId,
  builtinId: TrimmedNonEmptyString,
  builtinHash: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(TrimmedNonEmptyString),
  config: McpServerConfig,
  shippedVars: Schema.Array(McpServerVar),
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))),
});
```
- Add `McpBuiltinSyncCommand` to the command Union (find where `McpServerRemoveCommand` is listed in
  the `OrchestrationCommand` union and add it).
- Imports in orchestration.ts: add `McpServerConfig`, `McpServerVar`, `TrimmedNonEmptyString` to the
  `@t3tools/contracts` / ru-fork import (it already imports `McpServerDraft`/`McpServerDraftPatch`/
  `McpServerId`; `TrimmedNonEmptyString` may already be imported — grep at impl).
- **No new event** — the decider's branch emits the existing `mcp.server-added` / `mcp.server-updated`
  (payload `{ server: McpCatalogServer }`), already handled by the projector. Confirmed the event
  literals exist (orchestration.ts:863-865, 1178-1188).
- `McpBuiltinSyncInput` (K1e) in `ru-fork/mcp.ts` is then **redundant** — DROP it; orchestration.ts
  declares the command inline (matches how the other mcp commands are declared there). The decider
  reads the fields off the command directly.

### C-5. Test literals need `origin` (K1a ripple)
After K1a, every `McpServerVar` literal in tests gains `origin: "user"` (or `"shipped"` where a
shipped var is intended):
- `mcpCore.test.ts`: the `vars` array (the `CONFLUENCE_TOKEN`/`SPACE_ID` literals) + the inline `vars`
  in the `substitution rules` / `resolveVarValues` / `missingRequiredVars` blocks → add `origin: "user"`.
  Also the `resolve` helper's `resolveConfig({...})` gains `extraArgs: []`, and the three
  `configCacheKey(stdioConfig, vars, {...})` calls gain a trailing `[]` (K2c).
- `secretsKeep.test.ts` (H3): the `existing`/`vars` `McpServerVar` literals → add `origin` (`"user"`).
- **`missingRequiredVars` test:** K2b widened it (dropped the `perProject` filter), so the existing
  case `missingRequiredVars(vars, {})` where `SPACE_ID` is `perProject:true, required:true` still
  returns `["SPACE_ID"]` ✅; ADD a case for a catalog-level required var (`perProject:false,
  required:true, value:null`) → returns its name (new behavior).

### C-6. K7 binding cascade on built-in removal — CONFIRMED, no extra dispatch
`ProjectionMcpBinding` has `removeByServerRow` (`DELETE … WHERE server_id = ?`); the `mcp.server-removed`
projector path uses it (the per-server cascade exists, sibling of the per-project one). So the
migrator's `mcp.server-remove` for a dropped built-in **does** cascade its bindings — the K7
STOP-check resolves to "no extra `mcp.binding-remove` dispatch needed." Secret GC (D3) then prunes the
orphaned secrets on the next reconcile. **STOP-confirm at impl:** grep the `mcp.server-removed`
projector for `removeByServer`; if absent, the migrator additionally dispatches `mcp.binding-remove`
per binding (pre-approved).

---

## FINAL PLAN STATUS: validated. Proceed to implementation (phases A–H), logging any deviation.
The design (REVISION 2) + exact edits (PART A–K + AMEND-1/2) + these corrections (C-1…C-6) constitute
the production-ready plan. Remaining impl-time confirms are all read-only with pre-approved fallbacks
(every one named). Implementation order = the FINAL phases list above.
