# tsgo strict-rule fixes — decision plan

State: clean install + `diagnosticSeverity` matched to t3 **100%** (base + `apps/web`).
Inventory (mcp-probe excluded): **47 errors + 73 suggestions**.

t3 sources used for proven before/after:
- `e6330ead8` — crypto→service (compat APIs)
- `6b3050ee7` — crypto→service (tsgo migration)
- `25b02f4ba` — Date.now→Clock, setTimeout→timers, console→log, fetch→HttpClient, catch+succeed→orElseSucceed

Decision buckets (every one of the 47 + 73 is in exactly one):

| Bucket | Count | Action |
|---|---|---|
| §1 DO NOW — t3-proven | 21 | apply t3's before/after |
| §2 DO NOW — fork crypto, mechanical | 7 | apply Part-A pattern (no t3 file, but identical fix) |
| §3 CONFIG-SUPPRESS (like web) | 11 | tsconfig `global*`/`nodeBuiltinImport` off — they stop showing |
| §4 LEAVE FOR LATER | 8 | daemonLauncher (6) + 2 scanner leaks |
| §5 LEAVE FOR LATER — core/types | 2 | `generate.ts`, `main.tsx` |
| §6 Suggestions | 73 | optional; t3 keeps at "suggestion", not error |

21 + 7 + 11 + 8 + 2 = **47 errors.** Doing §1+§2 = **28 fixed**, §3 removes **11** from view,
§4+§5 (**10**) deferred.

---

## §1 — DO NOW: errors with a proven t3 before/after (21)

### Crypto → Crypto service, SHARED files (t3 fixed the exact file)
Pattern (verbatim t3, `6b3050ee7`): acquire once, bind a local, yield at each site:
```ts
// AFTER
const crypto = yield* Crypto.Crypto;
const randomUUID = crypto.randomUUIDv4;          // ws.ts: .pipe(Effect.orDie)
const serverCommandId = (tag: string) =>
  randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
// site:  EventId.make(crypto.randomUUID())  →  EventId.make(yield* randomUUID)
```

| Our file:line(s) | t3 commit | t3 after-shape |
|---|---|---|
| `apps/server/src/cli/project.ts:346,349,387,427` | `e6330ead8` | `projectCommandUuid` module helper (domain error) |
| `apps/server/src/orchestration/decider.ts:51` | `e6330ead8` | `withEventBase` pure-fn → `Effect` (`Crypto.Crypto.pipe(flatMap(c=>c.randomUUIDv4))`) |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:90,277` | `e6330ead8` | in-`make` `serverCommandId`/`serverEventId` |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:45,1173` | `e6330ead8` | in-`make` `providerCommandId` |
| `apps/server/src/orchestration/Layers/CheckpointReactor.ts:73,95,120,317` | `6b3050ee7` | `const randomUUID = crypto.randomUUIDv4` |
| `apps/server/src/serverRuntimeStartup.ts:163,168,185,188` | `6b3050ee7` | same |
| `apps/server/src/ws.ts:244,265` | `6b3050ee7` | `const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie)` |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts:193` | later t3 | same service pattern |

⚠️ Cascade: each `crypto.randomUUIDv4` adds `Crypto`+`PlatformError` to its `Effect`;
discharge `Crypto` at the layer root (already provided by `NodeServices.layer`); use
`Effect.orDie` to keep `never` where a fixed signature requires it.

### deterministicKeys — SHARED (renamer missed it)
| File:line | before | after | source |
|---|---|---|---|
| `packages/effect-acp/src/agent.ts:210` | `…()("effect-acp/AcpAgent")` | `…()("effect-acp/agent/AcpAgent")` | t3 `6b3050ee7` key scheme |

---

## §2 — DO NOW: fork crypto, mechanical (7) — pattern known, NO t3 file
Identical to §1 (acquire `Crypto.Crypto`, `yield* crypto.randomUUIDv4`); validated by the
shared-file fixes, just no t3 verbatim for these exact files.

| File:line | rule | enclosing | risk |
|---|---|---|---|
| `apps/server/src/auth/Layers/BootstrapCredentialService.ts:144` | cryptoRandomUUIDInEffect | `make` gen | low |
| `apps/server/src/auth/Layers/SessionCredentialService.ts:206` | cryptoRandomUUIDInEffect | `make` gen | low |
| `apps/server/src/ru-fork/mcp/McpReactor.ts:63` | cryptoRandomUUID | `make` gen | low |
| `apps/server/src/ru-fork/turnCompletedCheckpointDispatch.ts:82` | cryptoRandomUUIDInEffect | **check fn sig** | med (may cascade) |
| `pixso-move/server/src/services/nodeStoreLive.ts:35` | cryptoRandomUUIDInEffect | `make` gen | low |
| `pixso-move/server/src/services/resultStoreLive.ts:47` | cryptoRandomUUIDInEffect | `make` gen | low |
| `apps/server/tests/persistence.test.ts:10` | cryptoRandomUUID | test | low (service+`NodeServices.layer`, or `Effect.sync(()=>globalThis.crypto.randomUUID())`) |

---

## §3 — CONFIG-SUPPRESS like web (11) — turn the rule off, no code change
These are browser-ish UI / build-config files where globals/node-imports are legitimate
(same rationale t3 uses for `apps/web`). Add per-package `diagnosticSeverity` overrides.

**pixso-move/plugin** (`src/ui/*` is a browser plugin UI) — add `global*: "off"`:
| File:line | rule |
|---|---|
| `src/ui/components/settings/settingsLayout.tsx:11,13` | globalDate ×2, globalTimers ×1 |
| `src/ui/key.ts:12` | globalRandom |

**Build/config files** — `path` import is normal in vite configs; suppress `nodeBuiltinImport`
(per-file `// @effect-diagnostics nodeBuiltinImport:off` or tsconfig override):
| File:line | rule |
|---|---|
| `apps/web/vite-branding-plugin.ts:1` | nodeBuiltinImport |
| `pixso-move/plugin/vite.ui.config.ts:1` | nodeBuiltinImport |

**pixso-move/server tests** — test code using global `fetch`; suppress `globalFetch` for tests:
| File:line | rule |
|---|---|
| `pixso-move/server/tests/server.test.ts:22,31` | globalFetchInEffect |
| `pixso-move/server/tests/server.test.ts:25` | preferSchemaOverJson (quick: `Schema.fromJsonString`, or suppress) |

> Net: these 11 vanish from the report via config, exactly like the 134 web globals did.

---

## §4 — LEAVE FOR LATER: fork code, real work (8)

**daemonLauncher (fork, no t3 file) — 6:** the daemon health-poll loop.
| File:line | rule | why deferred |
|---|---|---|
| `apps/server/src/daemonLauncher.ts:66,217,364` | globalTimersInEffect | `setTimeout`→`Effect.sleep`/`NodeTimers` — touches poll timing |
| `apps/server/src/daemonLauncher.ts:68,219,366` | globalFetchInEffect | `fetch`→`HttpClient` — **real rewire** of the health probe |

**Service requirement leaks (fork, no t3 file) — 2:** design choice.
| File:line | error | why deferred |
|---|---|---|
| `apps/server/src/ru-fork/skills/SkillScannerService.ts:40` | TS377041 leakingRequirements | methods leak `FileSystem\|Path`; provide-in-`make` redesign |
| `apps/server/src/ru-fork/subagents/SubagentScannerService.ts:41` | TS377041 | same |

---

## §5 — LEAVE FOR LATER: core/type errors (2)
| File:line | error | note |
|---|---|---|
| `scripts/generate.ts:52` | TS2339 `ImportMeta.dirname` | tsgo-stricter; `import.meta.dirname` types or `fileURLToPath(import.meta.url)` |
| `pixso-move/plugin/src/ui/main.tsx:6` | TS2882 `./index.css` side-effect import | css ambient decl in pixso tsconfig |

---

## §6 — Suggestions (73, do NOT fail build) — optional
t3 keeps these at "suggestion", not "error":
- `catchToOrElseSucceed` ×63 → `Effect.catch(()=>Effect.succeed(x))` → `Effect.orElseSucceed(()=>x)` (t3 `25b02f4ba`)
- `unnecessaryTypeofType` ×8, `multipleCatchTag` ×2 — cosmetic.

---

## Order of operations
1. §1 (21) + §2 (7) → **28 errors fixed**, all crypto on the proven pattern. Re-run `pnpm typecheck:tsgo`.
2. §3 (11) → config overrides → **11 disappear**.
3. After 1+2+3, remaining errors = **§4 (8) + §5 (2) = 10**, all explicitly deferred.
4. §6 suggestions: optional cleanup, any time.
