# Conventions — applies to every task

Derived from the ru-fork monorepo (verified by reading `apps/server`, `apps/web`, `packages/*`,
root configs in this worktree). Every `pixso-move/` package obeys these. **This is the backbone —
read it before any task.**

---

## 1. Toolchain (identical to ru-fork)

| Concern | Tool / version | Source |
|---|---|---|
| Language | TypeScript 5.9.3, ESM, `module`/`moduleResolution`: `NodeNext` | `tsconfig.base.json` |
| Effect | `effect` (catalog) — **namespace** imports | throughout |
| Lint | **oxlint** 1.63.0 (root `.oxlintrc.json`) | root `package.json:19` |
| Format | **oxfmt** | root `package.json` |
| Typecheck | `tsc --noEmit` per package | `apps/server/package.json:23` |
| Tests | **vitest 3.2.4** + `@effect/vitest` 4.0.0-beta.59 | `pnpm-workspace.yaml` |
| Coverage | `@vitest/coverage-v8` 3.2.4, provider `v8` | `apps/server/vitest.config.ts` |
| Server bundler | tsdown 0.20.3 | `apps/server/tsdown.config.ts` |
| Plugin bundler | vite 8 (two configs) | [06](./06-plugin-build.md) |

Root scripts run with `NODE_OPTIONS='--experimental-strip-types --experimental-sqlite'`.
`node:sqlite` is **built-in** (Node 22+); there is **no `better-sqlite3`**.

### Gate commands (every package must pass, zero issues)
```bash
pnpm -w lint                                   # oxlint, 0 errors
turbo run typecheck --filter='@pixso-move/*'   # tsc --noEmit, 0 errors
turbo run test     --filter='@pixso-move/*'    # vitest --coverage; server-side = 100%
```

---

## 2. Senior-engineering rules (non-negotiable)

### 2.1 File & module budget — **hard cap 150 LOC per file**
- **No source file exceeds 150 lines of code** (blank lines and comment-only lines don't count;
  everything else does). If a module approaches the cap, **decompose by responsibility** before
  adding more.
- **One responsibility per file.** A file is either: a service *interface* (tag + shape), a service
  *implementation*, a *pure helper module*, a *route*, a *migration*, a *schema group*, or a
  *layer-composition* module — never a mix.
- Every task spec carries a **file-budget table** (path · responsibility · est. LOC). Implementation
  must match it; deviations require splitting, not inflating.
- **Functions:** keep them small and single-purpose; prefer pure functions extracted from effectful
  shells so logic is unit-testable without I/O.

### 2.2 DRY — shared infrastructure, defined once
Cross-cutting concerns live in exactly one place and are imported, never re-pasted:
- `pixso-move/tsconfig.base.json` — shared TS config (extends the repo `../tsconfig.base.json`);
  every package `extends` it. (Avoids per-package compiler-option drift.)
- `pixso-move/vitest.base.ts` — shared vitest/coverage config factory; each package's
  `vitest.config.ts` is a 3-line call into it (see §5).
- `@pixso-move/contracts` `src/base.ts` — the shared schema primitives (`TrimmedNonEmptyString`
  etc.), copied once from ru-fork `baseSchemas.ts`.
- `@pixso-move/server` `src/http/respond.ts` + `src/http/route.ts` — the single error→response
  mapper and the single route wrapper (auth + catch + cors). Every route reuses them; no route
  re-implements error handling.
- `@pixso-move/server` `src/time.ts` — `const nowIso = Effect.map(DateTime.now, DateTime.formatIso)`
  (the one timestamp source; matches `ws.ts:124`).

### 2.3 Vendoring policy (ported upstream code)
Some ru-fork infrastructure is reused verbatim and is **too large to rewrite or re-test** (e.g.
`NodeSqliteClient.ts` is 277 LOC). Such files:
- live under a `vendor/` directory in the consuming package (e.g. `server/src/vendor/`);
- are copied **verbatim** with a header `// pixso-move: vendored from <path> @ <ru-fork commit> —
  keep in sync; do not edit`;
- are **exempt** from the 150-LOC cap, from 100% coverage, and from our authored-code lint
  expectations (they are upstream code);
- are excluded in `vitest.config.ts` coverage and may be `oxlint`-ignored if upstream style
  diverges.
This keeps *our* authored surface small, DRY, and fully owned, while reusing proven infra.

---

## 3. TypeScript rules (from `tsconfig.base.json`)

All ON; zero typecheck errors:
- `strict`, `noUncheckedIndexedAccess` (array access is `T | undefined` — guard it),
  `exactOptionalPropertyTypes` (spread conditional optionals: `{ ...(env ? { env } : {}) }`),
  `verbatimModuleSyntax` (`import type` for types), `noImplicitOverride`, `useDefineForClassFields`.
- `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` → **relative imports carry `.ts`**:
  `import { x } from "./x.ts"`. Bare package specifiers don't.

The `@effect/language-service` "error" diagnostics in `tsconfig.base.json` are **editor-only** — they
do not affect `tsc --noEmit`/oxlint, so `crypto.randomUUID()` and friends compile. We still prefer
the testable idioms in §4 where they help.

### Import style
- Effect: `import * as Effect from "effect/Effect"`, `* as Layer`, `* as Schema`, `* as DateTime
  from "effect/DateTime"`, `* as SqlClient from "effect/unstable/sql/SqlClient"`. **Never** barrel
  `"effect"`.
- HTTP: `import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"`.
- ACP: `import * as AcpClient from "effect-acp/client"`, `* as AcpErrors from "effect-acp/errors"`,
  `* as AcpSchema from "effect-acp/schema"`.

---

## 4. Effect idioms (server + processor)

### Confirmed Schema API (from `packages/contracts/src/baseSchemas.ts` + usage)
```ts
Schema.String, Schema.Int, Schema.Number, Schema.Struct({...}), Schema.NullOr(x),
Schema.Literal("a"), Schema.Literals(["a","b","c"]), Schema.Array(x), Schema.brand("Brand")
// refinements via .check(...):
.check(Schema.isNonEmpty())            // non-empty string/array
.check(Schema.isMaxLength(n)) / .check(Schema.isMinLength(n))
.check(Schema.isBetween({ minimum, maximum }))
.check(Schema.isGreaterThanOrEqualTo(n)) / .check(Schema.isLessThanOrEqualTo(n))
// reuse, don't redefine:
TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty())
makeEntityId(brand)   = TrimmedNonEmptyString.pipe(Schema.brand(brand))
// decode at the edge:
Schema.decodeUnknownExit(schema)(input) → Exit ; HttpServerRequest.schemaBodyJson(schema)
```

### Timestamps — never `new Date()`
`import * as DateTime from "effect/DateTime"`; `nowIso = Effect.map(DateTime.now, DateTime.formatIso)`
(one shared module, §2.2). Tests pin the clock.

### IDs
`NodeId.make(crypto.randomUUID())` (ru-fork pattern, `serverRuntimeStartup.ts:160`). Designer keys
are generated client-side in the plugin (`dz_${uuid}`).

### Logging — `logError` / `logDebug` ONLY
`Effect.logError("msg", { …annotations })` for failures/defects we must see; `Effect.logDebug` for
traces, expected failures, and processing progress. **No** `logInfo`/`logWarning`. Annotate with
structured objects.

### Never crash
Every fallible unit (HTTP handler, processor job, ingest→notify) is wrapped so a failure is
**logged and contained**: handlers → typed-error JSON or a 500+`logError`; processor jobs →
`error` row + `logError` + loop continues. Mirror the three-way cause split in `ws.ts:57-81`
(defect→error, interrupt→debug, typed→debug).

### Errors as data
`Schema.TaggedErrorClass<E>()("Name", { …fields })` (`git.ts:320`). Handlers map them via the
shared `respond.ts` (§2.2), never inline.

---

## 5. Testing & coverage (server-side: TDD, 100%)

**Server-side** = `@pixso-move/contracts`, `@pixso-move/server`, `@pixso-move/processor` → **100%**
(lines/branches/functions/statements), minus the documented exclusions (`Migrations/**`, `bin.ts`,
`vendor/**`, justified spawn glue). **Plugin** is exempt from 100% (needs Pixso runtime); its *pure*
helpers are still unit-tested, and it must typecheck + lint clean.

### TDD per unit: red → green → refactor. Tests live in `tests/**/*.test.ts`, mirroring `src/`.

### Shared vitest base (`pixso-move/vitest.base.ts`) — DRY
```ts
import * as path from "node:path";
import { defineConfig } from "vitest/config";
export const makeVitestConfig = (dir: string) => defineConfig({
  resolve: { alias: [{ find: /^@pixso-move\/contracts$/,
    replacement: path.resolve(dir, "../contracts/src/index.ts") }] },
  test: {
    include: ["tests/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000,
    coverage: {
      provider: "v8", reporter: ["text", "json-summary", "lcov"], reportsDirectory: "./coverage",
      all: true, include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/testUtils/**", "src/persistence/migrations/**",
                "src/vendor/**", "src/bin.ts",
                "src/**/*.integration.ts"], // *.integration.ts = real-process spawn glue only, justified per file
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
```
Each package `vitest.config.ts`:
```ts
import { makeVitestConfig } from "../vitest.base.ts";
export default makeVitestConfig(import.meta.dirname);
```

### Idioms (from ru-fork)
```ts
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
it.effect("does X", () => Effect.gen(function* () { /* … */ }));
const layer = it.layer(SqlitePersistenceMemory);           // migrations run in :memory:
layer("repo", (it) => it.effect("inserts", () => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient; /* … */
})));
```
No real network, no real child processes, no real `Date.now()` in any test. The processor's ACP
dependency is injected behind `AcpRunner` and faked. SQL stores run against `:memory:`.

---

## 6. Definition of done (every task)
- [ ] Tests written first; green; server-side coverage 100%.
- [ ] Every source file ≤ 150 LOC, single-responsibility (vendor/ exempt).
- [ ] No duplicated cross-cutting logic — shared infra (§2.2) reused.
- [ ] `tsc --noEmit` + `oxlint` clean (0 errors).
- [ ] `logError`/`logDebug` only; nothing can crash the process.
- [ ] Matches the data model + contracts in [00-overview.md](./00-overview.md).
