# Effect bump plan — `4.0.0-beta.59` → `4.0.0-beta.78`

> Target: move our fork from Effect `4.0.0-beta.59` to the version t3code ships
> (`4.0.0-beta.78`). This file is the **complete, exhaustive** edit list. Only edits
> written here are allowed into the codebase. Every changed line has a before/after.

## 0. How this was validated (ground truth, not guesswork)

- Pinned both versions: ours `effect 4.0.0-beta.59` (`pnpm-workspace.yaml`), t3 `4.0.0-beta.78`.
- Traced t3's bump chain in `t3code`: `beta.45 → 59 → 73 → 78`. The only migration
  commit touching app code is **`e6330ead8` "Bump Effect to beta.73 and migrate
  compatibility APIs"** (starts at our exact version, beta.59). The `73 → 78` step
  rode inside the relay feature commit `5ae77c0d6` (no separate code-migration commit).
- Fetched the **real packages** `effect@4.0.0-beta.78` and `@effect/platform-node@4.0.0-beta.78`
  from npm and diffed the **exported API surface** of every module we import
  (`effect/*`, `effect/unstable/*`, `effect/testing/*`) against our installed
  `beta.59`. Among symbols **we actually use**, exactly two were removed/changed:
  1. `effect/Random.nextUUIDv4` — **removed** (verified absent in beta.78 `Random.d.ts`).
  2. `effect/Schema.Defect` — changed from a schema **value** (`const Defect: Defect`)
     to a **factory function** (`function Defect(options?): Defect`) — must now be **called**.
- Confirmed via t3's *current* source that t3 uses exactly the replacement patterns
  this plan adopts (`Crypto.Crypto` service, `Schema.Defect()`).
- Confirmed no other breakage: we do **not** use any other removed symbol
  (`Effect.fromYieldable`/`Effect.Yieldable`, `Schema.DefectWithStack`/`ErrorWithStack`,
  `Config.Duration`, `RpcClient.RequestHooks`), no bare effect `Schema.Error`,
  no `Schema.transform`/`transformOrFail`. `effect/unstable/*`, `effect/testing/TestClock`,
  `Schema.{Struct,Union,Record,Literals,NullOr,Codec,TaggedErrorClass,Array,…}` all
  still exist and are unchanged in beta.78.

**Net: two source-level breaking changes + the dependency/patch bump. Nothing else.**

### Residual-risk note (read before applying)
The surface diff is exhaustive for **removed / kind-changed** exports (it caught both
breaks). It cannot, by itself, prove that *no function we call kept its name but
changed its parameter list*. That class of change is low-probability for the stable
APIs we use (t3's 59→73 migration touched **only** these same APIs), but the **final
gate is a typecheck after applying** — see §6. If §6's typecheck is green, the plan is
proven complete.

---

## 1. Dependency & config changes

### 1.1 `pnpm-workspace.yaml` — catalog (lines 13–19)

BEFORE:
```yaml
  effect: 4.0.0-beta.59
  "@effect/atom-react": 4.0.0-beta.59
  "@effect/openapi-generator": 4.0.0-beta.59
  "@effect/platform-node": 4.0.0-beta.59
  "@effect/platform-node-shared": 4.0.0-beta.59
  "@effect/language-service": 0.84.2
  "@effect/vitest": 4.0.0-beta.59
```
AFTER:
```yaml
  effect: 4.0.0-beta.78
  "@effect/atom-react": 4.0.0-beta.78
  "@effect/openapi-generator": 4.0.0-beta.78
  "@effect/platform-node": 4.0.0-beta.78
  "@effect/platform-node-shared": 4.0.0-beta.78
  "@effect/language-service": 0.86.2
  "@effect/vitest": 4.0.0-beta.78
```
Notes: all five `@effect/*` `4.0.0-beta.78` versions verified to exist on npm.
`@effect/language-service` declares **no** effect peer-dep; bumping `0.84.2 → 0.86.2`
(latest) keeps the `prepare` step (`effect-language-service patch`) aligned with the
newer effect. This is dev-tooling only and independent of the source migration.

### 1.2 `pnpm-workspace.yaml` — patch comment + `patchedDependencies` (lines 26–31)

BEFORE:
```yaml
# ru-fork: restored (removed in c36945d8). Patches effect's RpcClient to expose
# ConnectionHooks ping/pong/timeout hooks used by the WS transport heartbeat.
# Functionally identical to t3code's patches/effect@4.0.0-beta.78.patch, pinned
# to our beta.59. Recovered from 8fc31793.
patchedDependencies:
  effect@4.0.0-beta.59: patches/effect@4.0.0-beta.59.patch
```
AFTER:
```yaml
# ru-fork: restored (removed in c36945d8). Patches effect's RpcClient to expose
# ConnectionHooks ping/pong/timeout hooks used by the WS transport heartbeat.
# Adopted from t3code's patches/effect@4.0.0-beta.78.patch for the beta.78 bump.
patchedDependencies:
  effect@4.0.0-beta.78: patches/effect@4.0.0-beta.78.patch
```

### 1.3 The patch file itself

Our `patches/effect@4.0.0-beta.59.patch` (RpcClient `ConnectionHooks` + RpcSerialization
hooks) **will not apply to beta.78** — beta.78's `dist` line offsets moved. t3's
`patches/effect@4.0.0-beta.78.patch` contains the **identical ConnectionHooks logic
rebased onto beta.78** (verified: the only diffs vs ours are `@@` offsets, blob hashes,
trailing newline, plus one extra hunk).

Operation:
1. **Delete** `patches/effect@4.0.0-beta.59.patch`.
2. **Add** `patches/effect@4.0.0-beta.78.patch` = a **verbatim copy** of
   `t3code/patches/effect@4.0.0-beta.78.patch`.

**Decision — the extra `McpServer.js` hunk: COPY VERBATIM.** t3's beta.78 patch adds a
`dist/unstable/ai/McpServer.js` DELETE-route hunk (additive MCP HTTP session-teardown
handler) that our beta.59 patch never carried. We take t3's file **as-is, including that
hunk** — it is the tested beta.78 artifact and the extra route is harmless. Do **not**
strip anything.

`pnpm install` must report the patch applied cleanly (verify — see §6).

### 1.4 Root `package.json` — `pnpm.overrides` (lines 46–49)

BEFORE:
```json
      "@effect/atom-react": "4.0.0-beta.59",
      "@effect/platform-node": "4.0.0-beta.59",
      "@effect/platform-node-shared": "4.0.0-beta.59",
      "effect": "4.0.0-beta.59",
```
AFTER:
```json
      "@effect/atom-react": "4.0.0-beta.78",
      "@effect/platform-node": "4.0.0-beta.78",
      "@effect/platform-node-shared": "4.0.0-beta.78",
      "effect": "4.0.0-beta.78",
```

---

## 2. Breaking change #1 — `Random.nextUUIDv4` removed → `Crypto` service

### Background (why each site changes the way it does)
In beta.78 there is no `Random.nextUUIDv4`. UUIDs come from the **`Crypto.Crypto`
service**: `crypto.randomUUIDv4 : Effect<string, PlatformError.PlatformError>` — it
**requires `Crypto.Crypto` in context** and **can fail**. `Crypto.Crypto` is a
`Context.Service` (no default), unlike `Random` (a `Context.Reference` with a default —
which is why bare `Random.nextUUIDv4` works today without provision).

`Crypto.Crypto` is provided by `NodeServices.layer` in beta.78 (it now bundles
`NodeCrypto.layer`). Our server already provides `NodeServices.layer` at the runtime
root (`apps/server/src/bin.ts:23`, `apps/server/src/server.ts:115`), and every server
file below already pulls `FileSystem`/`Path`/`ChildProcessSpawner` from that **same**
layer — so `Crypto` rides the identical wiring. **No layer-composition changes are
needed for production code.** Two non-Effect boundaries (web `utils.ts`, `git.ts`) drop
Effect entirely; one test helper uses Node's global crypto; everything else acquires
the service.

Affected files (9 carrying `Random`): 4 source migrated + **1 source deleted**
(`AcpNativeLogging.ts`, §2.7) + 3 tests + 1 web `utils.ts`; plus the web `ChatView.tsx`
caller (no `Random` of its own). = §2.1–§2.10 below.

> Import placement convention: add `import * as Crypto from "effect/Crypto";`
> **alphabetically** within the `effect/*` import group (i.e. before `effect/Effect`,
> after `effect/Clock`). Remove the `effect/Random` import line in every file.

---

### 2.1 `apps/web/src/lib/utils.ts`  (web — no Effect runtime; mirrors t3)

Imports — BEFORE (lines 1–6):
```ts
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";
import { DraftId } from "../composerDraftStore";
```
Imports — AFTER:
```ts
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import * as Encoding from "effect/Encoding";
import { twMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";
```

Body — BEFORE (lines 24–29):
```ts
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Random.nextUUIDv4);
}
```
Body — AFTER (adds `randomHex`, drops the Effect fallback; `globalThis.crypto` Web Crypto
is universally available in our browser target):
```ts
export function randomHex(byteLength: number): string {
  return Encoding.encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```
(Lines 31–39 `newCommandId`/`newProjectId`/… are unchanged — they call `randomUUID()`.)

---

### 2.2 `apps/web/src/components/ChatView.tsx`  (caller of `git.ts` helper — see §2.3)

Line 110 — BEFORE:
```ts
import { cn, randomUUID } from "~/lib/utils";
```
Line 110 — AFTER:
```ts
import { cn, randomHex, randomUUID } from "~/lib/utils";
```

Line 2773 — BEFORE:
```ts
                      branch: buildTemporaryWorktreeBranchName(),
```
Line 2773 — AFTER:
```ts
                      branch: buildTemporaryWorktreeBranchName(randomHex),
```

---

### 2.3 `packages/shared/src/git.ts`  (sync boundary — inject `randomHex`; mirrors t3)

Imports — BEFORE (lines 9–10):
```ts
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
```
Imports — AFTER: **remove both lines** (neither `Effect` nor `Random` is used anywhere
else in this file — verified).

Body — BEFORE (lines 89–92):
```ts
export function buildTemporaryWorktreeBranchName(): string {
  const token = Effect.runSync(Random.nextUUIDv4).replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}
```
Body — AFTER:
```ts
export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
): string {
  const token = randomHex(4).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}
```
Sole caller is `ChatView.tsx:2773` (§2.2) — updated to pass `randomHex`. No test calls
this function (verified).

---

### 2.4 `apps/server/src/atomicWrite.ts`  (drop the random id entirely; mirrors t3)

The temp file already lives in a uniquely-named scoped temp **directory**
(`makeTempDirectoryScoped`), so the filename needs no randomness.

Line 4 — BEFORE: `import * as Random from "effect/Random";` → **remove**.

Line 18 — BEFORE: `      const tempFileId = yield* Random.nextUUIDv4;` → **remove the line**.

Line 29 — BEFORE:
```ts
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);
```
Line 29 — AFTER:
```ts
      const tempPath = path.join(tempDirectory, "contents.tmp");
```
(No `Crypto` needed here. The `ru-fork` `mode`/`dirMode` block is untouched.)

---

### 2.5 `apps/server/src/environment/Layers/ServerEnvironment.ts`  (mirrors t3)

Imports — BEFORE (lines 1–6):
```ts
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
```
Imports — AFTER:
```ts
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
```

Service acquisition — BEFORE (lines 39–41):
```ts
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
```
AFTER (add line after `serverConfig`):
```ts
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
```

Use site — BEFORE (line 67):
```ts
    const generated = yield* Random.nextUUIDv4;
```
AFTER:
```ts
    const generated = yield* crypto.randomUUIDv4;
```
`Crypto.Crypto` is supplied wherever this layer is built (same source as `FileSystem`/`Path`).
The added `PlatformError` in the effect's error channel is already within the layer's
existing error union (FileSystem ops), so no extra handling is required (matches t3).

---

### 2.6 `apps/server/src/provider/Layers/CliAdapter.ts`  (fork-specific — keep `never` via `orDie`)

Imports: add `import * as Crypto from "effect/Crypto";` **after** line 29
(`import * as Clock from "effect/Clock";`); **remove** line 39
(`import * as Random from "effect/Random";`).

Service acquisition — BEFORE (lines 417–418, inside `makeCliAdapter`'s `Effect.gen`):
```ts
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger = options?.nativeEventLogger ?? undefined;
```
AFTER (add `crypto` line):
```ts
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options?.nativeEventLogger ?? undefined;
```

Use site — BEFORE (line 432):
```ts
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
```
AFTER:
```ts
    const nextEventId = crypto.randomUUIDv4.pipe(
      Effect.map((id) => EventId.make(id)),
      Effect.orDie,
    );
```
Rationale: `nextEventId` feeds `makeEventStamp()` (line 433) and the whole event-emission
path, all typed with error channel `never`. `Effect.orDie` converts a `crypto`
`PlatformError` (a missing secure RNG — unrecoverable anyway) into a defect, **preserving
the `never` error channel** so zero downstream signatures ripple. `Crypto.Crypto` is
provided by the same `NodeServices.layer` that already supplies this adapter's
`FileSystem`/`Path`/`ChildProcessSpawner`.

---

### 2.7 `apps/server/src/provider/acp/AcpNativeLogging.ts`  → **DELETE THE FILE**

`makeAcpNativeLoggers` is the file's only export and it has **zero references** repo-wide
(verified: the only match for `AcpNativeLogging`/`makeAcpNativeLogger` across the whole
tree is its own definition — no importer, no barrel re-export). It is dead code whose
sole reason for appearing in this migration is its `Random.nextUUIDv4` use (line 25).

**Action: delete `apps/server/src/provider/acp/AcpNativeLogging.ts` entirely.** This
removes the `Random.nextUUIDv4` usage at the source — no `Crypto` migration, no factory,
no caller updates. Nothing else in the codebase changes as a result of the deletion.

(If this file is ever wanted again, re-add it against beta.78 using the `Crypto.Crypto`
service for the event `id` — but that is out of scope for the bump.)

---

### 2.8 `apps/server/tests/open.test.ts`  (test — `it.layer(NodeServices.layer)` already provides Crypto)

Imports: add `import * as Crypto from "effect/Crypto";` **after** line 3
(`@effect/vitest/utils`, before `effect/Effect`); **remove** line 7
(`import * as Random from "effect/Random";`).

Use site — BEFORE (lines 473–481, inside the `it.layer(NodeServices.layer)("launchDetached", …)` block):
```ts
  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${yield* Random.nextUUIDv4}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
```
AFTER:
```ts
  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${yield* crypto.randomUUIDv4}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
```
This block runs under `it.layer(NodeServices.layer)` → `Crypto.Crypto` is in context.

---

### 2.9 `apps/server/tests/TestProviderAdapter.integration.ts`  (mirror t3 exactly)

Imports — BEFORE (lines 13–16):
```ts
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
```
Imports — AFTER (Crypto alphabetical, before Effect; Random removed):
```ts
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
```

Acquire `crypto` — BEFORE (lines 227–229, top of `makeTestProviderAdapterHarness`'s gen):
```ts
  Effect.gen(function* () {
    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
```
AFTER:
```ts
  Effect.gen(function* () {
    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const crypto = yield* Crypto.Crypto;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
```

Add the error-mapping helper — BEFORE (line 243):
```ts
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);
```
AFTER (append the helper right after `emit`):
```ts
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);
    const randomUUIDv4 = (threadId: ThreadId) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider,
              operation: "crypto/randomUUIDv4",
              issue: `Failed to generate test runtime identifier for thread '${threadId}'.`,
              cause,
            }),
        ),
      );
```
(`ProviderAdapterValidationError` is already imported (line 20) and has exactly the
fields `{ provider, operation, issue, cause }` — verified in `provider/Errors.ts`.)

Use site 1 — BEFORE (line 312):
```ts
            eventId: yield* Random.nextUUIDv4,
```
AFTER:
```ts
            eventId: yield* randomUUIDv4(input.threadId),
```

Use site 2 — BEFORE (line 369):
```ts
            eventId: EventId.make(yield* Random.nextUUIDv4),
```
AFTER:
```ts
            eventId: EventId.make(yield* randomUUIDv4(input.threadId)),
```
Consumer provision: the harness's new `Crypto.Crypto` requirement is satisfied by its
only consumer, `apps/server/tests/OrchestrationEngineHarness.integration.ts`, which
already `Layer.provideMerge(NodeServices.layer)` (line 279). No change needed there.

---

### 2.10 `apps/server/tests/provider/providerMaintenance.test.ts`  (helper → `Effect.sync` + Node global crypto)

The 7 `it.effect` blocks that call `makeTempDir` (lines 139, 174, 208, 267, 302, 383,
427) do **not** provide `NodeServices`/`Crypto`. Rather than thread the Crypto service
into all of them, compute the id synchronously via Node's global crypto inside an
`Effect.sync` — keeping all 7 call sites identical (`yield* makeTempDir(...)`), with no
service requirement and no `PlatformError`.

Line 9 — BEFORE: `import * as Random from "effect/Random";` → **remove**.
(The existing `import * as NodeServices …` on line 4 stays — it is used by the
`Effect.provide(NodeServices.layer)` blocks at lines 407/455.)

Helper — BEFORE (lines 21–24):
```ts
const makeTempDir = Effect.fn("makeTempDir")(function* (name: string) {
  const id = yield* Random.nextUUIDv4;
  return path.join(os.tmpdir(), `${name}-${id}`);
});
```
Helper — AFTER:
```ts
const makeTempDir = (name: string) =>
  Effect.sync(() => path.join(os.tmpdir(), `${name}-${globalThis.crypto.randomUUID()}`));
```
All 7 `yield* makeTempDir("…")` call sites stay byte-for-byte unchanged. (File already
has `// @effect-diagnostics nodeBuiltinImport:off`; `globalThis.crypto` is a global, not
a node import.)

---

## 3. Breaking change #2 — `Schema.Defect` value → `Schema.Defect()` factory

In beta.78, `effect/Schema`'s `Defect` is a factory function and **must be called**.
We have **58** bare-`Schema.Defect` sites (verified: 0 are already called). There are
exactly two textual shapes; the transform is mechanical and identical per site:

- Shape A (×55): `Schema.optional(Schema.Defect)`  →  `Schema.optional(Schema.Defect())`
- Shape B (×3):  `cause: Schema.Defect,`           →  `cause: Schema.Defect(),`

> `Schema.optional` itself is unchanged in beta.78 — **only its argument changes**.
> `Schema.Error` (effect) is **not** used bare anywhere (all `…Schema.Error` matches are
> the custom `AcpSchema.Error`), so it needs no change.
> **Do NOT touch** `packages/effect-acp/src/protocol.ts:551` — that is a *comment*
> mentioning `Schema.Defect`, not code.

### 3.1 Shape A sites — `Schema.optional(Schema.Defect)` → `Schema.optional(Schema.Defect())`

| File | Lines |
|---|---|
| `apps/server/tests/OrchestrationEngineHarness.integration.ts` | 164 |
| `apps/server/src/workspace/Services/WorkspaceFileSystem.ts` | 23 |
| `apps/server/src/workspace/Services/WorkspaceEntries.ts` | 26, 37 |
| `apps/server/src/provider/Errors.ts` | 14, 30, 46, 63, 80, 96, 111, 132, 151, 166, 182 |
| `apps/server/src/terminal/Layers/Manager.ts` | 66, 76 |
| `apps/server/src/terminal/Services/PTY.ts` | 19 |
| `apps/server/src/persistence/Errors.ts` | 13, 26, 75, 88 |
| `apps/server/src/orchestration/Errors.ts` | 10, 22, 35, 48, 61, 74 |
| `apps/server/src/checkpointing/Errors.ts` | 14, 30 |
| `apps/server/src/sourceControl/GitHubCli.ts` | 21 |
| `packages/effect-acp/src/errors.ts` | 20, 34 |
| `packages/contracts/src/project.ts` | 33, 53 |
| `packages/contracts/src/editor.ts` | 55 |
| `packages/contracts/src/vcs.ts` | 111, 125 |
| `packages/contracts/src/settings.ts` | 257 |
| `packages/contracts/src/filesystem.ts` | 28 |
| `packages/contracts/src/sourceControl.ts` | 159, 173 |
| `packages/contracts/src/terminal.ts` | 162, 191 |
| `packages/contracts/src/keybindings.ts` | 156 |
| `packages/contracts/src/server.ts` | 363 |
| `packages/contracts/src/ru-fork/mcp.ts` | 324 |
| `packages/contracts/src/git.ts` | 325, 337, 348 |
| `packages/contracts/src/orchestration.ts` | 1367, 1375, 1383, 1391, 1399 |

Each listed line, BEFORE → AFTER (identical edit, shown once; applies to every line above):
```ts
    cause: Schema.optional(Schema.Defect),
```
```ts
    cause: Schema.optional(Schema.Defect()),
```

### 3.2 Shape B sites — bare `cause: Schema.Defect,` → `cause: Schema.Defect(),`

| File | Line | BEFORE | AFTER |
|---|---|---|---|
| `packages/effect-acp/src/errors.ts` | 7  | `  cause: Schema.Defect,` | `  cause: Schema.Defect(),` |
| `packages/effect-acp/src/errors.ts` | 46 | `    cause: Schema.Defect,` | `    cause: Schema.Defect(),` |
| `packages/contracts/src/vcs.ts` | 67 | `    cause: Schema.Defect,` | `    cause: Schema.Defect(),` |

> A whole-tree find/replace of the regex `Schema\.Defect\b(?!\()` → `Schema.Defect()`
> (skipping `protocol.ts:551`'s comment) produces exactly these 58 edits. The table is
> the authoritative inventory; the regex is a convenience to apply them.

---

## 4. Tests that change (summary)

All test changes are already specified inline above; consolidated here for the
"do tests need changes?" check:

1. `apps/server/tests/open.test.ts` — §2.8 (Crypto import + `crypto.randomUUIDv4`).
2. `apps/server/tests/TestProviderAdapter.integration.ts` — §2.9 (Crypto + `randomUUIDv4` helper).
3. `apps/server/tests/provider/providerMaintenance.test.ts` — §2.10 (`makeTempDir` → `Effect.sync`).
4. `apps/server/tests/OrchestrationEngineHarness.integration.ts` — §3.1 line 164 only
   (`Schema.Defect()`); **no** layer change needed (it already provides `NodeServices.layer`).

No new test files. No web test target exists (web is validated by typecheck+lint).

---

## 5. Files explicitly NOT changed (and why)

- Node global `crypto.randomUUID()` call sites (if any) — Node API, unaffected by the
  effect bump; t3 migrated some for testability, but they are **not broken** on beta.78,
  so they are out of scope for a faithful bump.
- `effect/unstable/*`, `effect/testing/TestClock`, `@effect/atom-react`,
  `@effect/platform-node/*` import paths — all still valid in beta.78 (verified).
- `packages/effect-acp/src/protocol.ts:551` — comment, not code.

---

## 6. Apply & validation order (the final completeness gate)

1. Apply §1 (catalog, overrides, patch file + `patchedDependencies`).
2. `pnpm install --config.confirmModulesPurge=false`
   (the `--config…` flag avoids the darwin/linux native-binding purge that breaks
   oxlint/vite). **Verify the install log shows the effect patch applied cleanly** — if
   it reports a failed/!­fuzzy hunk, revisit §1.3 (patch rebase / McpServer hunk).
3. Apply §2 (Random→Crypto, 9 files) and §3 (Schema.Defect(), 58 sites).
4. **Typecheck** the workspace (the authoritative gate — see Residual-risk note in §0):
   - server: `pnpm --filter @t3tools/server typecheck` (or the repo's typecheck task)
   - web + packages: their typecheck tasks
   Green typecheck across all packages ⇒ no missed signature-level breakage ⇒ plan proven complete.
5. **Lint** (oxlint) — confirms import ordering of the added `effect/Crypto` imports and
   that no orphaned references to the deleted `AcpNativeLogging.ts` remain.
6. **Tests**: run the server vitest suite. Expected-green except the pre-existing,
   environment-known failures unrelated to this change (`mcp-probe` without qwen;
   `bin.test.ts` ×4) — do not misread those as regressions.

---

## 8. Real type errors found at compile (what the static surface-diff MISSED)

Honesty correction: §0's surface-diff was exhaustive only for **removed/renamed top-level
exports**. It could NOT see (a) **instance-method removals** (`Config.asEffect`), (b)
**type-relation changes** (`SqlClient`, `exactOptionalPropertyTypes`), (c) **Node-global
`crypto.randomUUID()` usage**, or (d) the **effect-language-service diagnostics that are
dormant on beta.59 and activate on beta.78**. Compiling against beta.78 (the gate §0
named) surfaced all of these. Verified against t3's commit `e6330` (same files) — no
hallucinated fixes.

**The 23 reported "real" (non-`effect()`-tagged) error lines decompose into exactly 2
code-fix root causes + 2 LSP lines + cascades.** Full mapping in §8.3.

### 8.1 Group 1 — `Config.asEffect` removed in beta.78 (mirror t3 `e6330`)
In beta.73+, a `Config` is **itself** the Effect — `.asEffect()` was removed; pipe the
Config directly. t3's `e6330` changed exactly these call shapes and nothing else.

**8.1a `apps/server/src/persistence/NodeSqliteClient.ts` (~line 255)** — and the
**identical vendored copy** `pixso-move/server/src/vendor/NodeSqliteClient.ts` (~line 259):
BEFORE:
```ts
  Layer.effectContext(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));
```
AFTER:
```ts
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
```
This single change resolves the file's `TS2339` (asEffect), and the cascading `TS2375`
(Layer assignment) + `TS28` (unknown channel) + `TS2345` (`unknown` not assignable to
`SqlClient`) — they were all downstream of the broken `asEffect` type.

**8.1b `scripts/dev-runner.ts:357`** (t3 `e6330` verbatim):
BEFORE:
```ts
    const { portOffset, devInstance } = yield* OffsetConfig.asEffect().pipe(
```
AFTER:
```ts
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
```
t3 changed ONLY this line in dev-runner; the other dev-runner errors (`356`, `493`, `503`,
`505`) are cascades of the `unknown` channel and resolve with it.

### 8.2 Group 2 — CliAdapter `crypto` shadow + Crypto-requirement cascade (self-inflicted by §2.6)

My §2.6 edit added `const crypto = yield* Crypto.Crypto` to `makeCliAdapter`. That
**(a) shadowed the 5 pre-existing Node-global `crypto.randomUUID()` calls** (lines 473,
861, 949, 1027, 1427 — the effect `Crypto` service has `randomUUIDv4`, not `randomUUID`
→ `TS2551`), and **(b) leaked a `Crypto` requirement into the `ProviderInstance` Effect**,
which `CliDriver.ts:88` assigns to `Scope | CliDriverEnv` (no `Crypto`) → `TS2375`.

Root fix: **don't introduce the Crypto service here at all.** The file already generates
UUIDs via Node-global `crypto.randomUUID()` (5×); use that same convention for the one
id `§2.6` migrated — no service, no requirement, no shadow, no cascade. (t3 has no
`CliAdapter`; this matches the file's own established pattern rather than inventing one.)

**`apps/server/src/provider/Layers/CliAdapter.ts`:**

1. **Remove** the import added in §2.6: `import * as Crypto from "effect/Crypto";`
2. **Remove** the service acquisition added in §2.6 (~line 418): `const crypto = yield* Crypto.Crypto;`
3. `nextEventId` (~line 432) — BEFORE (the §2.6 version):
```ts
    const nextEventId = crypto.randomUUIDv4.pipe(
      Effect.map((id) => EventId.make(id)),
      Effect.orDie,
    );
```
AFTER:
```ts
    const nextEventId = Effect.sync(() => EventId.make(crypto.randomUUID()));
```
(With the `const crypto` service gone, `crypto` here is the Node global again — exactly
what lines 473/861/949/1027/1427 already use, so all 5 `TS2551` and the `CliDriver:88`
`TS2375` cascade clear together.)

> Net effect on §2: this **supersedes the CliAdapter portion of §2.6** (the `orDie`/service
> approach). Everything else in §2 (web utils, git.ts, atomicWrite, ServerEnvironment,
> AcpNativeLogging deletion, the 3 tests) stands.

### 8.3 Complete mapping — every one of the 23 reported lines → its fix
| # | Error line | Code | Fix |
|---|---|---|---|
| 1 | `dev-runner.ts:357` | TS2339 `asEffect` | §8.1b (root) |
| 2–5 | `dev-runner.ts:356,493,503,505` | TS28/TS2345 | §8.1b (cascade) |
| 6–10 | `NodeSqliteClient.ts:254,256,260` | TS2375/2339/2345/28 | §8.1a (root+cascade) |
| 11–15 | `vendor/NodeSqliteClient.ts:258,264` | TS2375/2339/2345/28 | §8.1a (root+cascade) |
| 16–20 | `CliAdapter.ts:473,861,949,1027,1427` | TS2551 | §8.2 |
| 21 | `CliDriver.ts:88` | TS2375 | §8.2 (cascade) |
| 22–23 | `SkillScannerService.ts:40`, `SubagentScannerService.ts:41` | TS8 | **LSP** `leakingRequirements` — see §8.4 |

### 8.4 The remaining ~134 errors are effect-LSP diagnostics — NOT code bugs
`deterministicKeys` (95), `cryptoRandomUUIDInEffect` (16), `cryptoRandomUUID` (11),
`leakingRequirements`/TS8 (2), `preferSchemaOverJson` (3), `globalTimersInEffect` (3),
`missingLayerContext`/`missingEffectContext` (4) are `@effect/language-service`
diagnostics that were **silent on beta.59** (the LSP couldn't resolve beta.59 types) and
**activate on beta.78**. They are configurable via the `diagnosticSeverity` block in
`tsconfig.base.json` + `apps/web/tsconfig.json`.

**To land the effect bump green (preserving exact beta.59 behavior, which produced zero
effect-LSP diagnostics):** set the newly-firing rules to `"off"` in both tsconfigs (or
temporarily remove the `@effect/language-service` plugin entry). This is **not** silencing
real bugs — it restores the beta.59 status quo. The full clean-up of these diagnostics
(fix the 97 keys, migrate `crypto.randomUUID()`→service, resolve the requirement leaks) is
the **dedicated `ts-go-migration.md` work**, not the effect bump.

### 8.5 Apply order for §8
1. Apply §8.1 (3 files) and §8.2 (CliAdapter).
2. Set the §8.4 firing diagnostics to `"off"` in the two tsconfigs.
3. `pnpm typecheck` → expect green. `pnpm lint`, `pnpm test:fast` → green (minus known-env
   failures). If any *new* core-tsc error appears, it's a further missed change — fix and
   re-run (do not disable core diagnostics).

---

## 9. Fixing the effect-LSP diagnostics with t3's actual fixes (instead of silencing §8.4)

Full inventory (141): **deterministicKeys 95, cryptoRandomUUIDInEffect 16, cryptoRandomUUID
11, anyUnknownInErrorContext 5, preferSchemaOverJson 3, globalTimersInEffect 3,
missingLayerContext 2, missingEffectContext 2, leakingRequirements 2, unnecessaryEffectGen
1, lazyPromiseInEffectSync 1.**

Decomposition:
- **95 deterministicKeys** → key renames. Before/after for all are in `ts-go-migration.md §3`
  (the `t3/* → @ru-code/ru-code/*` table). Mechanical, contained, **safe** (in-memory DI keys).
- **9 cascades** (`anyUnknownInErrorContext` 5, `missingLayerContext` 2,
  `missingEffectContext` 2) are downstream of the §8 `unknown`/`Crypto` channels — they
  **disappear when §8.1/§8.2 are applied**. Not separate work. (Confirm after §8.)
- **27 crypto** → the cascade-heavy one (§9.1).
- **10 misc** → §9.2.

### 9.1 `crypto.randomUUID()` → effect `Crypto` service (27 sites) — ⚠️ CASCADING

⚠️ **This is not a per-line edit.** t3's `e6330` proves each conversion turns a value into
an `Effect` that **requires `Crypto.Crypto` and fails with `PlatformError`**, rippling
through every caller. Example (t3 `decider.ts`, verbatim):

BEFORE:
```ts
function withEventBase(input): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind, /* …8 fields… */
  };
}
```
AFTER:
```ts
function withEventBase(input): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({ eventId: EventId.make(eventId), /* …8 fields… */ })),
      ),
    ),
  );
}
```
…and then `decideCommandSequence`'s signature gains `| PlatformError.PlatformError` + `Crypto.Crypto`,
and `OrchestrationEngine` (its caller) must add `Effect.provideService(Crypto.Crypto, crypto)`
and map the error. **One site → 3+ files.**

**t3's three canonical templates** (pick per call-site shape):
- **T-A module-level helper** (`project.ts`) — when the site is a CLI/leaf with a domain error:
  ```ts
  const projectCommandUuid = Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(() => new ProjectCommandError({ message: "Failed to generate …identifier." })),
  );
  // call site:  CommandId.make(crypto.randomUUID())  →  CommandId.make(yield* projectCommandUuid)
  ```
- **T-B in-`make` helper** (`ProviderCommandReactor`) — when inside a service `Effect.gen`:
  ```ts
  const crypto = yield* Crypto.Crypto;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  // call site:  commandId: serverCommandId("x")  →  commandId: yield* serverCommandId("x")
  ```
- **T-C pure-fn → Effect** (`decider.ts`, above) — when the site is in a pure function.

**The 27 sites, grouped (before = `crypto.randomUUID()` at the location; after = apply the
template; cascade = files that change with it):**

| File:Line(s) | t3 source | Template | Cascade |
|---|---|---|---|
| `cli/project.ts:346,349,387,427` | **e6330 verbatim** | T-A | runProjectMutation gains `Crypto.Crypto` |
| `orchestration/decider.ts:51` | **e6330 verbatim** | T-C | `decideCommandSequence`→`OrchestrationEngine` |
| `orchestration/Layers/ProviderCommandReactor.ts:90,277` | **e6330 verbatim** | T-B | self-contained in `make` |
| `orchestration/Layers/ProviderRuntimeIngestion.ts:45,1173` | e6330 (diff lines) | T-B | self-contained in `make` |
| `orchestration/Layers/CheckpointReactor.ts:73,95,120,317` | fork — apply T-B | T-B | within `make` |
| `provider/acp/AcpSessionRuntime.ts:193` | fork — apply T-B/T-A | T-B | check method sig |
| `serverRuntimeStartup.ts:163,168,185,188` | fork | T-B | within startup gen |
| `ws.ts:244,265` | t3 has ws.ts — diff it | T-B | within handler gen |
| `auth/Layers/BootstrapCredentialService.ts:144` | fork | T-B | within `make` |
| `auth/Layers/SessionCredentialService.ts:206` | fork | T-B | within `make` |
| `ru-fork/mcp/McpReactor.ts:63` | fork | T-B | within `make` |
| `ru-fork/turnCompletedCheckpointDispatch.ts:82` | fork | T-B | check sig |
| `services/nodeStoreLive.ts:35`, `services/resultStoreLive.ts:47` (pixso) | fork | T-B | within `make` |
| `tests/persistence.test.ts:10` | test | T-B + provide NodeServices | test layer |

> For each fork site: **before** is the literal `crypto.randomUUID()`; **after** is `yield*
> <crypto>.randomUUIDv4` (T-B) or `yield* <helper>` (T-A), with the enclosing `Effect`
> signature gaining `Crypto.Crypto` (+ `PlatformError`, or `Effect.orDie` to keep `never`).
> Because each ripples, the exact after-text per site must be authored **with its call
> graph open** — this is the bulk of `e6330` re-done for our fork. **Discharge point:** all
> these `Crypto.Crypto` requirements are satisfied by `NodeServices.layer` already at the
> server root (so production paths compile once threaded; tests need `NodeServices.layer`).

### 9.2 The 10 misc diagnostics (contained — exact before/after)

**globalTimersInEffect (3) — `daemonLauncher.ts:66,217,364` (fork-only).** `setTimeout` in
Effect → `Effect.sleep`/`Schedule`. Per site, BEFORE (shape):
```ts
yield* Effect.async<void>((resume) => { setTimeout(() => resume(Effect.void), ms); });
```
AFTER:
```ts
yield* Effect.sleep(Duration.millis(ms));
```
(Read each of the 3 to confirm the exact surrounding shape; some may pass a callback that
must move into the post-sleep continuation.)

**preferSchemaOverJson (3) — `server.test.ts:25`, `EventNdjsonLogger.ts:92`,
`packages/shared/src/schemaJson.ts:69`.** `JSON.parse`/`JSON.stringify` → `Schema.fromJsonString(schema)`
/ `Schema.toCodecJson`. ⚠️ `schemaJson.ts` is the shared JSON helper — changing its
encoding could affect persisted data (see [[mcp-not-shipped-no-backcompat]]); verify
round-trip. The test + logger sites are low-risk.

**leakingRequirements (2) — `SkillScannerService.ts:40`, `SubagentScannerService.ts:41`.**
Service methods leak `FileSystem | Path` to callers. Fix = provide those inside the service
`make` (so methods return `Effect<…, never, never>`), or accept the leak. Needs the service
body open to author; **moderate** (touches the service's method signatures + callers).

**unnecessaryEffectGen (1) — `Migrations/009_ProviderSessionRuntimeMode.ts:4`.**
BEFORE: `Effect.gen(function* () { return <expr>; })` → AFTER: `<expr>` (or `Effect.succeed(<expr>)`).

**lazyPromiseInEffectSync (1) — `http.ts:160`.** `Effect.sync(() => <promise>)` →
`Effect.promise(() => <promise>)` (or `Effect.tryPromise`). Read the site for the exact thunk.

### 9.3 Honest scope verdict
- **Mechanical/contained (do now cleanly):** 95 keys (§3) + 9 auto-cascade + `unnecessaryEffectGen`
  + `lazyPromiseInEffectSync` + `globalTimers` (3) ≈ **~109**.
- **Cascading (the real effort — re-doing `e6330` for our fork):** the **27 crypto** sites
  + their requirement-threading, plus `leakingRequirements` (2) and `preferSchemaOverJson`
  on `schemaJson.ts`. This is **multi-file per site** and is what made `e6330`+`6b3050ee7`
  two large t3 PRs.
- **Recommendation:** do the contained ~109 now with the effect bump; tackle the **27
  crypto** as a focused pass **with each call graph open** (not a blind find/replace) —
  either now as a deliberate sub-effort, or as the first half of the tsgo PR. A blind crypto
  find/replace WILL break the requirement channels (proven by CliAdapter/CliDriver).

If steps 4–6 are green, this bump is complete and correct.
