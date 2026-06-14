# MCP management — Production-readiness Audit

> An evidence-based review of the current working tree. The **behaviour** is treated as the desired
> final state (per the owner); this audit judges **code quality, architecture, DRY, over-engineering,
> and convention adherence**. Every issue cites `file:symbol` and gives a concrete before/after (or, for
> conceptual issues, an explanation + recommendation). Severities: **High** (correctness/misleading or
> production risk), **Medium** (maintainability/clarity), **Low** (polish).
>
> Bottom line: **this is senior-level, production-shaped work.** The architecture is sound, the
> separation is disciplined, secrets are handled correctly, and the pure core is well-tested. The
> issues below are almost all *hygiene* — stale comments, a handful of dead exports, and a few minor
> DRY/perf touch-ups. None are blocking; fixing A1–A3 and B1–B5 would take it from "very good" to "clean".

---

## 0. What is good (keep doing this)

- **Clean event-sourced CQRS fit.** MCP is modelled as two aggregates (singleton catalog, project-scoped
  bindings) on the host's existing decider/projector/event-store spine, reusing it rather than inventing a
  parallel store. Binding cascade with `project.deleted` falls out for free.
- **Secrets are handled correctly and consistently.** Plaintext exists only in `ServerSecretStore`,
  in-memory at probe/overlay time, and in the 0600 overlay file. Events, projections, read models, and the
  client carry refs only. `keepSecret`/`keepVarValues` close the "edit wipes an untouched secret" hole.
- **The dedup design is elegant and is the right call.** One probe + one cache row per *authored* config
  (cwd-independent `configCacheKey`), shared across projects, with per-project overrides splitting off
  cleanly. This is the kind of thing that prevents N×M probe storms.
- **The pure core is genuinely pure and tested.** `mcp-core` has no Effect/IO (the single SDK boundary is
  isolated and documented), and `resolver`/`supervisor decisions`/`secrets`/`builtins` have focused unit
  tests. The probe deliberately mirrors qwen's own client so "probe passes ⇒ qwen works".
- **The turn-start overlay/restart model is well-reasoned** (qwen only reads the overlay at spawn → rewrite
  every turn, re-spawn on fingerprint change with `resumeCursor`), and the no-probe-on-load reorder is
  subtle but correct and well-commented.
- **ru-fork isolation is disciplined** — shared files hold thin, `ru-fork:`-marked seams; the engine lives
  in dedicated folders; the recent built-ins data/logic split (`mcpBuiltinDefinitions.ts` vs
  `McpBuiltins.ts`) is exactly the right separation.
- **Error handling in background loops is robust** — every reactor effect is wrapped in
  `catch`/`catchCause` + `logError`, so one bad binding never tears down the sweep.

---

## A. High — misleading documentation on behaviour-critical paths

These are comments that **actively contradict the code**. They are High because the code paths are
security/behaviour-relevant (when does an MCP server get probed?), and a future maintainer will trust the
comment.

### A1. `McpSupervisor.isSweepDue` JSDoc describes the *opposite* of the code

`apps/server/src/ru-fork/mcp/McpSupervisor.ts`, the doc block above `isSweepDue` (the `/** … mandatory
first probe … */`) still describes the pre-redesign "always probe a never-checked instance once"
behaviour, but the body does the opposite (returns `false`). The body comment is correct; the JSDoc is not.

```ts
// BEFORE (lines ~95–101)
/**
 * The sweep's per-instance decision (pure, so it can be unit-tested):
 *  - a never-checked instance is ALWAYS probed once (mandatory first probe on
 *    catalog add / app start), regardless of watch scope;
 *  - otherwise only the WATCHED (active) project's instances re-probe, and only
 *    once their per-transport interval has elapsed (`watched === null` ⇒ all).
 */
```
```ts
// AFTER
/**
 * The sweep's per-instance decision (pure, so it can be unit-tested):
 *  - a NEVER-checked instance is never auto-probed (no probing on load); its first probe
 *    comes only from a manual recheck or a config-affecting change (reactor `probeHashes`);
 *  - otherwise only the WATCHED (active) project's already-probed instances re-probe, and
 *    only once their per-transport interval has elapsed (`watched === null` ⇒ all).
 */
```

### A2. `settings.ts` `mcp` block references a "mandatory first probe" that no longer exists

`packages/contracts/src/settings.ts`, the `ServerSettings.mcp` comment says intervals of 0 mean "never
re-check **after the mandatory first probe**" / "after the first probe". There is no mandatory first probe
in the final design (no probing on load). The intervals govern *all* recurring probing.

```ts
// BEFORE
  // Auto-recheck cadence is driven entirely by the two
  // interval fields (0 = never re-check after the mandatory first probe), so there
  // is no separate on/off toggle — set both to 0 to disable recurring probing.
  …
    // ru-fork: auto-recheck intervals (minutes; 0 = never re-check after the first
    // probe). Per transport …
```
```ts
// AFTER
  // Auto-recheck cadence is driven entirely by the two interval fields (0 = never auto
  // re-check that transport), so there is no separate on/off toggle — set both to 0 to
  // disable recurring probing entirely (first probe then comes only from a manual recheck
  // or a config-affecting change).
  …
    // ru-fork: auto-recheck intervals (minutes; 0 = that transport never auto re-checks).
    // Per transport …
```

### A3. `resolver.missingRequiredVars` doc still says "per-project" after the predicate was widened

`packages/mcp-core/src/resolver.ts`. The body dropped the `perProject` filter (a catalog-level required
var now counts), but the doc still says "required **per-project** vars".

```ts
// BEFORE
/**
 * Names of required per-project vars with no effective value (neither a binding
 * value nor a catalog default). …
 */
```
```ts
// AFTER
/**
 * Names of required vars (at ANY level) with no effective value — neither a binding/override
 * value nor a catalog default. A catalog-level required var makes the CATALOG incomplete; a
 * per-project required var makes the BINDING incomplete. …
 */
```

---

## B. Medium — dead code & unused surface (DRY / over-engineering)

Confirmed by grep across `apps/`, `packages/` (excluding tests). Removing these reduces the surface a
maintainer must reason about.

### B1. `mcp-core` exports two unused functions

`packages/mcp-core/src/resolver.ts` `effectiveConfig(server)` (a trivial `return server.config`) and
`packages/mcp-core/src/toolPolicy.ts` `pruneInertExceptions(policy, names)` have **zero callers**.
`effectiveConfig` also encodes a now-false premise (it exists to signal "a binding never overrides config"
— true, but nothing calls it). **Recommendation:** delete both (and their `index.ts` re-export reach).
If `pruneInertExceptions` was intended to keep tool policies tidy as servers lose tools, it is currently
aspirational — either wire it into `mcp.binding-set`/overlay or remove it.

### B2. Two repository methods are never called

`McpCatalogRepository.getById` (`Services/McpCatalog.ts` + impl `ProjectionMcpCatalog.ts`) and
`McpProbeCacheRepository.listAll` (`Services/McpProbeCache.ts` + impl) have no callers — catalog lookups go
through the read-model (`findCatalogServerById`) and the probe cache is read via `getByKey` (seed) only.
**Recommendation:** drop both from the interface + impl, or add a `// reserved:` note if intentionally kept
for symmetry. Dead interface methods are the most expensive kind of dead code (they imply a contract).

### B3. The granular `McpProjectionStreamEvent` variants are emitted by no one and consumed for nothing

`McpProjectionQuery.subscriptionStream` (and `changeSnapshots`) **only ever emit `{type:"snapshot"}`**, yet
the contract `McpProjectionStreamEvent` defines four more variants (`catalog-upserted`, `catalog-removed`,
`binding-upserted`, `binding-removed`) and the web `applyMcpProjectionEvent` has four reducer branches for
them that can never run. This is the single largest piece of over-engineering in the feature.

**Recommendation (pick one):**
- *Simplest:* collapse the contract to `McpProjectionStreamEvent = { type:"snapshot", snapshot }` and delete
  the four dead branches in `mcpState.ts`. The full-snapshot-per-change model is intentional and fine for
  admin-edit frequency (the code comment in `McpReadModel.ts` says so).
- *Or* (only if profiling shows the full-snapshot stream is too chatty at scale): actually emit granular
  events from `McpProjectionQuery` by inspecting the domain event, and keep the client branches. Given the
  stated low frequency, the simplest option is the senior call.

### B4. `McpRuntimeStatus` has values the server never produces

`McpRuntimeStatus` (contracts) lists `connecting` and `error`, but the supervisor only ever yields
`unchecked | online | degraded | offline` (`nextStatus` + reconcile seeding). `checking` (a separate
boolean) covers "in flight", so `connecting` is unreachable, and nothing ever maps to `error`. The web
`runtimeStatusToUi` defends against them, which is harmless but signals dead states.
**Recommendation:** drop `connecting` and `error` from `McpRuntimeStatus` (and the web mapping's handling),
or document why they're reserved. Low-Medium — it's a contract clarity issue, not a bug.

### B5. `builtinHash` re-implements FNV-1a that already exists in `resolver.ts`

`McpBuiltins.builtinHash` inlines the exact FNV-1a loop that `resolver.fnv1a` already implements (the
latter is module-private). Two copies of a hash function will drift.
**Recommendation:** export `fnv1a` from `mcp-core` (it's pure, already used by `dedupHash`/`configCacheKey`)
and have `builtinHash` call it:

```ts
// McpBuiltins.ts — BEFORE
export function builtinHash(config, definition): string {
  const canonical = JSON.stringify({ … });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) { hash ^= canonical.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
// AFTER
import { fnv1a } from "@ru-fork/mcp-core"; // newly exported
export function builtinHash(config, definition): string {
  return fnv1a(JSON.stringify({ name: definition.name, description: definition.description ?? null,
                                config, vars: builtinShippedVars(definition), timeoutMs: definition.timeoutMs ?? null }));
}
```

---

## C. Medium/Low — minor DRY, perf & robustness

### C1. `McpReactor.gcOrphanedSecrets` does an O(bindings × catalog) lookup

It calls `catalog.find(entry => entry.id === binding.serverId)` per binding, while the established pattern
(`computeDesired`) builds a `serverById` map. Trivial scale today, but it's a DRY/consistency nit.

```ts
// BEFORE
for (const binding of bindings) {
  const server = catalog.find((entry) => entry.id === binding.serverId);
  if (!server) continue; …
}
// AFTER
const serverById = new Map(catalog.map((s) => [s.id, s]));
for (const binding of bindings) {
  const server = serverById.get(binding.serverId);
  if (!server) continue; …
}
```

### C2. `pruneOrphanedVarValues` runs on every signal and can self-trigger an extra cycle

`processSignal` calls `pruneOrphanedVarValues` on **every** reconcile (including the non-eager startup tick
and every binding edit), scanning all bindings each time; when it finds an orphan it dispatches
`mcp.binding-set`, which produces another `eager` reconcile (and an extra probe of that binding). It
converges (no orphans the second pass), but it does extra work. **Recommendation (optional):** only run the
prune when a `mcp.server-updated` event is in scope (a var could only be removed by a catalog edit), e.g.
thread the triggering event type into the signal, or gate on "a catalog server's var set shrank since last
reconcile". Acceptable as-is for correctness; noted for efficiency/clarity.

### C3. `isSweepDue` re-checks `checkedAtMs === null` that `isProbeDue` also checks

`isSweepDue` returns early on `checkedAtMs === null`, then calls `isProbeDue`, which checks the same. Minor
redundancy; intentional for the unit tests of each. Leave as-is or add a one-line comment that the double
check is deliberate (each is independently tested).

### C4. `McpRuntime.currentSnapshot` recomputes `configCacheKey` per catalog server per emission

On every (debounced) change it rebuilds the whole snapshot and computes `configCacheKey(server.config,
server.vars, {}, server.extraArgs)` for each catalog server. Cheap at current scale; if the catalog grows
large, memoize the default-config keys alongside the catalog read. Low.

---

## D. Conceptual / architecture / security notes (no code change, or a judgement call)

### D1. Secrets are written to the overlay file in plaintext (by design — document it)

`McpOverlay` materializes secrets and writes them into `<stateDir>/mcp/overlays/<projectId>/system.json`
(mode 0600, dir 0700). This is **necessary** (qwen needs real values) and correctly permissioned, but it is
a plaintext-secret-at-rest surface distinct from the encrypted secret store. **Recommendation:** keep it,
but make it explicit in operator docs, and consider (future) shredding/cleaning overlays for deleted
projects (today an overlay dir for a deleted project lingers — low risk given 0700, but it's untracked
cleanup). The probe-cache GC and secret GC exist; an overlay GC does not.

### D2. The projection stream is project-unaware (full broadcast)

`McpProjectionQuery.subscriptionStream` always reads `getSnapshot(null)` (all bindings, all projects) and
pushes to every subscriber on every `mcp.*` event, even though `getSnapshot` supports project scoping. For a
single-user local tool this is fine; for many projects/bindings it is O(all) per edit per client. Noted as a
scaling consideration, not a defect. (Pairs with B3.)

### D3. 32-bit FNV-1a for identity hashes — fine here, worth knowing

`dedupHash`, `configCacheKey`, `overlayFingerprint`, `builtinHash` are all 32-bit FNV-1a (8 hex). A
collision would merge two distinct configs into one instance/cache row. At the scale of a local catalog
(tens of servers) the probability is negligible, and the inputs are canonicalized JSON, so this is an
acceptable engineering choice. Flagged only so it's a conscious one; if the catalog could ever be large or
adversarial, widen to a 64-bit/128-bit hash.

### D4. The built-in remover only removes rows that already carry a `builtinId`

`reconcileBuiltins`'s removal loop deletes installed servers whose `builtinId` is not in the shipped set.
A catalog row that should be a built-in but lacks a `builtinId` (only possible from data predating the
`builtinId` column — which, for an unreleased single-migration feature, should not exist) would never be
reconciled or removed. Not reachable in a clean install; noted for completeness. No action needed unless a
migration path from pre-`builtinId` data is ever required.

### D5. Comments reference spec anchors that now live in `legacy/`

Many engine comments cite `mcp-vars-redesign.md §D8/§D11/§D13`, `mcp-final-plan.md AMEND-1`, etc. After this
reorg those files are in `mcp-specs/legacy/` and are superseded by `mcp-specs/current/`. The references are
still resolvable but point at archived material. **Recommendation:** when these files are next touched,
repoint the most load-bearing references (e.g. the `McpReactor.start` and `ProviderCommandReactor` overlay
comments) to `mcp-specs/current/WORKING-LOGIC.md §5/§12`. Low priority; do it opportunistically.

---

## E. Conventions adherence

- **No-cast rule:** the codebase honours "no `as`/`any`/`unknown`" well. Two acknowledged spots: the one
  justified `transport as Transport` in `probe.ts` (documented), and `resolver.canonicalize`'s
  `value as Record<string, unknown>`. The latter is a reasonable JSON-walk but technically violates the rule;
  if strict adherence is desired, replace with a guard:
  ```ts
  // BEFORE
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).toSorted().map((k) => [k, canonicalize(record[k])]);
  }
  // AFTER (cast-free; reuses the typed entries)
  if (value !== null && typeof value === "object") {
    return Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))
                 .map(([k, v]) => [k, canonicalize(v)]);
  }
  ```
  (`Object.entries(value)` is well-typed for `object`; note this also fixes the sort to be explicit.)
- **Logging:** compliant — only `logDebug`/`logError` throughout.
- **`as const` avoidance:** compliant (e.g. `claimInFlight` uses an explicit tuple type with a comment
  "avoids `as const`").
- **Single migration:** compliant — `031_Mcp.ts` edited in place.
- **Naming:** readable and consistent (`mergeDesired`, `reconcileBuiltins`, `instanceInWatched`, …). No
  single-letter names. Good.
- **Web/test conventions:** web validated by typecheck+lint (no web test target) — compliant; server pure
  logic is unit-tested.

---

## F. Suggested fix order (highest value, lowest risk first)

1. **A1, A2, A3** — fix the three contradictory/stale comments (pure doc edits; zero behavioural risk; they
   are the most dangerous because they mislead).
2. **B1, B2** — delete the four unused exports/methods (mechanical; shrinks the API surface).
3. **B5, C1** — de-duplicate `fnv1a`; use a `serverById` map in the secret GC.
4. **B3 + B4** — collapse the projection stream to snapshot-only and trim the unused runtime-status values
   (a small, satisfying simplification that removes the biggest chunk of dead machinery).
5. **E (canonicalize), C2, C4, D1 (overlay GC)** — polish as time allows.

None of the above changes observable behaviour; all are safe under the existing `typecheck`/`lint`/`test:fast`
gates. The feature is ready to ship as-is; this list is the path from *very good* to *pristine*.
