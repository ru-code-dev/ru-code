# MCP — Improvements Branch 1 (fixes + features plan)

> One ordered, production-ready plan for **every** item discussed: the two binding-status fixes, the
> 19 numbered findings, your decisions, and a future-improvements section. Verified against the current
> tree and `effect@4.0.0-beta.59` / `@modelcontextprotocol/sdk@1.25.1`. Each item: **what · why · exact
> before→after (or new code) · risk · verify.** Gate after each phase: `pnpm typecheck` 10/10 · `pnpm lint`
> 0/0 · `pnpm test:fast` (only the 4 baseline `bin.test.ts`).

## Decisions captured (from you)
- **③** deleting a catalog server must also **clean overlay files** — no ghost data anywhere.
- **⑬** catalog disable = **Option A** — a catalog-level `enabled` flag (one source of truth, reversible).
- **⑤** project edit icon → **just re-icon** gear → pencil; the action (per-project config dialog) is unchanged.
- **②** auto-fill **description** (not title) from the probe. *(Confirmed: MCP `serverInfo` DOES carry a
  `description` field — see B3.)*
- **⑱** keep `extraArgs` **catalog-only** (escape hatch for locked **stdio** templates); **hide it for manual servers**.
- **⑲** **SHIP `extraHeaders` now** — the catalog-level escape hatch for locked **http** templates (add/override
  headers without editing the locked URL/headers), **symmetric with `extraArgs`**, and **hidden for manual
  servers** (they edit headers directly). This is **B6** below.
- **Future:** **per-project** `extraArgs` **and** `extraHeaders` on the *binding* (stable catalog identity, own
  probe) — that's the per-project story, FI-1/FI-2; the *catalog-level* ones ship in branch-1.

**Latest round of decisions:**
- **②/B3** auto-fill **description AND docs link**, same only-if-empty rule; priority **built-in shipped →
  probed → empty**; the **link is a built-in property** (display-only, never user-editable). **Populate real
  URLs** for the two shipped built-ins now (filesystem, context7 — see B3(c)).
- **⑬/B5** disable = **grayed at project level, NOT removed** (bindings stay, row dims). Switch shown on
  **both** the catalog list row **and** the detail header.
- **③/⑭** **no delete for built-ins** (icon + right-click item gated to `source !== "builtin"`).
- **⑯** built-in dialog locks **both name and description**.
- **⑧** «Показать в каталоге» is a button **right beside the remove button** (sibling pair).
- **Migration:** one migration, **edit `031` in place** — no new file.
- **Cadence:** implement **all three phases straight through**, gating internally, report once fully green.
- **Minor defaults (override if you dislike):** ⑦ render the description as a second muted line under the
  name while **keeping** the health/status line on the row (not moved to collapse); a grayed disabled row
  **stays expandable** (you can still «Показать в каталоге» / remove it).

## Verification ledger (what's locked vs. the one open detail)

**Confirmed against the current tree / SDK 1.25.1 / effect beta.59 — these are zero-deviation:**
- `client.getServerVersion(): Implementation | undefined` exists; `Implementation` (importable as
  `type Implementation` from `@modelcontextprotocol/sdk/types.js`) has `description?`, `title?`,
  `websiteUrl?`, `icons?`. (B3)
- `RegistryDetail` already renders the `description` (lines 36–42, «Без описания» fallback) **and** a
  «Документация» link from `McpRegistryServer.docsUrl` (lines 94–104); `docsUrl` is currently never
  populated. B3 fills `description` (existing field) + a new catalog `websiteUrl` → `docsUrl` — no UI
  change either side, just the adapter mapping `websiteUrl`. (B3/②)
- `McpPanel` header recheck is project-scoped at lines 42–49; `RecheckButton` import at line 9. (④)
- `RecheckButton` already accepts `disabled`. (⑮)
- `ServerConfigFields` already accepts `disabled`; `TransportSegmented` is rendered inside it. (⑯)
- `ProjectBindingRow` imports `ChevronDownIcon, SlidersHorizontalIcon, Trash2Icon` and `isToolEnabled` from
  `../store`; uses `ProjectConfigDialog` via a gear trigger. (⑤–⑧)
- `McpServerDialog` template mode (`isTemplate = server?.locked === true`); name input at id `mcp-name`;
  `ExtraArgsField` gated on `showExtraArgs`. (⑯/⑱)
- **Right-click context menu** = the app's **cross-platform** `readLocalApi().contextMenu.show(items, {x,y})`
  (`localApi.ts`: `window.desktopBridge.showContextMenu` in Electron, `showContextMenuFallback` on web — the
  floating `z-[10000]` menu). `ContextMenuItem<T> = { id, label, destructive?, disabled? }` from
  `@t3tools/contracts`. **Same logic the sidebar uses — zero custom code, identical in Electron and web.** (⑭/⑩)
- `AlertDialog*` (used by `McpServerDialog` already) for the delete modal. (③)
- Backend: `McpCatalogServer`/`McpProbeRecord`/`McpServerDraft(Patch)`/`031_Mcp.ts`/`ProjectionMcp*`/
  `McpCatalogBuilders`/`McpReactor`/`McpOverlay`/`McpSupervisor`/`resolver` shapes read and threaded below.
  `extraHeaders` mirrors the proven `extraArgs` rollout exactly. (B1/B3/B4/B5/B6)

**No open details remain** — the context menu reuses the existing cross-platform `api.contextMenu.show`
(verified in `localApi.ts` + `contextMenuFallback.ts`), so every item is locked to exact code/imports.

**Validation pass (5-agent sweep against the working tree + a self-check) — issues found & closed:**
- Every BEFORE-snippet/anchor confirmed exact (reconcile:319, nextStatus:212–227, probe online-return,
  computeDesired's two loops + `serverById`, `configCacheKey` 4-arg, `McpOverlay` deps, `ProjectConfigDialog`,
  AlertDialog imports, StatusBadge, `RecheckButton disabled`, lucide `PencilIcon`/`BookOpenIcon`).
- ⑪/⑫ confirmed feasible: `McpCatalogRuntimeSnapshot.message` exists (contracts:215) and
  `catalogServerToRegistry` already receives it — no new plumbing.
- **Test-literal + call-site updates the field additions force — now pinned in B3(g)/B5(d)/B6(f):**
  `McpProbeCache.test.ts` `onlineRecord` (+= `serverDescription`/`serverWebsiteUrl`); `builtins.test.ts`
  `existing`+`lockedExisting` literals (+= `websiteUrl`/`enabled`/`extraHeaders`, one pass) **and** its two
  `buildSyncedBuiltin({…})` calls (lines 99/137, += `websiteUrl: null`). Exhaustive grep confirms these are
  the ONLY `McpCatalogServer`/`McpProbeRecord` literal constructors + `buildSyncedBuiltin` callers outside
  source (`McpReadModel.ts` only filters/maps/spreads; `builtins.test.ts:208` spreads).
- **Built-in link is a shipped property** (`McpBuiltinDefinition.websiteUrl?`, folded into `builtinHash`),
  priority **shipped → probed → empty**; `buildSyncedBuiltin` preserves a backfilled value across syncs for
  both `description` and `websiteUrl`. Delete hidden for built-ins (③/⑭); name+description locked (⑯).
- **Disable = grayed at project level, NOT removed** — bindings persist + render dimmed; server still
  excluded from probe + qwen overlay (B5(c)).
- **B6 had a missed test site — now fixed in B6(c):** `mcpCore.test.ts` has THREE `resolveConfig` calls
  (lines 43/77/106), not one; all gain `extraHeaders: {}`.
- **⑲ helper sources corrected:** `parseHeaderLines` ← `./addMcpParsing` (not `serverConfigForm`);
  `recordToLines` must be `export`ed (currently private). See ⑲.
- **⑩ `edit` dropped:** it duplicated the pencil (⑤) and would have forced controlled props onto
  `ProjectConfigDialog`. Menu is now recheck/show/delete — zero new wiring. See ⑩.
- **F1 has no automated test** (impure reconcile, no existing harness) → manual + typecheck only; not a
  gate requirement. See F1.

**Clean-install / migration reality:** `031_Mcp.ts` is the latest migration and creates the MCP tables via
`CREATE TABLE IF NOT EXISTS` with every new column **inline + defaulted** — on `mcp_catalog_server`:
`enabled INTEGER NOT NULL DEFAULT 1` (B5), `extra_headers_json TEXT NOT NULL DEFAULT '{}'` (B6),
`website_url TEXT` nullable (B3); on `mcp_probe_cache`: `server_description TEXT` + `server_website_url TEXT`
nullable (B3) — so a **fresh install applies all columns** — SAFE. The migrator will **not** re-run an edited 031, so an
existing dev DB that already ran the current 031 needs a **DB/app reinstall** to pick up the new columns
(the accepted "edit 031 in place" trade-off). The user will reinstall the app, so this is moot here.

---

## Part 0 — The two binding-status fixes (the "blue blink")

| Case | Severity | Fix |
|---|---|---|
| **Complete binding never gets probed** (blue → не проверено dead-end) | **Real bug** | **F1** — the one that matters |
| **Incomplete binding shows a blue dot** instead of gray next to «требует настройки» | **Cosmetic nit** | **F2** — polish, blue → neutral gray |

### F1 — probe a newly-*referenced* instance, not only brand-new hashes
*File: `apps/server/src/ru-fork/mcp/McpSupervisor.ts` (`reconcile`).* Today `reconcile` returns only
brand-new hashes, so binding a server whose config equals an already-registered (unchecked) catalog
default returns `[]` → no probe. Return brand-new **or newly-referenced** hashes:
```ts
// BEFORE
      // Hashes present now but absent from the prior registry …
      return [...next.keys()].filter((hash) => !current.has(hash));
// AFTER
      // Hashes that are brand-new OR that gained a ref this reconcile (e.g. just bound to a project) —
      // both warrant a probe on an eager (user-driven) change; incomplete instances never reach here
      // because computeDesired excludes them, so this can only ever probe COMPLETE instances.
      return [...next.entries()]
        .filter(([hash, instance]) => {
          const before = current.get(hash);
          return !before || [...instance.refs].some((ref) => !before.refs.has(ref));
        })
        .map(([hash]) => hash);
```
**Why it can't probe incomplete servers:** `computeDesired` already drops incomplete bindings
(`missingRequiredVars > 0`), so they never enter `desired` → never an instance → never in this set.
**Risk:** none — still gated by `eager` (load stays no-probe); coalescing prevents double-probe.
**Verify (no new test):** `reconcile` is impure (Ref-backed) and there is **no existing supervisor
integration harness** in the suite, so F1 is **not** covered by an automated case — it is **not** a gate
requirement. Primary verification is **manual** (bind a complete server → it probes immediately) plus
`typecheck`/`lint`/`test:fast` staying green. (A `McpSupervisorLive`-with-fakes integration test —
reconcile H/`catalog:S`, then H/`catalog:S`+`S:P`, assert 2nd call returns `[H]` — is a possible future
add but is **out of scope** for branch-1 and not built here.)

### F2 — an incomplete binding shows a neutral status, not blue "connecting"
*File: `apps/web/src/ru-fork/mcp-manage/adapters.ts` (`bindingToUi`).* No runtime row exists for an
incomplete binding, and `runtimeStatusToUi(…, undefined, …)` returns `"connecting"` (blue, stuck). Map
incomplete → neutral:
```ts
// BEFORE
    status: runtimeStatusToUi(binding.enabled, runtime?.status, checking),
// AFTER
    // Incomplete (a required per-project var is empty) ⇒ neutral «Не проверено» dot + the amber
    // «требует настройки» marker; never the blue «Подключение» (there is no runtime row, ever).
    status:
      binding.enabled && missingVars.length > 0
        ? "unchecked"
        : runtimeStatusToUi(binding.enabled, runtime?.status, checking),
```
(`missingVars` is already computed in `bindingToUi`.) **Risk:** none. **Verify:** web typecheck.

---

## Part 1 — Backend bugs & data changes

### B1 — ⑨/⑰ hard failure must be RED immediately; only timeouts stay amber «нестабильно»
*Files: `mcp-core/probe.ts` (already exposes `timedOut`), `McpSupervisor.ts` (`nextStatus`).* Today
`nextStatus` is a pure 3-strike counter: any failure shows `degraded` (amber) for #1–#2 and `offline`
(red) only at #3. A hard error ("connection closed", ENOENT, spawn fail) is not "unstable" — it's down.
The probe already distinguishes `timedOut`; thread it into the decision:
```ts
// BEFORE
function nextStatus(
  result: ProbeResult,
  previousFailures: number,
): { readonly status: McpRuntimeStatus; readonly consecutiveFailures: number } {
  switch (result.status) {
    case "online":
      return { status: "online", consecutiveFailures: 0 };
    case "offline": {
      const consecutiveFailures = previousFailures + 1;
      return {
        status: consecutiveFailures >= OFFLINE_THRESHOLD ? "offline" : "degraded",
        consecutiveFailures,
      };
    }
  }
}
// AFTER
function nextStatus(
  result: ProbeResult,
  previousFailures: number,
): { readonly status: McpRuntimeStatus; readonly consecutiveFailures: number } {
  switch (result.status) {
    case "online":
      return { status: "online", consecutiveFailures: 0 };
    case "offline": {
      const consecutiveFailures = previousFailures + 1;
      // A HARD failure (connection refused/closed, ENOENT, spawn error) is down NOW → red. Only a
      // TIMEOUT gets the degraded/retry buffer (a slow server may recover within OFFLINE_THRESHOLD).
      const status: McpRuntimeStatus =
        !result.timedOut || consecutiveFailures >= OFFLINE_THRESHOLD ? "offline" : "degraded";
      return { status, consecutiveFailures };
    }
  }
}
```
**Side effect cleaned up:** this also removes the seeded-offline flip-flop (a hard-down server no longer
bounces red→amber→red across a restart). **Risk:** none — pure function; amber now means "timing out,
retrying," red means "down." **Verify:** `export` `nextStatus` (it's currently private, alongside the
already-exported `isProbeDue`/`isSweepDue`) and add 2 cases to `supervisorDecisions.test.ts`: a hard offline
(`timedOut` absent) ⇒ `offline` immediately; a timeout offline ⇒ `degraded` until the 3rd consecutive.

### B2 — ① "added MCP didn't appear until F5"
Most likely the projection stream dying on a transient error — **already fixed by R5** (the projection
change-stream now drops one update instead of ending). **Action:** ship R5 (done), then re-test. If it
recurs, the next suspect is the WS subscription reconnect (`startMcpStateSync` only re-fetches eagerly
when the catalog is empty); the follow-up would be to re-`getSnapshot` on every (re)subscribe. **No new
code now** beyond confirming R5.

### B3 — ② auto-fill the server **description** AND **docs link** from the probe (only-if-empty)
**Semantics (your rule):** on every successful probe the server may report a `description` and a `websiteUrl`
(docs link). The reactor back-fills the catalog **only when the catalog field is empty** — first non-null
wins. If the **user** has set/edited the field (non-null), we never overwrite, so the user's version always
shows. Exactly how `tools` already flow (probe → cache → surfaced), now for two text fields. Description and
websiteUrl are **fully symmetric**; websiteUrl needs one new catalog column (there's no backend docs-URL
field yet — the UI's `docsUrl` is currently unpopulated), mirroring `description`'s column 1:1.

**Confirmed against the installed SDK:** `serverInfo` (the `Implementation` in `initialize`) carries
`name`, `version`, `title?`, **`description?`**, **`websiteUrl?`**, `icons?`. Both are available after
`client.connect()` via `client.getServerVersion()`. (Tools arrive via `tools/list` — that's how tool
descriptions already work.) Plan:

**(a) Probe captures both** — `mcp-core/probe.ts`:
```ts
// ProbeResult — BEFORE: { status, tools, latencyMs, message?, timedOut? }
// AFTER: add
  readonly serverDescription?: string;   // serverInfo.description (the human blurb)
  readonly serverWebsiteUrl?: string;    // serverInfo.websiteUrl  (docs link)
```
Capture `serverInfo` in the **outer** `probeOnce` scope (like `stderrTail`), so the online return reads it
without changing `connectAndList`'s return type. **Confirmed API:** `client.getServerVersion(): Implementation
| undefined`.
```ts
// near `let stderrTail = "";`
  let serverInfo: ReturnType<Client["getServerVersion"]>;
// inside connectAndList, AFTER `await connecting;` (the client is now initialized)
    serverInfo = client.getServerVersion();
// online return — BEFORE
    return { status: "online", tools, latencyMs: elapsedMs() };
// AFTER (carry the optional fields; exactOptionalPropertyTypes-safe; cast-free)
    return {
      status: "online",
      tools,
      latencyMs: elapsedMs(),
      ...(typeof serverInfo?.description === "string" ? { serverDescription: serverInfo.description } : {}),
      ...(typeof serverInfo?.websiteUrl === "string" ? { serverWebsiteUrl: serverInfo.websiteUrl } : {}),
    };
```

**(b) Persist both in the probe cache** — `contracts/ru-fork/mcp.ts` `McpProbeRecord` += `serverDescription`
+ `serverWebsiteUrl` (exact form in (g)); `031_Mcp.ts` `mcp_probe_cache` += `server_description TEXT`,
`server_website_url TEXT`; `ProjectionMcpProbeCache` upsert/select **both** columns (mirror `last_error`);
`McpSupervisor.runProbe` writes `result.serverDescription ?? null` / `result.serverWebsiteUrl ?? null`.

**(c) Catalog gains a `websiteUrl` field + built-ins can SHIP a link (priority over the probed one).**
Priority for **both** `description` and `websiteUrl` is: **built-in's shipped value → else MCP-probed value
→ else empty**, and a non-null value is never overwritten (user/shipped always wins; the probe only fills a
blank). The link is **display-only** (no edit field anywhere); a built-in's shipped link is authored in its
definition. Mirror `description` (plain nullable TEXT, NOT json):
- `contracts` `McpCatalogServer` += `websiteUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`.
- `McpServerDraftPatch` += `websiteUrl: Schema.optionalKey(Schema.NullOr(Schema.String))` (so the reactor can
  dispatch the backfill). **`McpServerDraft` (manual-add form) does NOT get it** — no docs-URL input; a
  manual server starts `null` and fills from its own probe.
- `031_Mcp.ts` `mcp_catalog_server` += `website_url TEXT` (nullable, like `description`).
- `ProjectionMcpCatalog`: row schema += `websiteUrl: Schema.NullOr(Schema.String)` (plain column, like
  `description` — `rowToServer` spreads it, no change); upsert VALUES/SET += `website_url`; both SELECTs +=
  `website_url AS "websiteUrl"`.
- **Built-in definition ships a link** — `McpBuiltins.ts` `McpBuiltinDefinition` += `websiteUrl?: string`
  (beside `description?`); include it in `builtinHash` (so a changed shipped link triggers a re-sync, like
  name/description); the migrator passes `websiteUrl: definition.websiteUrl ?? null` into `buildSyncedBuiltin`.
  **(impl note)** the migrator passes it via the `mcp.builtin-sync` **command**, so that command's schema
  (`contracts/orchestration.ts` `McpBuiltinSyncCommand`) += `websiteUrl: Schema.NullOr(Schema.String)`, the
  reactor's `engine.dispatch({ type: "mcp.builtin-sync", … })` (`McpReactor.ts`) += `websiteUrl`, and the
  decider's `mcp.builtin-sync` branch forwards `command.websiteUrl` into `buildSyncedBuiltin`.
- **Populate the two shipped built-ins** (`mcpBuiltinDefinitions.ts`, data-only — the documented single edit
  point) with real docs URLs (decision: "also populate known URLs"):
  - `filesystem` → `websiteUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem"`
  - `context7` → `websiteUrl: "https://context7.com"`
  (Adding `websiteUrl` to these literals is safe — it's optional on `McpBuiltinDefinition`; it changes their
  `builtinHash`, which correctly triggers a one-time re-sync that stamps the link onto the catalog row.)
- `McpCatalogBuilders`: `buildAddedServer` += `websiteUrl: null`; `applyServerUpdate` +=
  `websiteUrl: patch.websiteUrl ?? existing.websiteUrl`; `buildSyncedBuiltin` input += `websiteUrl: string |
  null` and sets **`websiteUrl: input.websiteUrl ?? input.existing?.websiteUrl ?? null`** (shipped link wins;
  else a previously-backfilled MCP link is preserved across syncs). **Also change `buildSyncedBuiltin`'s
  `description` from `input.description` → `input.description ?? input.existing?.description ?? null`** for the
  same reason (a built-in that ships no description but got an MCP-backfilled one must not be clobbered on
  re-sync; shipped-non-null still wins). No behavior change when a built-in ships a description (the common case).
- **Decider:** no lock guard — `description`/`websiteUrl` are metadata (only `config` is locked-guarded), so
  `applyServerUpdate` carries them for builtins and customs alike (verified `decider.ts:776–798`).

**(d) Back-fill the catalog (only-if-empty)** — new reactor step `backfillServerMetadata` (runs inside
`reconcileNow`, **after** reconcile so the cache row exists). **Uses the exact `engine.dispatch` idiom the
built-in migrator already uses in this file** (`McpReactor.ts:309–327`: `engine.dispatch({…})` →
`.pipe(Effect.catchCause((cause) => Effect.logError(…, { cause: Cause.pretty(cause) })))`, run via
`Effect.forEach(servers, …, { discard: true })`) — no new machinery, `logError`-only, replay-safe. For each
catalog server, read its **default-config** cache row by
`configCacheKey(server.config, server.vars, {}, server.extraArgs, server.extraHeaders)` (5-arg, post-B6),
build a patch of only the empty-and-available fields, and dispatch once if non-empty:
```ts
const patch = {
  ...(server.description === null && cacheRow?.serverDescription != null
    ? { description: cacheRow.serverDescription } : {}),
  ...(server.websiteUrl === null && cacheRow?.serverWebsiteUrl != null
    ? { websiteUrl: cacheRow.serverWebsiteUrl } : {}),
};
if (Object.keys(patch).length > 0) {
  yield* engine
    .dispatch({
      type: "mcp.server-update",
      // deterministic + field-scoped so a description-only then a websiteUrl-only fill get distinct ids
      // (replay-idempotent, like the autobind's fixed commandId):
      commandId: CommandId.make(`server:mcp-meta-backfill:${server.id}:${Object.keys(patch).sort().join("-")}`),
      serverId: server.id,
      patch,
    })
    .pipe(Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to backfill server metadata", {
        serverId: server.id, cause: Cause.pretty(cause),
      })));
}
```
The prober stays read-only; the reactor owns engine + catalog + cache. **Convergence/no-loop:** the dispatched
`mcp.server-update` is `isReconcileRelevant` → triggers one more reconcile, but `description`/`websiteUrl` are
now non-null so the patch is empty and nothing re-dispatches. Re-probes never overwrite a non-null field →
user edits always win. (`CommandId`, `Cause`, `Effect` are already imported in `McpReactor.ts`.)

**(e) Surface it** — `description` needs **no UI change** (`RegistryDetail` lines 36–42 already render it /
«Без описания»). For the docs link, `adapters.catalogServerToRegistry` maps `server.websiteUrl` → the
existing `McpRegistryServer.docsUrl` (currently never populated); `RegistryDetail` (lines 94–104) already
renders a «Документация» link when `docsUrl` is set. So once (d) fills the fields, the card shows both with
no further UI work.

**(f) Builtin metadata-sync note:** `buildSyncedBuiltin` currently sets `description: input.description` (the
shipped template value). Builtins ship a description, so this is normally non-null and the backfill never
touches them; the websiteUrl `?? input.existing?.websiteUrl` above preserves any backfilled link across
syncs. No behavior change for the common case.

**(g) Test-literal + call-site updates (REQUIRED — or typecheck fails):** the decoded `.Type`s gain required
fields (`withDecodingDefault` relaxes only the *encoded* side, not `.Type`), and `buildSyncedBuiltin`'s input
gains a required `websiteUrl`:
- `apps/server/tests/persistence/Layers/McpProbeCache.test.ts` `onlineRecord` (line 31, `satisfies
  McpProbeRecord`) += `serverDescription: null, serverWebsiteUrl: null`.
- `apps/server/tests/ru-fork/mcp/builtins.test.ts` `existing` (line 119) + `lockedExisting` (line 161) +=
  `websiteUrl: null` (line 208 `unlocked` spreads — no edit). **Same two literals B5(d)/B6(f) touch — add
  `enabled`/`extraHeaders`/`websiteUrl` to all three in one pass.**
- `apps/server/tests/ru-fork/mcp/builtins.test.ts` `buildSyncedBuiltin({…})` calls at **lines 99 and 137**
  += `websiteUrl: null` (the input field is required, mirroring `description`). `SECRET_TEMPLATE`
  (`McpBuiltinDefinition`, line 44) needs **no** change — `websiteUrl?` is optional on the definition, and the
  `builtinHash` equality/inequality assertions (lines 88–89) stay valid (the template ships no link).
- **Migrator call site (source):** `McpReactor.ts:256` (the `buildSyncedBuiltin({ name, description, … })`
  call) += `websiteUrl: definition.websiteUrl ?? null`; `McpBuiltins.ts builtinHash` (line ~64) folds
  `websiteUrl: definition.websiteUrl ?? null` into its hashed object.
**Exact field forms** (so old encoded rows still decode): `serverDescription`/`serverWebsiteUrl` on
`McpProbeRecord` and `websiteUrl` on `McpCatalogServer` all use
`Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null)))` (mirrors
`builtinId`/`builtinHash`).

**Risk:** medium (most touch points of any item — symmetric description+websiteUrl threads). **Verify:**
migration in place; typecheck (incl. the 3 test-literals above); a probe unit asserting `serverDescription`
+ `serverWebsiteUrl` flow; manual: add a remote server with empty description/link → after first probe both
fill; edit the description → re-probe leaves the edit intact.
**Sources:** [MCP schema](https://modelcontextprotocol.io/specification/draft/schema),
[Implementation schema in SDK 1.25.1] (local), [MCP cheat sheet](https://www.webfuse.com/mcp-cheat-sheet).

### B4 — ③(backend) overlay cleanup, no ghost data
Deleting a server already cascades bindings (`removeByServer`) + GCs its secrets (`gcOrphanedSecrets`).
The per-project **overlay file** self-heals for a deleted *server* (bindings change → fingerprint change
→ next turn rewrites it), so no real ghost there. The genuine orphan is a **deleted project's overlay
dir**. Add a prune on `project.deleted`:
- `McpOverlay` gains `removeOverlay(projectId): Effect<void, McpError>` — `fileSystem.remove(path.join(serverConfig.mcpOverlayDir, projectId), { recursive: true }).pipe(Effect.ignore)`.
- `McpReactor` — re-add the `McpOverlay` import (dropped in AMEND-1) and handle `project.deleted` **in the
  event subscription**, mirroring the existing `project.created` branch (which carries the projectId):
  ```ts
  // McpReactor.start, inside Stream.runForEach(engine.streamDomainEvents, (event) => …)
  if (event.type === "project.deleted") {
    return mcpOverlay.removeOverlay(event.payload.projectId).pipe(
      Effect.andThen(worker.enqueue({ kind: "reconcile", eager: true })), // bindings already cascade; reconcile GCs
    );
  }
  ```
  (`project.deleted` is already `isReconcileRelevant`, so today it just enqueues a reconcile; this branch
  additionally removes the overlay dir before reconciling.)
**Risk:** low (best-effort remove). **Verify:** typecheck; manual: delete a project → its overlay dir is gone.

### B5 — ⑬ catalog-level `enabled` flag (Option A)
**(a) Contract** — `McpCatalogServer` += `enabled: Boolean` (`withDecodingDefault(Effect.succeed(true))`);
`031_Mcp.ts` `mcp_catalog_server` += `enabled INTEGER NOT NULL DEFAULT 1`; `ProjectionMcpCatalog` row
schema (`NonNegativeInt` + `rowToServer` `enabled: row.enabled !== 0`) + upsert/select columns (mirror
`locked`).
**(b) Toggle path** — `McpServerDraftPatch` += `enabled: optionalKey(Boolean)`;
`McpCatalogBuilders.buildAddedServer` sets `enabled: true`; `applyServerUpdate` carries
`enabled: patch.enabled ?? existing.enabled`; `buildSyncedBuiltin` sets `enabled: input.existing?.enabled ?? true`
(preserve a user's disable across template syncs); `useMcp` gains `setServerEnabled(serverId, enabled)` →
`mcp.server-update { enabled }`.
**(c) Honor it (inactive, but NOT removed from projects)** — disabled means the server stops running, while
its project bindings **stay visible, just grayed**:
- `McpReactor.computeDesired` skips servers with `enabled === false` (both the catalog default loop and via
  `serverById` in the binding loop) → no probe; `McpOverlay.writeOverlay` skips a binding whose server is
  disabled → not sent to qwen. So the server is genuinely **off**, without touching the binding records.
- **Project UI does NOT hide it** — bindings persist, so the row still lists. The `ProjectBindingRow` reads
  `server.enabled` (added to `McpRegistryServer` + mapped from `server.enabled` in the adapter; see ⑬) and,
  when `false`, renders the row **dimmed
  (`opacity-50`)** with an «отключён в каталоге» hint and a neutral (not error) dot. Re-enable in the catalog
  restores everything. (This replaces the earlier "hidden from every project" framing — it's *grayed*, and
  it's simpler: no removal logic, just a dim + label.)
**(d) Test-literal update (REQUIRED — or typecheck fails):** `McpCatalogServer`'s decoded `.Type` gains
required `enabled`, so the two literals that build a full `McpCatalogServer` must carry it:
`apps/server/tests/ru-fork/mcp/builtins.test.ts` `existing` (line 119) and `lockedExisting` (line 161) +=
`enabled: true`. (Line 208 `unlocked = { ...lockedExisting, … }` spreads it — no edit. The `McpCatalogBuilders`
constructors are covered in (b).)
**Risk:** medium (new field threaded through). **Verify:** typecheck/lint/test:fast (incl. the two
literals above); manual: disable in catalog → drops out of the qwen overlay + stops probing, **and its
project rows go grayed/«отключён в каталоге» (still listed, not removed)**; re-enable → fully restored.

### B6 — ⑲ catalog `extraHeaders` for locked **http** templates (symmetric with `extraArgs`)
The catalog-level escape hatch for a locked http template: add/override headers without editing the locked
URL/headers. Mirrors `extraArgs` exactly (which is the stdio escape hatch), threaded through every
config/cache consumer — same pattern `extraArgs` already follows.

**(a) Contract** (`contracts/ru-fork/mcp.ts`):
- `McpCatalogServer` += `extraHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed<Readonly<Record<string,string>>>({})))` (placed beside `extraArgs`).
- `McpServerDraft` += `extraHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))`;
  `McpServerDraftPatch` += the same `optionalKey`.

**(b) Migration + projection:** `031_Mcp.ts` `mcp_catalog_server` += `extra_headers_json TEXT NOT NULL DEFAULT '{}'`;
`ProjectionMcpCatalog` row schema `extraHeaders: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))`;
upsert column `${JSON.stringify(server.extraHeaders)}` + `extra_headers_json`; both SELECTs add
`extra_headers_json AS "extraHeaders"`. (`rowToServer` needs no change — it's a plain JSON column.)

**(c) Resolver** (`mcp-core/resolver.ts`): `resolveConfig` input += `extraHeaders: Readonly<Record<string,string>>`;
the **http** branch merges then expands: `const headers: Record<string,string> = {}; for (const [k, t] of
Object.entries({ ...input.config.headers, ...input.extraHeaders })) headers[k] = expand(t);`. `configCacheKey`
gains a 5th param `extraHeaders` folded into the canonical object (`{ config, vars: effectiveVars, extraArgs, extraHeaders }`).
**All call sites get the 5th arg / new field** (same set extraArgs touched): `McpReactor.mergeDesired`
(both `resolveConfig` + `configCacheKey` → `server.extraHeaders`), `McpOverlay.writeOverlay` (`resolveConfig`
→ `server.extraHeaders`), `McpRuntime.currentSnapshot` (`configCacheKey(server.config, server.vars, {}, server.extraArgs, server.extraHeaders)`),
and **`mcpCore.test.ts`** — **all THREE** `resolveConfig({…})` call sites gain `extraHeaders: {}`
(the `resolve` helper at line 43, the `run` helper at line 77, and the inline call at line 106), **and**
every `configCacheKey(...)` call (lines 136–153) gains a 5th `{}` arg.

**(d) Builders** (`McpCatalogBuilders.ts`): `buildAddedServer` += `extraHeaders: draft.extraHeaders ?? {}`;
`applyServerUpdate` += `extraHeaders: patch.extraHeaders ?? existing.extraHeaders`; `buildSyncedBuiltin` +=
`extraHeaders: input.existing?.extraHeaders ?? {}` (a built-in ships none; a user's edits survive sync).
**Decider:** no new lock check — `extraHeaders` is the escape hatch (like `extraArgs`); only `config` is
rejected for locked templates, and `extraHeaders` flows through `applyServerUpdate`.

**(e) UI** (`useMcp.ts` + dialog): `AddServerInput` += `extraHeaders: Readonly<Record<string,string>>`;
`addServer`/`updateServer` send `extraHeaders` (always; `{}` for manual); `McpRegistryServer` (`types.ts`) +=
`extraHeaders: Readonly<Record<string,string>>` (adapter maps `server.extraHeaders`) so the dialog can init
the field. The dialog field itself is the **Part 3 ⑲** `ExtraHeadersField` (template+http only).

**(f) Test-literal update (REQUIRED — or typecheck fails):** `McpCatalogServer`'s decoded `.Type` gains
required `extraHeaders`, so `apps/server/tests/ru-fork/mcp/builtins.test.ts` `existing` (line 119) and
`lockedExisting` (line 161) += `extraHeaders: {}` (line 208 `unlocked` spreads — no edit). This is the
**same two literals** B5(d) touches — edit both fields in one pass.

**Risk:** medium — same shape as the proven `extraArgs` rollout (Phase E), 5-arg `configCacheKey` ripple is
mechanical and **typecheck-enforced** (a missed call site fails to compile). **Verify:** typecheck/lint/test:fast
(update the 3 `resolveConfig` + the `configCacheKey` calls in `mcpCore.test.ts` per (c); the 2 `builtins.test.ts`
literals per (f); add an "extraHeaders differ ⇒ different key" case mirroring the existing extraArgs case);
manual: a locked http built-in gains a header via the field; manual http server shows no field.

---

## Part 2 — UI

### ⑪ Catalog **list** rows: status dot + error hint
*File: `RegistryTab.tsx`.* The list row shows name/transport/tools/desc only. Add a `StatusBadge` dot and
an error hint. The row needs the runtime — read `useMcpCatalogRuntimeMap()` (or surface `status`/`message`
on `McpRegistryServer` via the adapter; **cleaner: adapter**). Plan: `catalogServerToRegistry` already
sets `status`; add `message?: string` to `McpRegistryServer` from `runtime?.message`. Then in the row:
```tsx
// BEFORE: <span className="truncate …">{server.name}</span> <Badge>{transport}</Badge>
// AFTER: prepend the dot, and show the error under the tools line
<StatusBadge status={server.status ?? "unchecked"} showLabel={false} className="shrink-0" />
…
{server.status === "error" && server.message && (
  <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-300/90" title={server.message}>{server.message}</p>
)}
```

### ⑫ Catalog **detail** card: show the error text (not just a dot)
*File: `RegistryDetail.tsx` + adapter.* Add `message` to `McpRegistryServer` (above). In the header, under
the description, render the failure when offline:
```tsx
// AFTER the description <p>…</p> block
{server.status === "error" && server.message && (
  <p className="mt-1 text-xs leading-snug text-red-600 dark:text-red-300/90">{server.message}</p>
)}
```

### ③ Catalog detail: **delete** icon (custom servers only) + confirm modal (lists projects) + cascade
*Files: `RegistryDetail.tsx`, `useMcp.ts`.* New mutation:
```ts
// useMcp — add to McpMutations
removeServer: (serverId: string) =>
  dispatchMcpCommand({ type: "mcp.server-remove", commandId: newCommandId(), serverId: McpServerId.make(serverId) }),
```
**Built-ins are NOT deletable** — render the trash icon (and the whole confirm flow) **only when
`server.source !== "builtin"`** (a shipped built-in would just be re-seeded on next startup; to hide one
durably the user disables it via ⑬). For a custom server, add a trash icon beside the pencil that opens an
`AlertDialog` listing `boundProjects` (already computed) before calling `removeServer(server.id)`:
```tsx
<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
  <AlertDialogPopup>
    <AlertDialogHeader>
      <AlertDialogTitle>Удалить «{server.name}»?</AlertDialogTitle>
      <AlertDialogDescription>
        {boundProjects.length > 0
          ? `Будет удалён из каталога и из проектов: ${boundProjects.map((p) => p.name).join(", ")}. Связанные секреты тоже удалятся.`
          : "Будет удалён из каталога. Связанные секреты тоже удалятся."}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogClose render={<Button variant="outline" />}>Отмена</AlertDialogClose>
      <Button variant="destructive" onClick={() => { removeServer(server.id); setConfirmOpen(false); }}>Удалить</Button>
    </AlertDialogFooter>
  </AlertDialogPopup>
</AlertDialog>
```
(Backend cascade + secret GC already exist; B4 cleans overlays.) The delete affordance never appears for
built-ins (gated above), so the modal copy needs no built-in special case.

### ⑬ Catalog: **disable switch** (uses B5)
*Files: `RegistryTab` row **and** `RegistryDetail` header* (decision: place it in **both**). A
`Switch checked={server.enabled} onCheckedChange={(v) => setServerEnabled(server.id, Boolean(v))}` — one on
every catalog **list row** (toggle without opening the server) and one in the **detail header**. Requires
`McpRegistryServer.enabled` (map from `server.enabled` in the adapter). When off, the row is visibly dimmed
(`opacity-50`); backend B5 excludes it from probe + overlay; the project side grays per ⑬(project side).

### ⑭ Catalog list: **right-click** context menu (refresh / edit / delete)
*File: `RegistryTab.tsx`.* Use the app's **existing cross-platform** context-menu — `api.contextMenu.show(...)`
via `readLocalApi()` (`localApi.ts` → `window.desktopBridge.showContextMenu` in Electron, `showContextMenuFallback`
on web). **Same logic as the sidebar's thread/project menus — zero custom code, identical in Electron and web.**
Items are `ContextMenuItem<T>` (`{ id, label, destructive?, disabled? }` from `@t3tools/contracts`).
```tsx
// imports: import { readLocalApi } from "~/localApi";  (the `~` alias = apps/web/src, already used in this file)
// on the row <button …> (or the <li>): add onContextMenu={(e) => handleRowContextMenu(e, server)}
const handleRowContextMenu = (event: React.MouseEvent, server: McpRegistryServer) => {
  event.preventDefault();
  void (async () => {
    const clicked = await readLocalApi().contextMenu.show(
      [
        { id: "recheck", label: "Проверить", disabled: server.incomplete },
        { id: "edit", label: "Редактировать" },
        // delete only for custom servers — built-ins are not deletable (mirror ③)
        ...(server.source !== "builtin"
          ? [{ id: "delete" as const, label: "Удалить", destructive: true }]
          : []),
      ] satisfies ContextMenuItem<"recheck" | "edit" | "delete">[],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "recheck") void recheck({ serverId: server.id });
    else if (clicked === "edit") { selectServer(server.id); setDetailOpen(true); }
    else if (clicked === "delete") openDeleteConfirm(server.id);
  })();
};
```
(`recheck` from `useMcpMutations()`; `selectServer`/`setDetailOpen` already in `RegistryTab`; `openDeleteConfirm`
is the ③ delete-confirm opener. `import type { ContextMenuItem } from "@t3tools/contracts"`. `server.source`
is on `McpRegistryServer`.)

### ⑮ Refresh disabled when required fields aren't filled
*Files: `RegistryDetail.tsx`, `ProjectBindingRow.tsx`.* Pass `disabled` to `RecheckButton`:
```tsx
// RegistryDetail
<RecheckButton filter={{ serverId: server.id }} ariaLabel={…} disabled={server.incomplete} />
// ProjectBindingRow
<RecheckButton filter={{ projectId: binding.projectId, serverId: server.id }} ariaLabel={…} disabled={binding.incomplete} />
```
(`RecheckButton` already supports `disabled`.) Title when disabled: "Заполните обязательные поля".

### ⑯ Built-in template dialog: lock name + description, hide transport switch
*Files: `McpServerDialog.tsx`, `ServerConfigFields.tsx`.* In template mode (the migrator owns these):
- Name input: `<Input id="mcp-name" … disabled={isTemplate} />`.
- Description textarea: **also `disabled={isTemplate}`** (the built-in owns its description; backfill/sync
  set it). Both name and description are read-only for a built-in.
- Transport switch: add a `hideTransport` prop to `ServerConfigFields` (default false) and pass
  `hideTransport={isTemplate}`; render `<TransportSegmented …/>` only `{!hideTransport && (…)}`. (Currently
  it's `disabled` but visible — hide it for templates since it has zero value.)

### ④ Projects tab: "refresh all" beside a smaller project dropdown
*Files: `ProjectsTab.tsx`, `McpPanel.tsx`.* **Verified:** `McpPanel` already has a project-scoped recheck in
its header (lines 42–49: `<RecheckButton filter={routeProjectId !== null ? { projectId: routeProjectId } : {}} disabled={routeProjectId === null} …/>`). **Move** it into the projects-tab toolbar and shrink the `Select`.
- `McpPanel.tsx`: delete that `<RecheckButton …/>` element (lines 42–49) **and** its import (line 9
  `import { RecheckButton } from "./RecheckButton";`). `activeProject`/`routeProjectId` stay (used by the
  project-sync `useEffect`). The header then holds only the title + close button.
- `ProjectsTab.tsx`: import `RecheckButton`; shrink the `SelectTrigger` (`className` `min-w-0 flex-1` →
  `min-w-0 max-w-[60%]`) and add the button after the `</Select>`:
  ```tsx
  // add import (RecheckButton is its OWN file ./RecheckButton.tsx, NOT exported from ProjectBindingRow):
  //   import { RecheckButton } from "./RecheckButton";
  // after </Select>, inside the toolbar div:
  <RecheckButton
    filter={activeProjectId ? { projectId: activeProjectId } : {}}
    disabled={activeProjectId === ""}
    ariaLabel="Проверить все серверы проекта"
    title="Проверить все"
    className="ml-auto shrink-0"
  />
  ```
The catalog tab keeps its own per-server recheck (RegistryDetail).

### ⑤/⑥/⑦/⑧ Project binding row: pencil icon, header delete, description, show-in-catalog
*File: `ProjectBindingRow.tsx`.* **Imports to add:** `PencilIcon`, `BookOpenIcon` (lucide; the file already
imports `ChevronDownIcon, SlidersHorizontalIcon, Trash2Icon`); `selectServer`, `setActiveTab` from
`useMcpManagerStore` (`import { useMcpManagerStore } from "../store"` — add it; the file currently imports
only `isToolEnabled` from `../store`). Pull them in-component: `const selectServer = useMcpManagerStore((s) => s.selectServer); const setActiveTab = useMcpManagerStore((s) => s.setActiveTab);`. `SlidersHorizontalIcon`
becomes unused after ⑤ → drop it from the import.
- **⑤** `SlidersHorizontalIcon` → `PencilIcon` on the `ProjectConfigDialog` trigger (icon only; same dialog).
- **⑥** add a header trash icon beside `RecheckButton`: `<Button size="icon-xs" variant="ghost" title="Убрать из проекта" onClick={() => removeBinding(server.id, binding.projectId)}><Trash2Icon/></Button>` (keeps the collapse button too).
- **⑦** show the server description: replace/augment the `detail` line — when not incomplete and
  `server.description` is set, show it (the health line can move into the collapse). Concretely render a
  second muted line `{server.description}` under the name when present.
- **⑧** «Показать в каталоге» is a button that **sits directly next to the «Убрать из проекта» (remove)
  button**, same size/variant, as a pair (in the collapse, where the remove button lives):
  `<Button variant="outline" size="sm" onClick={() => { selectServer(server.id); setActiveTab("registry"); }}><BookOpenIcon/>Показать в каталоге</Button>` (pull `selectServer`/`setActiveTab` from `useMcpManagerStore`).
- **⑬(project side) — disabled server shows grayed, not removed (B5(c)):** when `server.enabled === false`,
  wrap the row in `opacity-50` and render an «отключён в каталоге» hint with a neutral dot (no error). The
  binding stays listed; re-enabling in the catalog restores it. (`server.enabled` is on `McpRegistryServer`.)

### ⑩ Project row: **right-click** context menu (refresh / show-in-catalog / delete)
*File: `ProjectBindingRow.tsx`.* Same `api.contextMenu.show(...)` pattern as ⑭ — `onContextMenu` on the row's
header `<div>` (line 47). **No `edit` item** — per-project edit stays on the pencil affordance (⑤), so the
menu needs **no** control over `ProjectConfigDialog` (which owns its own `open` state via a trigger and
exposes no `open`/`onOpenChange` props; adding controlled props just to duplicate the pencil would be dead
weight). Three items + dispatch — all use store/mutation setters already in scope, zero new wiring:
```tsx
// imports: import { readLocalApi } from "~/localApi"; import type { ContextMenuItem } from "@t3tools/contracts";
const handleRowContextMenu = (event: React.MouseEvent) => {
  event.preventDefault();
  void (async () => {
    const clicked = await readLocalApi().contextMenu.show(
      [
        { id: "recheck", label: "Проверить", disabled: binding.incomplete },
        { id: "show", label: "Показать в каталоге" },
        { id: "delete", label: "Убрать из проекта", destructive: true },
      ] satisfies ContextMenuItem<"recheck" | "show" | "delete">[],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "recheck") void recheck({ projectId: binding.projectId, serverId: server.id });
    else if (clicked === "show") { selectServer(server.id); setActiveTab("registry"); }
    else if (clicked === "delete") removeBinding(server.id, binding.projectId);
  })();
};
```
(`recheck`/`removeBinding` from `useMcpMutations()`; `selectServer`/`setActiveTab` from `useMcpManagerStore`
— already pulled in for ⑧. To edit per-project, the user clicks the pencil (⑤) — `ProjectConfigDialog`
stays trigger-driven and untouched.)

---

## Part 3 — ⑱/⑲ escape-hatch fields (dialog): `extraArgs` (stdio) + `extraHeaders` (http), templates only
*File: `McpServerDialog.tsx`.* Both are escape hatches for **locked templates** (a manual server edits
`args`/`headers` directly), so both are **template-only**.

**⑱ — gate `ExtraArgsField` on a locked template:**
```tsx
// BEFORE
{showExtraArgs && (
  <ExtraArgsField value={extraArgsText} onChange={setExtraArgsText} idPrefix="mcp-add" />
)}
// AFTER  (stdio AND a locked template only)
{showExtraArgs && isTemplate && (
  <ExtraArgsField value={extraArgsText} onChange={setExtraArgsText} idPrefix="mcp-add" />
)}
```

**⑲ — show `ExtraHeadersField` for a locked http template** (the B6 UI half). Add a new `extraHeadersText`
state (init from `(server?.extraHeaders … )`, formatted `Key: Value` per line, like `serverConfigForm`'s
header parsing), a `showExtraHeaders = draft.transport === "http"` flag, and render beside the vars editor:
```tsx
{showExtraHeaders && isTemplate && (
  <ExtraHeadersField value={extraHeadersText} onChange={setExtraHeadersText} idPrefix="mcp-add" />
)}
```
`ExtraHeadersField` is a new tiny component mirroring `ExtraArgsField` but using a `Textarea` and
`Key: Value` lines. **Helper sources (verified):** `parseHeaderLines(text): Record<string,string>` is
exported from **`./addMcpParsing`** (NOT `serverConfigForm`) — import it from there. `recordToLines(record,
separator)` is currently a **private** helper in `serverConfigForm.ts` (line 31) — **add `export`** to it
and call `recordToLines(value, ": ")` to format (same call `draftFromConfig` already makes at
`serverConfigForm.ts:51`). `Textarea` is imported from `~/components/ui/textarea` (already imported in
`McpServerDialog.tsx`). The dialog's `handleSubmit` parses the text via `parseHeaderLines` to a
`Record<string,string>` and sends it as `extraHeaders` (B6 `useMcp` wiring).
**Risk:** none for ⑱ (manual loses a redundant field); ⑲ is additive (B6).

---

## Future improvements (design captured, not built now)

> Branch-1 ships the **catalog-level** `extraArgs` (⑱, already in the model) and `extraHeaders` (B6/⑲). The
> future work is the **per-project (binding-level)** versions — a project customizes args/headers *without
> forking* the catalog server.

### FI-1 — per-project `extraArgs` (on the binding)
A binding carries its own `extraArgs`, appended after the **catalog** `extraArgs` + template args. It keeps
the **catalog identity** (never forked) but mints a **distinct `configCacheKey`/`dedupHash`** → its own probe
instance + cache row (exactly like a per-project var value), and still inherits template changes. Touch
points: `McpBinding` + `McpBindingPatch` += `extraArgs`; pass `[...server.extraArgs, ...binding.extraArgs]` at
the binding call sites (`McpReactor.mergeDesired`, `McpOverlay.writeOverlay`); a per-project `ExtraArgsField`
in `ProjectConfigDialog`. The dedup model already supports this cleanly.

### FI-2 — per-project `extraHeaders` (on the binding, http)
The http analogue of FI-1: a binding adds/overrides headers on top of the catalog template + catalog
`extraHeaders`, keeping catalog identity and spawning its own probe. Touch points: `McpBinding`/
`McpBindingPatch` += `extraHeaders`; `resolveConfig` (http branch) already merges `extraHeaders` (B6) — feed
`{ ...server.extraHeaders, ...binding.extraHeaders }`; folded into `configCacheKey`; a per-project headers
editor in `ProjectConfigDialog`. Ships **together with FI-1** as the per-project-customization feature.

*(Per your decision: **no `extraHeaders` at all in branch-1** — not catalog-level, not anywhere. The only
`extraHeaders` we will ever add is this per-project one, and it's future. A locked http built-in that needs
auth today uses a shipped secret var referenced in a header.)*

---

## Summary & sequencing

| # | Item | Type | Where |
|---|---|---|---|
| F1 | complete binding never probed | bug | McpSupervisor.reconcile |
| F2 | incomplete binding blue→gray | nit | adapters.bindingToUi |
| B1 ⑨⑰ | hard error → red | bug | nextStatus (+probe.timedOut) |
| B2 ① | appear-after-F5 | bug | R5 (done) + confirm |
| B3 ② | auto description + docs link, only-if-empty (built-in shipped link → probed → empty) | feature | probe→cache→reactor backfill→adapter; new catalog `websiteUrl` col + `McpBuiltinDefinition.websiteUrl?` |
| B4 ③ | overlay cleanup | bug | McpOverlay.removeOverlay + reactor on project.deleted |
| B5 ⑬ | catalog enabled flag (disable = grayed at project level, not removed) | feature | contracts+migration+reactor+overlay+UI |
| B6 ⑲ | catalog extraHeaders (http templates) | feature | contracts+migration+resolver+builders+UI |
| ⑪ | list status dot+error | ui | RegistryTab + adapter.message |
| ⑫ | detail error text | ui | RegistryDetail |
| ③ | delete + confirm modal (**custom servers only — no delete for built-ins**) | ui | RegistryDetail + useMcp.removeServer |
| ⑭ | catalog right-click menu (delete item gated to custom) | ui | RegistryTab (api.contextMenu.show) |
| ⑮ | refresh disabled if incomplete | ui | RegistryDetail + ProjectBindingRow |
| ⑯ | builtin lock **name + description**/hide transport | ui | McpServerDialog + ServerConfigFields |
| ④ | refresh-all in projects tab | ui | ProjectsTab + McpPanel |
| ⑤⑥⑦⑧⑩⑬ | project row: pencil/delete/desc/show-in-catalog(next to remove)/menu/grayed-when-disabled | ui | ProjectBindingRow |
| ⑱⑲ | extraArgs/extraHeaders fields, template-only | ui | McpServerDialog + ExtraHeadersField |
| FI-1/2 | per-project args/headers | future | — |

**Order:** Phase 1 = backend bugs/data (F1, F2, B1, B4, B5, B6, B3) — gate. Phase 2 = catalog UI (⑪ ⑫ ③ ⑬ ⑭ ⑮ ⑯)
— gate. Phase 3 = projects UI (④ ⑤ ⑥ ⑦ ⑧ ⑩) + ⑱⑲ dialog fields — gate. B2 is just confirmation. FI-1/2 deferred.
**Three contract+migration changes** (B3 probe-cache cols + catalog `websiteUrl`; B5 catalog `enabled`; B6
catalog `extraHeaders`) — all edit the single `031` migration in place. **New mutations:** `removeServer` (③),
`setServerEnabled` (⑬). **New component:** `ExtraHeadersField` (⑲) only.
**Right-click menus (⑭/⑩):** no new component — reuse the existing cross-platform
`readLocalApi().contextMenu.show(items, { x, y })` (the sidebar's pattern; Electron + web), `onContextMenu`
on the row, dispatch by returned `id`. Zero custom code.
