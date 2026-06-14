# MCP config model — vars/template (PLAN + progress)

> ✅ DONE: the MCP UI has been reworked to the vars/template contracts. Server + web both green
> (typecheck 10/10, lint 0/0, test:fast only the 4 preexisting bin.test.ts). The ONLY remaining
> items are the two deferred server niceties in §C (secret-store GC of orphaned var secrets;
> catalog-edit warn-on-impact) — non-blocking, no compile/UX dependency.



> Separate addition to `mcp-progress.md`. This is the resume anchor for the MCP
> **config-model v2** work. Nothing here is built yet — it's the agreed design +
> build plan. The earlier session's work (below, "Carried forward") is DONE and
> must not be regressed.
>
> Worktree: `/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code/.claude/worktrees/mcp`
> Branch `ru-code`. Everything uncommitted. qwen-code source (read-only reference):
> `/mnt/mac/Users/user/WORKSPACE/Projects/experements/qwen-code`.

## BUILD STATUS (update as you go — this is how we know where it broke)

| Step | What | Status |
|---|---|---|
| 1 | Contracts (vars/template) + resolver + cache-key | ✅ server-green |
| 2 | Decider/secrets (splitServerVars/splitBindingVarValues/materialize) | ✅ server-green |
| 3 | Persistence `031` (vars_json, var_values_json, timeout_ms) + repos | ✅ server-green |
| 4 | Overlay (per-server literal env, incomplete exclude, 0600/0700 via atomicWrite) + reactor (incomplete skip, cache GC) | ✅ server-green |
| — | Secret-store GC on orphaned vars (reactor) | ⬜ TODO |
| — | Catalog-edit warn-on-impact | ⬜ TODO |
| 5 | Catalog UI (vars block + validation) | ✅ done |
| 6 | Project UI (holes + timeout + incomplete marker/dot) | ✅ done |
| 7 | mcp-core tests rewrite (resolver API) | ✅ done (18 tests pass) |
| D | McpDefaults builtins re-expressed in vars model (empty vars) | ✅ done |

**ALL GATES GREEN:** typecheck 10/10, lint 0/0, test:fast (only 4 preexisting bin.test.ts).
Note: finishing the UI surfaced two server typecheck gaps the prior "server-green" claim
missed — `McpDefaults` still had v1 `env:{}`/no `vars`, and `McpRuntime` called the old
1-arg `configCacheKey`. Both fixed (catalog default keys on `(config, vars, {})`).

### EXACT remaining work to finish v2 (resume here)

**A. Web UI (the whole vars model in the client).** Today only `adapters.ts` (7) + `useMcp.ts` (2) ERROR,
but that's only because `types.ts` still has the v1 UI shape (`env`, `configOverride`, `timeoutMs` on config).
Doing it RIGHT means:
- `apps/web/src/ru-fork/mcp-manage/types.ts` — `McpServerConfig`: drop `env`/`timeoutMs` (stdio = command+args;
  http = httpUrl+headers template strings). Add a UI `McpVar` type `{name,value,secret,perProject,required}` and
  `vars` on `McpRegistryServer`. `McpProjectBinding`: drop `configOverride`; add `varValues: Record<string,string>`
  (masked for secrets), `incomplete: boolean` + `missingVars: string[]`, `timeoutMs?`.
- `adapters.ts` — `contractConfigToUi` (no env/timeout), `catalogServerToRegistry` maps `server.vars` (mask
  secret values → "" ; per-project holes shown empty), `bindingToUi` maps `varValues` + computes `incomplete`/
  `missingVars` from the catalog server's vars. Drop the env/header secret-ref masking on config.
- `useMcp.ts` — `addServer`/`updateServer` send `{config, vars: McpServerVarDraft[], timeoutMs}`; binding mutation
  sends `{varValues: Record<string,string>, toolPolicy, enabled, timeoutMs}` (NO configOverride). Add a `setVarValues`
  mutation. `useMcpRegistry` already joins catalog runtime — keep.
- `components/serverConfigForm.ts` — drop env/headers-as-secrets + timeout from the config draft; **add a vars
  draft** (rows: name/value/secret/perProject/required). Keep headers as plain template lines for http.
- `components/ServerConfigFields.tsx` — template fields (command/args/url/headers) + the **vars block** (rows with
  `[секрет]` / `[для проекта]`→`[обязательно]`, `+`). **Validate**: var name `[A-Z0-9_]+`/no dups/not PROJECT_CWD;
  warn on `${X}` referencing an undeclared var; warn on `$NAME`/`${…}` inside a value (§D12).
- `components/McpServerDialog.tsx` — catalog add/edit using the template + vars block.
- `components/ProjectConfigDialog.tsx` — **holes-only**: list the catalog's `[для проекта]` vars (name read-only,
  value editable, secret masked, required `*`) + allowed tools + timeout + enabled. No template fields.
- `components/ProjectBindingRow.tsx` — `⚠ требует настройки` marker (from `binding.incomplete`) + tooltip of
  `missingVars`; gate the row's status. `components/ProjectsTab.tsx` — a dot on projects with ≥1 incomplete binding.
- `components/ConfigSummary.tsx` — render the template (no `config.env`); show vars summary instead.
- `store.ts` — drop `effectiveBindingConfig`/configOverride helpers; keep pure selectors.

**B. mcp-core tests** — ✅ DONE. `mcpCore.test.ts` rewritten for the new API (18 tests). Server `test:fast`
green (only the 4 preexisting `bin.test.ts`). The server side is now genuinely ready (typecheck + tests).

**C. Still-TODO server bits (deferred, non-blocking for compile):** secret-store GC of orphaned var secrets on
catalog edit/binding change (reactor — sibling of cache GC, use `collectVarSecretRefs`); catalog-edit warn-on-impact.
These are the ONLY remaining items; everything else (server + web) is done and green.

**D. Defaults** — ✅ DONE. `McpDefaults.ts` builtins now carry `vars: []` (filesystem: `${PROJECT_CWD}` in args,
no vars; context7: http, no vars). Both compile + seed cleanly.

### Web UI rework — DONE (the cascade, for the record)
`types.ts` (config=template, `McpVar`, binding gains `varValues`/`incomplete`/`missingVars`/`timeoutMs`) →
`adapters.ts` (`uiConfigToContract`, `uiVarsToDraft`, mask secrets, local `computeMissingVars`) →
`useMcp.ts` (add/update send `{config,vars,timeoutMs}`; `setProjectBinding` replaces `setBindingConfig`; bindings
join catalog) → `serverConfigForm.ts` (template-only draft + timeout/vars validation + `$…` warnings) →
`ServerConfigFields.tsx` (template fields) + new `VarsEditor.tsx` (vars block) + new `TimeoutField.tsx` →
`McpServerDialog.tsx` (template+vars+timeout, validation, warnings; JSON tab maps `env`→vars) →
`ProjectConfigDialog.tsx` (holes-only + timeout; empty ⇒ inherit) → `ProjectBindingRow.tsx` (`⚠ требует настройки`
marker + `server.config`) → `ProjectsTab.tsx` (amber dot on incomplete projects) → `ConfigSummary.tsx`
(template + vars summary, no `config.env`) → `store.ts` (dropped `effectiveBindingConfig`).
Write-only secrets: editing a secret-bearing server / per-project secret means re-entering it (empty ⇒ cleared/
inherit) — honest, matches the server's full-replace var-values semantics.

### Gotchas already hit (avoid re-hitting)
- v2 resolver `ResolveContext` dropped `processEnv` (was unused); context = `{projectCwd, secretValues}`.
- decider `mcp.binding-set` needs the catalog server's `vars` to split secret values — it now fetches the server
  (note: `requireCatalogServer` is currently called twice in that branch; consolidate to one assignment).
- `materializeSecretValues(vars, varValues)` (was `(config)`); `splitServerVars`/`splitBindingVarValues` replace
  `splitConfigSecrets`; `mcpVarSecretName` replaces `mcpSecretName`.
- overlay perms: `writeFileStringAtomically` now takes optional `{mode, dirMode}` — overlay passes `0o600`/`0o700`.

Gates each step: `pnpm typecheck` (10/10), `pnpm lint` (0; flaky native-binding in this sandbox — retry), `pnpm test:fast` (only the 4 preexisting `bin.test.ts` may fail). Web has NO tests — typecheck+lint only.

---

## THE PROBLEM (why we're doing this)

Today a per-project binding can hold a full `configOverride` (any command/args/url/env).
So a project's "filesystem" binding can be edited into a *completely different* MCP
(postgres, whatever) while still being grouped under the catalog server's identity.
That's the inconsistency. **Field-level locking doesn't fix it** because `command`
is generic (`npx`/`uvx`/`bash`), so the identity lives *inside* `args` (the package
name) tangled with per-project params (a path) — you can't cleanly lock "args".

## THE SOLUTION — catalog owns the template, binding owns only values

- **Catalog server = a config *template* + a `vars` block.** Template = `transport,
  command, args[], url, headers` with `${NAME}` holes. Vars = named values.
- **Binding = per-project only:** `{ varValues, toolPolicy, timeoutMs?, enabled }`.
  **No `configOverride`.** A binding has *no field that can hold a different server* —
  only values for the holes the catalog opened. **Identity is locked by construction.**
- **Runtime config is always derived** = catalog template + binding's var values +
  `${PROJECT_CWD}`. Real divergence = an explicit new catalog entry (not a silent override).

This is the same pattern as the official MCP registry / Claude Desktop config (declared
inputs you fill in) — not invented-here.

---

## DECISIONS (every one, with why)

### D1. Catalog = template + vars; binding = var values (no override)
**Why:** identity un-overridable by construction (binding can't represent another server).

### D2. Var shape: `{ name, secret, perProject, required, value }`
- `[секрет]` → value stored in `ServerSecretStore` (masked, write-only in UI).
- `[для проекта]` → a per-project hole; **reveals** `[обязательно]` (required).
- `[обязательно]` (only when perProject) → must resolve to a value; drives incomplete-gating.
- catalog `value` = the fixed value / the per-project default / empty.

Semantics table (the four perProject combos):

| perProject | required | catalog value | meaning |
|---|---|---|---|
| off | — | set | **fixed/shared** — projects can't touch it |
| on | off | empty | optional hole — empty is fine |
| on | off | default | inherit default, overridable |
| on | on | empty | **must set per project** (e.g. `SPACE_ID`) → incomplete until filled |
| on | on | default | default satisfies it; overridable → never incomplete |

`[секрет]` is orthogonal and applies to any row. **"Use a different token per project"
is NOT a separate feature** — it's just a per-project secret with a catalog default
(inherit by default, override per project). **Why:** redundant; collapses into the var model.

### D3. Vars are dual-channel: env var (stdio) + `${NAME}` reference
Every var is exported as a process **env var** (name = var name) for stdio servers,
**and** usable as `${NAME}` in command/args/url/headers.
**Why:** env-based servers (the common case) work by *just declaring the var* — no
`${...}` needed, no double-declaration. Arg-based servers reference `${NAME}` in args.
For the common env-based server you literally just declare vars and stop.

### D4. Substitution syntax: braced-only `${NAME}`, `$$` escape, single-pass, no shell
- Only `${NAME}` is a placeholder (**drop bare `$NAME`**). **Why:** bare `$NAME` is what
  corrupts values like `P@$$W0RD` / `…$W0RD…`.
- `$$` → literal `$`. Single-pass (a substituted value is not re-scanned).
- `args` is an **array**, spawned without a shell → no quoting/injection; a value with
  spaces is one argv element (substitution is per-token, on the template, before re-split).
- Resolution order: `PROJECT_CWD` (builtin) → declared var (**binding value ?? catalog
  default**) → empty.

### D5. Secrets are opaque + isolated
- Opaque: a secret value is inserted verbatim where referenced and **never re-expanded**
  (fixes the `P@$$W0RD` corruption). **Why:** secrets can contain any characters.
- Stored in `ServerSecretStore`: catalog-level secret vars keyed per-server; per-project
  secret values keyed per-binding. Masked/write-only in the client (only `{secretRef}` on
  the wire). **Why:** keep secrets out of the event log / projections / client.

### D6. `timeoutMs` moves from config → binding (per-project)
Effective timeout = `binding.timeoutMs ?? catalog.timeoutMs ?? 30s`. **Why:** it's a
per-project knob, not identity. Catalog keeps a default.

### D7. Project surface = holes + tools + timeout + enabled
The project dialog shows: per-project var values (name **read-only**, value editable;
secret → masked input; required marked `*`) + allowed tools (`toolPolicy`) + timeout +
enabled. **No** transport/command/args/url/var-declarations. **Why:** all four are
per-project and non-identity; the rest is locked.

### D8. Incomplete binding = computed + gated + marked (never silently broken)
"Incomplete" = (template's required holes) − (binding's filled values). **Derived, no
stored field.** Threaded through 3 places:
- **Reactor** `computeDesired` **skips** incomplete bindings → not probed.
- **Overlay** **excludes** incomplete bindings → qwen never spawns with an empty required value.
- **UI**: amber `⚠ требует настройки` on `ProjectBindingRow` (distinct from connection
  status) + tooltip listing the missing var names; a **dot** bubbles to the project in the
  Projects tab.
**Asymmetry (intentional):** missing-required → loud (marker + gated); orphaned value
(var removed from catalog) → **silent auto-prune**, no marker. **Why:** the user must act
on the former; nothing to do for the latter.

### D9. Catalog-edit lifecycle: not locked, warn + auto-reconcile
- **Never lock** the catalog (you must be able to fix it). 
- **Warn on impact**: removing a per-project var ("значения «X» в N проектах будут
  удалены"); adding a required hole ("N проектов нужно будет настроить").
- **Auto-prune** orphaned `varValues` + orphaned secrets (secret-store GC — sibling of the
  cache GC). Newly-required holes → bindings flagged incomplete. Identity/shared changes →
  propagate to all + restart on fingerprint change (existing mechanism).
**Why:** consistency without rigidity; can't leave a project silently broken.

### D10. qwen re-substitutes our overlay — SOURCE-VERIFIED
qwen-code runs `resolveEnvVarsInObject` over the **whole** loaded settings, including our
`mcpServers` entries. Facts (verified in qwen-code):
- `envVarResolver.ts`: regex `/\$(?:(\w+)|{([^}]+)})/g`; substitutes from qwen's
  **process.env**; **single-pass**; **undefined var → placeholder preserved**; **NO escape
  character**; only values, not keys.
- `settings.ts:138/654/684`: `QWEN_CODE_SYSTEM_SETTINGS_PATH` (our overlay) → `systemResult`
  → `resolveEnvVarsInObject(systemResult.settings)`. `mcpServers` is a settings field
  (`settingsSchema.ts:181`).
- `mcp-client.ts:1404`: stdio child env = `{ ...process.env, ...config.env }`.
- `AcpSessionRuntime.ts:234` (ru-code): spawn env = `{ ...process.env, ...options.spawn.env }`
  → qwen's process.env = ru-code base env + what we inject.

### D11. Delivery DECISION: per-server **literal** `config.env` — NOT ref-ification
We considered "ref-ification" (write `${RU_MCP_n}` refs, put real values in qwen's
process.env, let qwen substitute). **REJECTED.** **Why:** qwen spawns *every* MCP child
with `{ ...process.env, ... }`, so any value in qwen's process.env leaks to **all** MCP
children — a Confluence server could read your GitHub token; a malicious `npx` MCP could
exfiltrate every secret. Instead, write each server's resolved values into its **own**
`mcpServers[<id>].env` block (per-server) — qwen applies that block only to that server's
child, so **secrets are isolated per MCP**. We do all substitution ourselves and write
literals, so qwen's resolver is a **no-op** on clean values.

### D12. The only residual risk: `$ENVNAME` corruption — rare, warned
Because there's no escape char in qwen and we write literals, a value containing `$` +
an **exact env-var name** (`$HOME`, `${PATH}`, …) is still expanded/corrupted by qwen.
- Tokens/keys are **zero-risk** (no `$` in their charset). `wor$ld`/`P@$$w0rd` survive
  (name after `$` isn't a real env var → preserved). Only `my$HOME`-style collides.
- Unfixable without re-introducing the cross-MCP leak. So **warn at authoring** if a value
  contains `$NAME`/`${…}`. Note qwen's `$VAR` expansion is *also useful* for intentional
  machine-env refs (`$HOME/cache`, `$AWS_REGION`) — only literal-`$ENVNAME` is the hazard.

### D13. Overlay file perms MUST be `0600` / dir `0700` (current GAP)
`ServerSecretStore` is plaintext `.bin` @`0o600` in a `0o700` dir — **not encrypted**; its
job is "out of events/client" + owner-only perms. The overlay (`McpOverlay` via
`atomicWrite.ts` / `mcpOverlayDir`) is currently written with **default perms (~0644,
world-readable)** — so writing resolved secrets there is a **real downgrade**. Fix: write
`system.json` at `0o600` inside a `0o700` `mcpOverlayDir`. Then "secret in overlay" = "secret
in store" (same owner-only-plaintext boundary). **Why:** plaintext-at-spawn is unavoidable
(qwen needs it); minimize footprint + match the store's protection.

### D14. Coverage (audited)
Covers: stdio (npx/uvx/node/python/docker), HTTP/Streamable, **SSE** (qwen auto-fallback on
the http url), env-based, arg-based, URL/path params, Bearer/API-key/Basic auth, per-project
params, shared+per-project secrets w/ defaults, required holes, repeated/bool/`--k=v` flags,
`${PROJECT_CWD}`, per-server timeout, tool allow/deny, any-chars secrets.
Gaps (verdicts): **OAuth** servers → qwen's domain (`authProviderType`/`createTransportWithOAuth`),
not ours; **generated config files** → out of scope (we pass paths, not contents); **conditional
/omit-if-empty args** → minor, future flag; **custom process cwd** → minor, future field. All
non-breaking future additions.

### D15. This REPLACES the env-secret-refs + configOverride model (v1) — unreleased
Edit migration `031` **in place** (no stacking, no data migration). Re-express builtins
(`McpDefaults`) in the vars model.

---

## CHANGE SURFACE (by layer, with files)

**1. Contracts** (`packages/contracts/src/ru-fork/mcp.ts`, `rpc.ts`, `settings.ts`)
- `McpStdioConfig = {transport, command, args[]}`; `McpHttpConfig = {transport, httpUrl,
  headers: Record<string,string>}` — **remove env/headers secret-refs + `timeoutMs` from config**.
- New `McpServerVar {name, secret, perProject, required, value}`; `McpCatalogServer` gains
  `vars: McpServerVar[]` + a default `timeoutMs`.
- `McpBinding`: drop `configOverride`; add `varValues: Record<string, secretRef|string>` +
  optional `timeoutMs`.
- Drafts/patches carry plaintext var values inbound (`McpServerDraft`, `McpBindingPatch`).
- (rpc.ts `mcp.recheck` etc. from v1 stay.)

**2. Resolver** (`packages/mcp-core/src/resolver.ts`, `fingerprint.ts`)
- Braced-only `${NAME}`; order PROJECT_CWD → var(bindingValue ?? catalogDefault) → empty;
  `$$`→`$`; single-pass; opaque secrets (verbatim insert).
- Build env = all user vars; substitute into command/args/url/headers.
- Replace `effectiveConfig` (override-or-default) with "resolve template + binding var values".
- `configCacheKey`/`dedupHash` now hash the **resolved** template+vars (so per-project var
  diffs split probes; identical collapse — keeps the neutral-cwd collapse from v1).

**3. Decider/secrets** (`apps/server/src/ru-fork/mcp/McpSecrets.ts`, `McpSecretNames.ts`,
`McpCatalogBuilders.ts`, decider branches)
- Split **secret vars** → store (catalog vars per-server; per-project secret values per-binding).
- **Secret-store GC**: prune orphaned secrets when a secret var/value is removed.
- `materializeSecretValues` resolves the refs at probe/overlay time.

**4. Persistence** (single `031`, edited in place; `ProjectionMcpCatalog.ts`,
`ProjectionMcpBinding.ts`, `Services/McpCatalog.ts`, `McpBinding.ts`)
- `mcp_catalog_server`: add `vars_json`; `config_json` loses env/secret refs.
- `mcp_project_binding`: replace `config_override_json` with `var_values_json` + `timeout_ms`.

**5. Overlay + reactor** (`McpOverlay.ts`, `McpReactor.ts`, `McpSupervisor.ts`, `McpRuntime.ts`,
`atomicWrite.ts`/`config.ts` for perms)
- Resolve template+vars+varValues → **per-server literal `config.env`** (+ command/args/headers/url),
  effective timeout. **No ref-ification, no `RU_MCP_*`, nothing extra in qwen's process env.**
- **Overlay perms**: write `system.json` `0o600` in a `0o700` `mcpOverlayDir` (atomicWrite gains a
  mode; ensure dir mode).
- **Incomplete gating**: reactor `computeDesired` skips incomplete bindings; overlay excludes them.
- **Catalog-edit**: warn-on-impact + auto-prune orphaned varValues + secret GC (reactor).
- (Spawn `CliAcpSupport`/`CliAdapter` need **no change for values** — literal config.env lives in
  the overlay file, not the spawn env. The `settingsEnv` idea was only for ref-ification → DROPPED.)

**6. Catalog UI** (`apps/web/src/ru-fork/mcp-manage/`: `serverConfigForm.ts`, `ServerConfigFields.tsx`,
`McpServerDialog.tsx`)
- Template fields + **vars block** (rows: `name`, `value`, `[секрет]`, `[для проекта]`→`[обязательно]`,
  `+`). Remove old env/header secret editors.
- **Validate**: var names `[A-Z0-9_]+`, no dups, not `PROJECT_CWD`; warn on `${X}` referencing an
  undeclared var; **warn on `$NAME`/`${…}` inside a value** (D12).

**7. Project UI** (`ProjectConfigDialog.tsx`, `ProjectBindingRow.tsx`, `ProjectsTab.tsx`,
`adapters.ts`, `useMcp.ts`, `types.ts`)
- Project dialog → holes (name read-only, value editable, secret masked, required `*`) + allowed
  tools + timeout + enabled. No template fields.
- `ProjectBindingRow`: `⚠ требует настройки` marker + tooltip of missing vars; `ProjectsTab`: dot.
- adapters/useMcp: map `vars`/`varValues`, mask secrets, compute `incomplete` + missing list.

**8. Defaults + tests** (`McpDefaults.ts`, server-side tests)
- Re-express builtins (filesystem: `${PROJECT_CWD}` in args, no vars; context7: http, no/opt var).
- Tests: resolver (braced-only, `$$`, opaque secrets, per-project override, env-export,
  PROJECT_CWD, undeclared→empty); decider secret-split + GC; cache-key w/ vars; incomplete-gating
  decision; overlay perms.

---

## BUILD ORDER (green at each step; update STATUS table above)

1. **Contracts + resolver + cache-key + unit tests** (model only, nothing wired).
2. **Decider/secrets + secret GC** (commands carry vars/varValues; split + prune).
3. **Persistence `031`** (columns).
4. **Overlay + reactor** (per-server literal env, incomplete gating, **overlay perms 0600/0700**,
   edit-warn/prune).
5. **Catalog UI** (vars block + validation).
6. **Project UI** (holes + tools + timeout + enabled + incomplete marker/dot).
7. **Defaults + full gates** green.

---

## CARRIED FORWARD — v1 work that is DONE and must NOT regress

(From the prior session; see `mcp-progress.md`.) All green: typecheck 10/10, lint 0,
test:fast 722 pass (only 4 preexisting `bin.test.ts`).
- **Neutral-cwd probe + per-configKey collapse** — `${PROJECT_CWD}` resolves to `config.mcpProbeCwd`
  for probes; one probe/cache row per authored config; catalog defaults probed (unbound shown).
- **Catalog runtime** (`McpCatalogRuntimeSnapshot`, per-serverId by configKey) + single full-snapshot
  runtime stream. `toolsCache` deleted.
- **Manual recheck** (`mcp.recheck` RPC, supervisor `recheck` w/ in-flight coalescing, `RecheckButton`
  in catalog/row/header).
- **Universal `useActiveProject`** hook (`useActiveProjectRef`/`useActiveProject`) — **note the bug we
  fixed:** the draft-store selector must return PRIMITIVES, never a fresh object (React #185 loop).
- **Panel hoist** (`McpPanelMount` in `_chat.tsx`, single mount).
- **`monitoring` settings flag removed** (replaced by the two interval fields).
- **Cache GC** (`deleteKeysNotIn`) in reactor.
- Tests: `mcpCore.test.ts`, `McpProbeCache.test.ts`, `supervisorDecisions.test.ts`.

⚠️ **v2 interaction:** `configCacheKey` must now incorporate resolved vars (D11/step 1). The catalog
runtime + recheck still key off configKey — keep them working after the binding/config shape changes.

---

## CONSTRAINTS (from memory — hold these)
- Logs: only `Effect.logDebug` / `Effect.logError` (never info/warn).
- No `as`/`any`/`as const`/`as unknown` casts (one justified `as Transport` in `probe.ts`).
- Mark ru-fork deltas with `ru-fork:` comments; leave t3-cloned code unmarked.
- Effect 4 beta.59: `Effect.catch` (not catchAll), `.toSorted()`, exactOptionalPropertyTypes
  (conditional-spread optionals, never `k: undefined`), `Ref.modify` tuple via explicit return type
  (no `as const`).
- **Single `031` migration** — edit in place, never stack `032`.
- Secrets: env/header/var values are ALWAYS secret refs in authored config; decider splits
  plaintext→`ServerSecretStore`; overlay/probe materialize.
- MCP logic in `ru-fork/` helpers; minimize common-file edits (thin seams only).
- Web has NO test target — validate web with typecheck+lint only.
- Leave everything uncommitted.
- qwen is on another machine — NEVER run qwen or the project; hand the user a runnable artifact.

---

## OPEN QUESTIONS
None. Design is fully settled (catalog template + vars; identity locked; per-project = values
only; secrets opaque + per-server isolated; overlay 0600/0700; `$ENVNAME` warned). Coverage gaps
(OAuth/config-files/conditional-args/custom-cwd) are out-of-scope future additions, non-breaking.
