# MCP implementation — COMPLETE ✅ (all 8 phases A–H green & committed)

**Final state:** typecheck 10/10 · lint 0/0 · test:fast = only the 4 preexisting `bin.test.ts` fail
(744 passed, +16 new). All features (items 1–14 + PART K built-ins/templates + AMEND-1/2) implemented.
Phase F `480a6e56` · Phase G `21be5b6f` · Phase H below. See the per-phase deviation logs lower down.

---

# MCP implementation — HANDOFF (resume anchor)

**Worktree:** `/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code/.claude/worktrees/mcp` (branch `ru-fork/mcp`).
**Authoritative spec:** `mcp-final-plan.md` — PART A–K + AMEND-1/2 + the **REREAD VALIDATION corrections C-1…C-6** (these override the matching text above them). Read it before resuming.
**Mode:** implement straight through, commit green per phase, log deviations, DON'T report until ALL done. No questions — every decision is settled in the plan / REVISION 2 block.

## Gate per phase (must hold before commit)
`pnpm typecheck` (10/10) · `pnpm lint` (0/0) · `pnpm test:fast` (ONLY the 4 preexisting `tests/bin.test.ts` may fail — everything else passes).

## DONE — green & committed (5/8)
| Phase | Items | Commit |
|---|---|---|
| A — monitoring | 1–7 (opt-in loop, no probing on load, «не проверено»/«проверка…», edit-lock, change-driven probe) | `111eaa17` |
| B — secret GC | 10 (`pruneByPrefix` + reactor `gcOrphanedSecrets`) | `0c1161e7` |
| C — keep-secret + varValues prune + SecretField | 11,13,14 | `70461cb7` |
| D — turn-start restart | 8,9 (overlayChanged gate in `ProviderCommandReactor`; reactor active-restart removed) | `e66a6ca5` |
| E — config-model deltas | K1–K3 (locked/extraArgs/builtinId/builtinHash, resolver extraArgs+widened required, migration+projection) | `58626b47` |

## REMAINING — do these next, in order

### Phase F — built-ins migrator (PART K4–K7, C-3, C-4, C-6) — IN PROGRESS, nothing written yet
1. **Create `apps/server/src/ru-fork/mcp/McpBuiltins.ts`** (plan K4, full body there). Drop the unused `os` import (migrator passes `process.platform`). Exports: `MCP_BUILTINS`, `builtinConfigForPlatform`, `builtinShippedVars` (origin:"shipped"), `builtinHash`, `builtinServerId`, types `McpBuiltinDefinition`/`McpBuiltinVar`.
2. **`orchestration.ts`** (C-4): add `McpBuiltinSyncCommand` after `McpServerRemoveCommand` (fields: type literal `mcp.builtin-sync`, commandId, serverId, builtinId, builtinHash, name, description NullOr, config McpServerConfig, shippedVars Array(McpServerVar), timeoutMs NullOr Int). Add it to the command Union. Imports: `McpServerConfig`,`McpServerVar` (TrimmedNonEmptyString likely already imported — grep). **No new event** — decider emits existing `mcp.server-added`/`mcp.server-updated`. (Drop `McpBuiltinSyncInput` from contracts/mcp.ts — not needed; declare inline in orchestration.ts.)
3. **`McpCatalogBuilders.ts`** (K5b): add `buildSyncedBuiltin(input)` (3-way merge: shipped vars REPLACE but keep user's configured VALUE by name; user-origin vars preserved; extraArgs preserved; source "builtin", locked true) + `mergeTemplateVars(serverId, existing, draftVars)` (locked → existing shipped + split user drafts; else all user). Use `Effect`/`splitServerVars` (already imported).
4. **`decider.ts`** (K5c, C-3): add `case "mcp.builtin-sync"` branch (uses `findCatalogServerById` from McpInvariants — ADD to import; emits server-updated if existing else server-added with `buildSyncedBuiltin`). In `mcp.server-update`: reject a `config` patch when `existing.locked` (throw `OrchestrationCommandInvariantError`, already imported); change `command.patch.vars ? splitServerVars(serverId, patch.vars, existing.vars)` → `mergeTemplateVars(serverId, existing, command.patch.vars)`.
5. **`McpCatalogBuilders.buildAddedServer`** (K5a): manual add is always `source: "custom"`; **remove** `isBuiltinServerId` import/use (McpDefaults is deleted).
6. **`McpReactor.ts`** (K7): replace import `MCP_BUILTIN_SERVERS from "./McpDefaults.ts"` with the `McpBuiltins` helpers; **replace `seedBuiltinsIfEmpty`** with `reconcileBuiltins` (add/update by builtinId+builtinHash via `mcp.builtin-sync`; remove dropped builtins via `mcp.server-remove`; skip platforms with no config variant); `start` calls `reconcileBuiltins` instead of `seedBuiltinsIfEmpty`. (`mcp.server-remove` cascades bindings via `ProjectionMcpBinding.removeByServerRow` — confirmed C-6.)
7. **Delete `apps/server/src/ru-fork/mcp/McpDefaults.ts`** + its test if any (`grep -rl McpDefaults apps/server`). Confirm nothing else imports it.

### Phase G — web template editor + warn modal (PART K8, AMEND-2)
- `types.ts`: `McpRegistryServer` += `locked`,`extraArgs`,`builtinId`; `McpVar` += `origin`.
- `adapters.ts`: map locked/extraArgs/builtinId in `catalogServerToRegistry`; `catalogVarToUi` set `origin`. (`catalogMissingVars` already correct — non-perProject required.)
- `useMcp.ts`: `AddServerInput` += `extraArgs`; `addServer`/`updateServer` send `extraArgs`.
- `serverConfigForm.ts`: `describeEditImpact` → structured `EditImpact` (AMEND-2) using project names.
- `McpServerDialog.tsx`: template mode when `server?.locked` (read-only command via a `disabled` prop on `ServerConfigFields`; new `ExtraArgsField`; `VarsEditor` `lockedDeclarations` greys shipped-var name+flags; send vars = user-origin only + extraArgs); warn-on-impact **AlertDialog** (centered, lists affected project names, Отмена/Применить) replacing the G11 banner.
- `VarsEditor.tsx`: `lockedDeclarations` prop. `ServerConfigFields.tsx`: `disabled` prop. New `ExtraArgsField.tsx`.
- Gate: typecheck + lint (web has no test target).

### Phase H — tests + final gates (PART H, C-5)
- New `apps/server/tests/ru-fork/mcp/supervisorDue.test.ts` (H2) — pure due-gate (never-probed not due, 0 interval off).
- New `apps/server/tests/ru-fork/mcp/secretsKeep.test.ts` (H3) — splitServerVars keepSecret + splitBindingVarValues keepNames (fake `ServerSecretStore` layer incl. `pruneByPrefix`).
- `mcpCore.test.ts` (C-5): append `, []` to the 3 `configCacheKey(...)` calls (currently 3-arg — works at runtime but make it correct); add a catalog-level required `missingRequiredVars` case; add `origin:"user"` to the top-level `vars`/literal `McpServerVar`s (server tests aren't typechecked, so optional, but do it).
- Run all three gates; final commit; THEN report to user.

## Phase F — DONE (built-ins migrator, K4–K7). Green: typecheck 10/10, lint 0/0, test:fast (only 4 baseline bin.test.ts).
Deviations logged in Phase F:
6. **`mcp.builtin-sync` placed in `InternalOrchestrationCommand`**, not the client/dispatchable union the plan's "mirror McpServerRemoveCommand" (C-4) implied. Rationale: it's reactor-dispatched only and must not be client-forgeable (a client could otherwise inject a "managed built-in"). `engine.dispatch` accepts the full `OrchestrationCommand` (Dispatchable ∪ Internal), so the reactor still dispatches it fine. Senior correctness win over the plan's literal placement.
7. **`OrchestrationEngine.ts` `commandAggregate` routing** gained `case "mcp.builtin-sync"` under the mcp-catalog arm — NOT enumerated in the plan but mechanically required: its `default` branch reads `command.threadId`, which the new command lacks (caused the only real typecheck error). Routed to `{aggregateKind:"mcp-catalog", aggregateId: MCP_CATALOG_AGGREGATE_ID}`.
8. **`McpReactor` lost `nowIso` + the `effect/DateTime` import** — the old `seedBuiltinsIfEmpty` stamped `createdAt` itself; the migrator lets the decider stamp `occurredAt` (decider's `nowIso`), so the reactor no longer needs a clock. Removed to satisfy no-unused-vars.
9. **`autobindBuiltinsForProject` rekeyed** from `MCP_BUILTIN_SERVERS` membership to catalog rows with `builtinId !== null` (McpDefaults deleted; built-ins are now identified by the persisted `builtinId`).

## Phase G — DONE (web template editor + warn modal, K8/AMEND-2). Green: typecheck 10/10, lint 0/0, test:fast (4 baseline).
Deviations logged in Phase G:
10. **`mergeTemplateVars` corrected (server, McpCatalogBuilders)** — the plan's version (`[...existingShipped, ...splitUserDrafts]` + dialog "sends user vars only") silently DROPS edits to a shipped var's VALUE, so a future template shipping a required/secret var the user must fill at the catalog level could never be saved. Rewrote it so the shipped DECLARATION SET (names + secret/perProject/required flags) stays immutable (re-stamped from `existing`) while shipped VALUES are settable from the draft, and the template dialog now sends ALL var rows (shipped + user). With today's built-ins (filesystem/context7, zero vars) behavior is identical; this only matters for future templates with shipped vars. The "user vars only" instruction in K8b/K8c is superseded by "send all rows; the decider re-locks shipped declarations."
11. **`describeEditImpact` / G11 banner did not pre-exist** (Phases A–E built statuses/checking/edit-lock, not a G11 impact banner). So AMEND-2 was implemented as a NET-NEW `describeEditImpact`+`EditImpact` in serverConfigForm.ts and a NET-NEW `AlertDialog` in McpServerDialog.tsx (nothing to "replace").
12. **`AddServerInput` gained required `extraArgs` + optional `locked`** (useMcp.ts). `addServer` always sends `extraArgs`; `updateServer` omits `config` when `locked` (decider would reject it) and sends `extraArgs`. Only caller is McpServerDialog (grepped).
13. **`ExtraArgsField.tsx`** new component; shown for stdio only (http has no args). `ServerConfigFields` + `VarsEditor` gained `disabled`/`lockedDeclarations` props; template mode hides the JSON tab and renders the form directly.
14. **Web validated via typecheck+lint only** (no web test target, per project rule).

## Phase H — DONE (tests + final gates). Green: typecheck 10/10, lint 0/0, test:fast (4 baseline).
Deviations logged in Phase H:
15. **No new `supervisorDue.test.ts`** — the plan's H2 (never-probed not due; 0-interval off) is ALREADY fully covered by the existing `supervisorDecisions.test.ts` (the `isProbeDue`/`isSweepDue` blocks). Creating a second file would duplicate. Skipped to stay DRY.
16. **Added `builtins.test.ts` (NOT in the plan)** — Phase F shipped the whole built-ins migrator with zero tests; added coverage for `builtinConfigForPlatform`/`builtinHash`/`builtinShippedVars`/`buildSyncedBuiltin` (3-way merge) + `mergeTemplateVars` (locked declaration-immutability + value-settable + the deviation-10 correction). 9 tests.
17. **`secretsKeep.test.ts` (H3)** uses a Map-backed fake `ServerSecretStore` `Layer.succeed`; the "fresh secret" assertion checks the ref is `mcp-var-`-prefixed + the plaintext lands under it (the ref name is base64-encoded, not literal `srv-x-TOKEN`). 5 tests.
18. **`mcpCore.test.ts` (C-5)** — added the 4th `extraArgs` arg to the 3 `configCacheKey` calls + a new "extraArgs differ" case; `origin` on every `McpServerVar` literal; a catalog-level (`perProject:false`) required `missingRequiredVars` case (K2b widening).

## Deviations already logged (keep logging new ones)
1. varValues-prune (D4) moved B→C (needs keepVarValues).
2. `McpServerVar.origin` (K1a) pulled into C (splitServerVars needs it).
3. `Effect.zipRight` absent in beta.59 → gen block.
4. Test-literal `origin`/4-arg configCacheKey deferred to H (server tests not typechecked; runtime-safe).
5. Phase E kept McpDefaults seed + isBuiltinServerId transitionally; the no-fork `applyServerUpdate` (source unchanged) already landed in E; the rest of no-fork (buildAddedServer custom, delete McpDefaults) is Phase F.

## Gotchas (verified against the codebase)
- `Schema.withDecodingDefault(Effect.succeed(x))` — takes an **Effect**, not a thunk; `Effect` is imported in `contracts/mcp.ts`.
- `Effect.catch(handler)` must RETURN an Effect (`Effect.fail(...)`, not a raw error). No `Effect.zipRight` — use a gen block.
- SQLite booleans: store `? 1 : 0`, decode via `NonNegativeInt` in the row schema + a `rowToX` converter (see `ProjectionMcpBinding.rowToBinding` / `ProjectionMcpCatalog.rowToServer`).
- Non-throwing read-model finder = `findCatalogServerById` (in `apps/server/src/ru-fork/mcp/McpInvariants.ts`).
- Server `tests/` are NOT in `tsconfig` include → not typechecked by `pnpm typecheck` (only run by vitest, which strips types). So a missing field that no code reads won't fail.
- `pnpm lint` native binding can be flaky in sandbox — retry once.
- Single migration `031` — edit in place, never add `032`.
- Only `Effect.logError`/`Effect.logDebug`. No `as`/`any` casts (`as const` on a literal is fine). Mark ru-fork deltas with `ru-fork:`.
