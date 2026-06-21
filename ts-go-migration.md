# Migration plan — drop `@effect/language-service`, adopt `@effect/tsgo`

> Goal: match t3code's typecheck toolchain — replace `tsc --noEmit` + the
> `@effect/language-service` TS plugin with **`@effect/tsgo`** (the Go TypeScript
> compiler, `typescript-go`, with Effect's diagnostics built in). Mirrors t3 commit
> **`6b3050ee7` "Migrate TypeScript checks to Effect TSGo (#2851)"**.
>
> This is **separate from and on top of** the effect `beta.78` bump (see
> `effect-bump.md`). The effect bump is functionally complete; this plan is the
> tooling swap that the LSP 0.84.2→0.86.2 question exposed.

---

## 0. The one thing you must understand first

`@effect/tsgo` **does not avoid** the `deterministicKeys` problem — it **enforces it**.
tsgo is `typescript-go` with the same `@effect/language-service` diagnostics compiled in,
and it reads the **same** `tsconfig` plugin config. t3's current `tsconfig.base.json`
still has `deterministicKeys: "error"` (plus a *larger* diagnostic set than ours). That
is exactly why t3's migration commit also rewrote every service key.

So "migrate to tsgo" = **toolchain swap (§1) + fix all 97 service keys (§3) + resolve
whatever the fuller diagnostic set and tsgo's stricter base-checker surface (§4, the real
unknown)**. Honest scope: **~100–200 files**, mostly mechanical.

**Prerequisite:** verify `@effect/tsgo` runs on this host (Go binary; linux/arm64). This
is the first gate in §5 — if tsgo can't run here, the whole migration is blocked and we
stay on `tsc` + language-service `0.84.2`.

---

## 1. Toolchain swap (deterministic — exact before/after)

### 1.1 `pnpm-workspace.yaml` catalog
BEFORE:
```yaml
  "@effect/language-service": 0.84.2
```
AFTER:
```yaml
  "@effect/tsgo": 0.13.2
```

### 1.2 Root `package.json`
BEFORE:
```json
    "@effect/language-service": "catalog:",
```
AFTER:
```json
    "@effect/tsgo": "catalog:",
```
and the `prepare` script — BEFORE:
```json
    "prepare": "effect-language-service patch",
```
AFTER:
```json
    "prepare": "effect-tsgo patch",
```
(`@effect/tsgo` exposes the `effect-tsgo` bin; `effect-tsgo patch` installs/links the
`tsgo` binary used by the typecheck scripts — verify it provides `tsgo` on the PATH after
install; t3's scripts call `tsgo --noEmit`.)

### 1.3 The 14 package `typecheck` scripts
In **each** of these `package.json`, change `"typecheck": "tsc --noEmit"` →
`"typecheck": "tsgo --noEmit"`:
```
apps/server/package.json
apps/web/package.json
packages/contracts/package.json
packages/shared/package.json
packages/client-runtime/package.json
packages/effect-acp/package.json
packages/branding/package.json
packages/mcp-core/package.json
oxlint-plugin-t3code/package.json
scripts/package.json
pixso-move/contracts/package.json
pixso-move/processor/package.json
pixso-move/server/package.json
pixso-move/plugin/package.json
```
BEFORE (each): `"typecheck": "tsc --noEmit"`  AFTER: `"typecheck": "tsgo --noEmit"`
> Verify each is literally `tsc --noEmit` (a few may pass extra flags / a `-p`; preserve
> those, only swap the binary).

### 1.4 `tsconfig.base.json` + `apps/web/tsconfig.json` — plugin diagnostic set
Keep the plugin `name: "@effect/language-service"` (tsgo reads it). Replace our current
`diagnosticSeverity` block with **t3's full block** so we match their enforcement:
```jsonc
"plugins": [
  {
    "name": "@effect/language-service",
    "namespaceImportPackages": ["@effect/platform-node", "effect"],
    "diagnosticSeverity": {
      "importFromBarrel": "error",
      "anyUnknownInErrorContext": "error",
      "unsafeEffectTypeAssertion": "error",
      "instanceOfSchema": "error",
      "deterministicKeys": "error",
      "strictEffectProvide": "off",
      "missingEffectServiceDependency": "error",
      "leakingRequirements": "error",
      "globalErrorInEffectCatch": "error",
      "globalErrorInEffectFailure": "error",
      "unknownInEffectCatch": "error",
      "strictBooleanExpressions": "off",
      "lazyEffect": "off",
      "preferSchemaOverJson": "error",
      "schemaSyncInEffect": "error"
      // ...transcribe t3's full block verbatim from t3code/tsconfig.base.json (lines ~25-45)
    }
  }
]
```
> ⚠️ Each rule we don't currently enforce (`importFromBarrel`, `missingEffectServiceDependency`,
> `leakingRequirements`, `anyUnknownInErrorContext`, `unsafeEffectTypeAssertion`,
> `instanceOfSchema`, `globalErrorInEffectCatch/Failure`, `unknownInEffectCatch`,
> `preferSchemaOverJson`, `schemaSyncInEffect`) can surface **new** violations across the
> fork. Count is unknown until the §5 Phase-1 dry-run. **If we want a minimal first step,
> enable only `deterministicKeys` now and stage the rest** — but that diverges from t3.

### 1.5 Install
`pnpm install --config.confirmModulesPurge=false` (native-binding flag, per repo memory).
Confirm the effect `beta.78` patch still applies (unchanged by this migration) and that
`effect-tsgo patch` runs in `prepare`.

---

## 2. Why the keys must change (one sentence)
`deterministicKeys` requires every `Context.Service`/`Context.Tag`/`Context.Reference`/
`Effect.Service` identity key to equal `"<packageName>/<path-from-src>/<ClassName>"`. Our
keys use the legacy `t3/*`, `ru-fork/*`, `pixso-move/*` prefixes, so all 97 fail.

These keys are **in-memory Context identity strings**, not Schema `_tag` discriminators —
renaming is runtime-safe **provided** they aren't persisted/sent on the wire (verify in §5).

---

## 3. The 97 `deterministicKeys` fixes (before → after)

Mechanical rule per site: **replace the key string literal with the diagnostic's
"expected key".** Authoritative regeneration command:
```
pnpm exec turbo run typecheck --continue 2>&1 | grep 'expected key is'
```

### 3.1 `packages/effect-acp` (pkg `effect-acp`) — 2
| File:Line | before | after |
|---|---|---|
| `src/agent.ts:210` | `"effect-acp/AcpAgent"` | `"effect-acp/agent/AcpAgent"` |
| `src/client.ts:266` | `"effect-acp/AcpClient"` | `"effect-acp/client/AcpClient"` |

### 3.2 `pixso-move/processor` (pkg `@pixso-move/processor`) — 2
| File:Line | before | after |
|---|---|---|
| `src/acp/runner.ts:9` | `"pixso-move/AcpRunner"` | `"@pixso-move/processor/acp/runner/AcpRunner"` |
| `src/processor.ts:15` | `"pixso-move/Processor"` | `"@pixso-move/processor/processor"` |

### 3.3 `pixso-move/server` (pkg `@pixso-move/server`) — 3 (+ vendor dup)
| File:Line | before | after |
|---|---|---|
| `src/config.ts:38` | `"pixso-move/ServerConfig"` | `"@pixso-move/server/config/ServerConfig"` |
| `src/services/nodeStore.ts:32` | `"pixso-move/NodeStore"` | `"@pixso-move/server/services/nodeStore"` |
| `src/services/resultStore.ts:33` | `"pixso-move/ResultStore"` | `"@pixso-move/server/services/resultStore"` |
> `pixso-move/server/src/vendor/NodeSqliteClient.ts:39` carries `"t3/persistence/NodeSqliteClient"`
> (vendored copy) — only fix if the diagnostic flags it for this package.

### 3.4 `apps/server` (pkg `@ru-code/ru-code`) — 90
All become `"@ru-code/ru-code/<path>/<Class>"`. Captured `before` shown where known;
where blank the current literal is at that file:line (replace in place with the `after`).

**auth/ (6)**
| File:Line | before | after |
|---|---|---|
| `auth/Services/AuthControlPlane.ts:72` | `"t3/AuthControlPlane"` | `"@ru-code/ru-code/auth/Services/AuthControlPlane"` |
| `auth/Services/BootstrapCredentialService.ts:61` | _(current literal)_ | `"@ru-code/ru-code/auth/Services/BootstrapCredentialService"` |
| `auth/Services/ServerAuthPolicy.ts:10` | `"t3/auth/Services/ServerAuthPolicy"` | `"@ru-code/ru-code/auth/Services/ServerAuthPolicy"` |
| `auth/Services/ServerAuth.ts:95` | `"t3/auth/Services/ServerAuth"` | `"@ru-code/ru-code/auth/Services/ServerAuth"` |
| `auth/Services/ServerSecretStore.ts:32` | `"t3/auth/Services/ServerSecretStore"` | `"@ru-code/ru-code/auth/Services/ServerSecretStore"` |
| `auth/Services/SessionCredentialService.ts:91` | _(current literal)_ | `"@ru-code/ru-code/auth/Services/SessionCredentialService"` |

**checkpointing/ (2)**
| `checkpointing/Services/CheckpointDiffQuery.ts:49` | _(literal)_ | `"@ru-code/ru-code/checkpointing/Services/CheckpointDiffQuery"` |
| `checkpointing/Services/CheckpointStore.ts:100` | `"t3/checkpointing/Services/CheckpointStore"` | `"@ru-code/ru-code/checkpointing/Services/CheckpointStore"` |

**top-level / config (6)**
| `config.ts:286` | `"t3/config/ServerConfig"` | `"@ru-code/ru-code/config/ServerConfig"` |
| `environment/Services/ServerEnvironment.ts:11` | `"t3/environment/Services/ServerEnvironment"` | `"@ru-code/ru-code/environment/Services/ServerEnvironment"` |
| `keybindings.ts:290` | `"t3/keybindings"` | `"@ru-code/ru-code/keybindings"` |
| `open.ts:151` | `"t3/open"` | `"@ru-code/ru-code/open"` |
| `processRunner.ts:97` | `"t3/processRunner"` | `"@ru-code/ru-code/processRunner"` |
| `shutdownSignal.ts:10` | `"t3/shutdownSignal"` | `"@ru-code/ru-code/shutdownSignal"` |

**git/ (2)**
| `git/GitManager.ts:91` | `"t3/git/GitManager"` | `"@ru-code/ru-code/git/GitManager"` |
| `git/GitWorkflowService.ts:80` | _(literal)_ | `"@ru-code/ru-code/git/GitWorkflowService"` |

**orchestration/Services/ (9)** → `"@ru-code/ru-code/orchestration/Services/<…>"`
| File:Line | after (suffix after the common prefix) |
|---|---|
| `CheckpointReactor.ts:39` | `CheckpointReactor` |
| `OrchestrationEngine.ts:70` | `OrchestrationEngine/OrchestrationEngineService` |
| `OrchestrationReactor.ts:32` | `OrchestrationReactor` |
| `ProjectionPipeline.ts:42` | `ProjectionPipeline/OrchestrationProjectionPipeline` |
| `ProjectionSnapshotQuery.ts:149` | `ProjectionSnapshotQuery` |
| `ProviderCommandReactor.ts:41` | `ProviderCommandReactor` |
| `ProviderRuntimeIngestion.ts:41` | `ProviderRuntimeIngestion/ProviderRuntimeIngestionService` |
| `RuntimeReceiptBus.ts:65` | `RuntimeReceiptBus` |
| `ThreadDeletionReactor.ts:38` | `ThreadDeletionReactor` |

**persistence/Services/ (18)** → `"@ru-code/ru-code/persistence/Services/<…>"`
| File:Line | after (suffix) |
|---|---|
| `AuthPairingLinks.ts:78` | `AuthPairingLinks/AuthPairingLinkRepository` |
| `AuthSessions.ts:95` | `AuthSessions/AuthSessionRepository` |
| `McpBinding.ts:36` | `McpBinding/McpBindingRepository` |
| `McpCatalog.ts:26` | `McpCatalog/McpCatalogRepository` |
| `McpProbeCache.ts:33` | `McpProbeCache/McpProbeCacheRepository` |
| `OrchestrationCommandReceipts.ts:72` | `OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository` |
| `OrchestrationEventStore.ts:71` | `OrchestrationEventStore` |
| `ProjectionCheckpoints.ts:95` | `ProjectionCheckpoints/ProjectionCheckpointRepository` |
| `ProjectionPendingApprovals.ts:93` | `ProjectionPendingApprovals/ProjectionPendingApprovalRepository` |
| `ProjectionProjects.ts:81` | `ProjectionProjects/ProjectionProjectRepository` |
| `ProjectionState.ts:66` | `ProjectionState/ProjectionStateRepository` |
| `ProjectionThreadActivities.ts:84` | `ProjectionThreadActivities/ProjectionThreadActivityRepository` |
| `ProjectionThreadMessages.ts:95` | `ProjectionThreadMessages/ProjectionThreadMessageRepository` |
| `ProjectionThreadProposedPlans.ts:54` | `ProjectionThreadProposedPlans/ProjectionThreadProposedPlanRepository` |
| `ProjectionThreadSessions.ts:78` | `ProjectionThreadSessions/ProjectionThreadSessionRepository` |
| `ProjectionThreads.ts:106` | `ProjectionThreads/ProjectionThreadRepository` |
| `ProjectionTurns.ts:170` | `ProjectionTurns/ProjectionTurnRepository` |
| `ProviderSessionRuntime.ts:92` | `ProviderSessionRuntime/ProviderSessionRuntimeRepository` |

**project/Services/ (3)** → `"@ru-code/ru-code/project/Services/<Class>"`
`ProjectFaviconResolver.ts:30`, `ProjectSetupScriptRunner.ts:44`, `RepositoryIdentityResolver.ts:12`

**provider/ (10)** → `"@ru-code/ru-code/provider/<…>"`
| `provider/acp/AcpSessionRuntime.ts:156` | `"t3/provider/acp/AcpSessionRuntime"` | `…/provider/acp/AcpSessionRuntime` |
| `provider/Layers/ProviderEventLoggers.ts:53` | _(literal)_ | `…/provider/Layers/ProviderEventLoggers` |
| `provider/providerMaintenanceRunner.ts:61` | _(literal)_ | `…/provider/providerMaintenanceRunner` |
| `provider/Services/ProviderAdapterRegistry.ts:100` | _(literal)_ | `…/provider/Services/ProviderAdapterRegistry` |
| `provider/Services/ProviderInstanceRegistryMutator.ts:52` | _(literal)_ | `…/provider/Services/ProviderInstanceRegistryMutator` |
| `provider/Services/ProviderInstanceRegistry.ts:87` | _(literal)_ | `…/provider/Services/ProviderInstanceRegistry` |
| `provider/Services/ProviderRegistry.ts:80` | `"t3/provider/Services/ProviderRegistry"` | `…/provider/Services/ProviderRegistry` |
| `provider/Services/ProviderService.ts:139` | `"t3/provider/Services/ProviderService"` | `…/provider/Services/ProviderService` |
| `provider/Services/ProviderSessionDirectory.ts:70` | _(literal)_ | `…/provider/Services/ProviderSessionDirectory` |
| `provider/Services/ProviderSessionReaper.ts:15` | _(literal)_ | `…/provider/Services/ProviderSessionReaper` |

**ru-fork/ (8)** → `"@ru-code/ru-code/ru-fork/<…>"`
| `ru-fork/mcp/McpOverlay.ts:85` | `"ru-fork/mcp/McpOverlay"` | `…/ru-fork/mcp/McpOverlay` |
| `ru-fork/mcp/McpProjectionQuery.ts:32` | _(literal)_ | `…/ru-fork/mcp/McpProjectionQuery` |
| `ru-fork/mcp/McpReactor.ts:73` | `"ru-fork/mcp/McpReactor"` | `…/ru-fork/mcp/McpReactor` |
| `ru-fork/mcp/McpRuntime.ts:32` | `"ru-fork/mcp/McpRuntime"` | `…/ru-fork/mcp/McpRuntime` |
| `ru-fork/mcp/McpSupervisor.ts:215` | `"ru-fork/mcp/McpSupervisor"` | `…/ru-fork/mcp/McpSupervisor` |
| `ru-fork/qwen-transcript/QwenTranscriptService.ts:23` | _(literal)_ | `…/ru-fork/qwen-transcript/QwenTranscriptService` |
| `ru-fork/skills/SkillScannerService.ts:41` | `"ru-fork/SkillScanner"` | `…/ru-fork/skills/SkillScannerService/SkillScanner` |
| `ru-fork/subagents/SubagentScannerService.ts:42` | `"ru-fork/SubagentScanner"` | `…/ru-fork/subagents/SubagentScannerService/SubagentScanner` |

**server top-level (3)**
| `serverLifecycleEvents.ts:27` | _(literal)_ | `"@ru-code/ru-code/serverLifecycleEvents"` |
| `serverRuntimeStartup.ts:62` | _(literal)_ | `"@ru-code/ru-code/serverRuntimeStartup"` |
| `serverSettings.ts:133` | _(literal)_ | `"@ru-code/ru-code/serverSettings/ServerSettingsService"` |

**sourceControl/ (5)** → `"@ru-code/ru-code/sourceControl/<…>"`
`GitHubCli.ts:95` (before `"t3/source-control/GitHubCli"`), `SourceControlDiscovery.ts:314`,
`SourceControlProviderRegistry.ts:47`, `SourceControlProvider.ts:102`,
`SourceControlRepositoryService.ts:43`

**terminal/ (2)**
| `terminal/Services/Manager.ts:135` | `"t3/terminal/Services/Manager/TerminalManager"` | `"@ru-code/ru-code/terminal/Services/Manager/TerminalManager"` |
| `terminal/Services/PTY.ts:59` | `"t3/terminal/Services/PTY/PtyAdapter"` | `"@ru-code/ru-code/terminal/Services/PTY/PtyAdapter"` |

**textGeneration/ (1)**
| `textGeneration/TextGeneration.ts:120` | `"t3/text-generation/TextGeneration"` | `"@ru-code/ru-code/textGeneration/TextGeneration"` |

**vcs/ (8)** → `"@ru-code/ru-code/vcs/<Class>"`
`GitVcsDriver.ts:221`, `VcsDriverRegistry.ts:37`, `VcsDriver.ts:32`, `VcsProcess.ts:70`,
`VcsProjectConfig.ts:41`, `VcsProvisioningService.ts:20`, `VcsStatusBroadcaster.ts:68`
(befores are the `"t3/vcs/*"` literals)

**workspace/Services/ (3)** → `"@ru-code/ru-code/workspace/Services/<Class>"`
`WorkspaceEntries.ts:71` (before `"t3/workspace/Services/WorkspaceEntries"`),
`WorkspaceFileSystem.ts:51`, `WorkspacePaths.ts:102`

> Total: 2 + 2 + 3 + 90 = **97**. The exact `after` for every site is the diagnostic's
> "expected key" — the table above is transcribed from it; regenerate with the §3 command
> to confirm before editing.

---

## 4. The real unknowns — "what else might we miss" (must dry-run)

`deterministicKeys` is the only diagnostic we can fully enumerate today (because LSP 0.86.2
is currently installed). The following are **knowable only after** installing tsgo and
running it once with t3's full config (§5 Phase 1). t3's own commit `6b3050ee7` touched
**~60+ non-`Services` files** for these reasons:

1. **Fuller diagnostic set (§1.4)** — `importFromBarrel`, `missingEffectServiceDependency`,
   `leakingRequirements`, `anyUnknownInErrorContext`, `unsafeEffectTypeAssertion`,
   `instanceOfSchema`, `globalErrorInEffectCatch/Failure`, `unknownInEffectCatch`,
   `preferSchemaOverJson`, `schemaSyncInEffect`. Each can flag fork code. **Count: unknown.**
2. **tsgo base strictness** — `typescript-go` is more spec-compliant than `tsc`; expect a
   batch of genuine type errors `tsc` silently allowed. **Count: unknown.**
3. **Test files** — same diagnostics apply to `*.test.ts` / `*.integration.ts`.

➡️ The plan therefore **cannot** promise a fixed file count up front. Phase 1 produces the
exact, complete error inventory; the migration is "drive that inventory to zero."

---

## 5. Execution phases & validation gates

- **Phase 0 — feasibility:** add `@effect/tsgo` to catalog/root only, `pnpm install`,
  run `pnpm exec tsgo --version` (or `effect-tsgo --version`). **If tsgo won't run on
  linux/arm64 here → STOP, abandon migration, keep `tsc` + language-service `0.84.2`.**
- **Phase 1 — discovery:** apply §1 fully (scripts + tsconfig), `pnpm install`, run
  `pnpm exec turbo run typecheck --continue 2>&1 | tee /tmp/tsgo-errors.txt`. This is the
  **complete** error inventory (deterministicKeys + §4 unknowns + strictness).
- **Phase 2 — keys:** apply §3 (97 key rewrites).
- **Phase 3 — remainder:** drive the §4 errors to zero (group by diagnostic; many are
  mechanical, e.g. `importFromBarrel` = change a barrel import to a deep import).
- **Phase 4 — gates:** `pnpm typecheck` (now tsgo) green; `pnpm lint` green;
  `pnpm test:fast` green (minus the known-env failures: mcp-probe w/o qwen, `bin.test.ts`).

---

## 6. Risks / things to verify before committing

1. **tsgo runnability** on linux/arm64 (Phase 0) — hard gate.
2. **Service-identity rename `t3/*`/`ru-fork/*`/`pixso-move/*` → deterministic** — these
   are in-memory Context (DI) identity strings, **not** persisted/wire data, so renaming
   does **not** break user data on upgrade. **VERIFIED** (2026-06-21): each old key
   literal appears *only* at its own `Context.Service(...)` declaration — nowhere in DB
   columns, migrations, RPC tags, the MCP overlay file, or any payload. (Re-run the grep
   before committing if code changed.) Note: MCP now ships and has backcompat obligations,
   but those apply to **Schema `_tag`s and persisted encodings — not these DI keys.** See
   [[mcp-not-shipped-no-backcompat]].
3. **`effect-tsgo patch` prepare hook** — confirm it provides the `tsgo` binary the
   scripts call, and that it composes with our existing patches (effect `beta.78` patch).
4. **oxlint** — our `lint` is oxlint (independent of TS plugin); confirm it doesn't import
   anything from `@effect/language-service`. The custom `oxlint-plugin-t3code` typecheck
   also moves to tsgo.
5. **IDE** — anyone relying on the `@effect/language-service` editor plugin keeps it as a
   *devDependency for the editor* even though CI uses tsgo (t3 keeps the plugin name in
   tsconfig precisely so both work). Decide whether to keep `@effect/language-service` as a
   dev-only dep for in-editor diagnostics, or rely solely on tsgo.
6. **Decouplable fallback:** if Phase 3 balloons, ship the effect `beta.78` bump on
   `tsc` + language-service `0.84.2` first (fully green today) and land tsgo separately.

---

## 7. Summary answer to "are we missing anything?"

- **Fully known now:** the toolchain swap (§1) and the **97** key fixes (§3).
- **Genuinely unknown until a tsgo dry-run:** how many *additional* violations the fuller
  diagnostic set (§1.4) and tsgo's stricter base checker (§4) produce — t3 needed ~60+
  extra files for these. We are **not** missing a category; we are missing a *count*, and
  Phase 1 supplies it.
- **Biggest hidden risk:** tsgo failing to run on this host (Phase 0), and the
  service-key identity rename touching anything persisted/wire (Risk 2). Both are checked
  before any large edit.
