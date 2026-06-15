# Task 1 — Scaffold

Stand up the four packages, wire them into the monorepo, and confirm the `effect-acp` reuse path.
**No business logic** — just buildable, typecheckable, lintable empty packages.

## Deliverables

### Shared config (DRY — created once at `pixso-move/`)
```
pixso-move/
  tsconfig.base.json     extends ../tsconfig.base.json; common compilerOptions for all packages
  vitest.base.ts         export makeVitestConfig(dir) (see conventions §5)
```
`pixso-move/tsconfig.base.json`:
```jsonc
{ "extends": "../tsconfig.base.json",
  "compilerOptions": { "composite": true, "types": ["node"], "lib": ["ESNext"] } }
```
Every package's `tsconfig.json` then reduces to:
```jsonc
{ "extends": "../tsconfig.base.json", "include": ["src", "tests"] }
```
(Server adds `"lib": ["ESNext","esnext.disposable"]`; plugin overrides `lib`/`jsx`/`types`/`paths`
— see [06](./06-plugin-build.md).) Every package's `vitest.config.ts` is the 3-line call from
conventions §5. **No coverage/compiler options are duplicated per package.**

### Packages
```
pixso-move/
  contracts/
    package.json          @pixso-move/contracts
    tsconfig.json
    vitest.config.ts
    src/index.ts          (re-exports; empty for now)
    tests/.gitkeep
  server/
    package.json          @pixso-move/server
    tsconfig.json
    vitest.config.ts
    tsdown.config.ts
    src/bin.ts            (entrypoint stub)
    tests/.gitkeep
  processor/
    package.json          @pixso-move/processor
    tsconfig.json
    vitest.config.ts
    src/index.ts
    tests/.gitkeep
  plugin/
    package.json          @pixso-move/plugin
    tsconfig.json
    manifest.json         (filled in task 6)
    src/.gitkeep
```

## package.json templates

Use the monorepo's `catalog:`/`workspace:*` conventions (verified against
`apps/server/package.json`, `packages/contracts/package.json`).

**contracts**
```jsonc
{
  "name": "@pixso-move/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:fast": "vitest run"
  },
  "dependencies": { "effect": "catalog:" },
  "devDependencies": {
    "@effect/vitest": "catalog:", "vitest": "catalog:", "@vitest/coverage-v8": "catalog:"
  }
}
```

**server** (depends on contracts + processor + effect-acp; node:sqlite is built-in)
```jsonc
{
  "name": "@pixso-move/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "pixso-move-server": "./dist/bin.mjs" },
  "scripts": {
    "dev": "node --watch src/bin.ts start",
    "build": "tsdown",
    "start": "node dist/bin.mjs start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:fast": "vitest run"
  },
  "dependencies": {
    "@pixso-move/contracts": "workspace:*",
    "@pixso-move/processor": "workspace:*",
    "effect": "catalog:",
    "@effect/platform-node": "catalog:"
  },
  "devDependencies": {
    "@effect/vitest": "catalog:", "vitest": "catalog:", "@vitest/coverage-v8": "catalog:",
    "tsdown": "catalog:"
  }
}
```
> If a needed dep is not yet in the root `catalog:` (e.g. `@effect/platform-node`), add it to the
> catalog in `pnpm-workspace.yaml` rather than pinning an ad-hoc version — match `apps/server`.

**processor** (depends on contracts + effect-acp; effect-acp is unscoped `effect-acp`)
```jsonc
{
  "name": "@pixso-move/processor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:fast": "vitest run"
  },
  "dependencies": {
    "@pixso-move/contracts": "workspace:*",
    "effect": "catalog:",
    "effect-acp": "workspace:*",
    "@effect/platform-node": "catalog:"
  },
  "devDependencies": {
    "@effect/vitest": "catalog:", "vitest": "catalog:", "@vitest/coverage-v8": "catalog:"
  }
}
```

**plugin** (versions are EXACT — must match `apps/web` so the vendored UI is identical)
```jsonc
{
  "name": "@pixso-move/plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm build:code && pnpm build:ui",
    "build:code": "vite build --config vite.code.config.ts",
    "build:ui": "vite build --config vite.ui.config.ts",
    "dev:code": "vite build --config vite.code.config.ts --watch",
    "dev:ui": "vite build --config vite.ui.config.ts --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "19.2.5", "react-dom": "19.2.5", "@base-ui/react": "1.4.1",
    "class-variance-authority": "0.7.1", "tailwind-merge": "3.4.0", "lucide-react": "0.564.0"
  },
  "devDependencies": {
    "vite": "8.0.10", "@vitejs/plugin-react": "catalog:",
    "tailwindcss": "4.2.4", "@tailwindcss/vite": "4.2.4",
    "vite-plugin-singlefile": "catalog-or-pin", "typescript": "catalog:",
    "@figma/plugin-typings": "pin-latest"
  }
}
```
> The plugin is **not** part of the 100%-coverage/test gate (needs Pixso runtime). It must still
> `typecheck` and `oxlint` clean. `@figma/plugin-typings` gives the Pixso/Figma `figma`/`pixso`
> global types (Pixso mirrors the Figma plugin API).

## tsconfig.json (each package) — extends the shared base above
```jsonc
{ "extends": "../tsconfig.base.json", "include": ["src", "tests"] }
```
- `pixso-move/tsconfig.base.json` is **one** level up from each package (`pixso-move/<pkg>/` →
  `../tsconfig.base.json`); it in turn extends the worktree-root `../tsconfig.base.json`. ✓
- Server's `tsconfig.json` adds `"compilerOptions": { "lib": ["ESNext","esnext.disposable"] }`.
- Plugin's overrides `lib`/`jsx`/`types`/`paths` (see [06](./06-plugin-build.md)).

## Workspace wiring
- Edit `pnpm-workspace.yaml`: add `"pixso-move/*"` to the `packages:` list (alongside `apps/*`,
  `packages/*`).
- Add any missing catalog entries used above (`@effect/platform-node`, `@vitejs/plugin-react`,
  `vite-plugin-singlefile`, `tsdown` if not present) under `catalog:`.
- Run `pnpm install` so workspace links resolve.
- Optional: a `turbo.json` already globs all workspaces; confirm `typecheck`/`test` tasks pick up
  the new packages (no change expected).

## Confirm effect-acp reuse (blocking gate for task 4)
Verified facts to encode now (so task 4 has no surprises):
- Package name: **`effect-acp`** (unscoped, `private`), `package.json` exports `./client`,
  `./schema`, `./errors`, `./rpc`, `./protocol`, `./agent`, `./terminal`.
- Import as `import * as AcpClient from "effect-acp/client"` → `AcpClient.AcpClient` (Context
  service), `AcpClient.layerChildProcess(handle, options?)`.
- Depend via `"effect-acp": "workspace:*"`.
- **Action:** add `effect-acp` to processor deps; write a throwaway `tests/imports.test.ts` that
  imports `AcpClient`, `AcpSchema`, `AcpErrors` and asserts the symbols exist — proves resolution
  before any real wiring. (Delete or fold into real tests in task 4.)

## TDD / tests
Scaffold has no logic, but the test harness must run:
- Each server-side package gets a trivial `tests/smoke.test.ts` (`it.effect("boots", () =>
  Effect.succeed(…))`) so `vitest run --coverage` exits 0 with the config in place.
- `vitest.config.ts` per package per [conventions §5](./conventions.md). The 100% thresholds are
  active from day one (trivially met while `src` is near-empty; keeps us honest as code lands).

## Acceptance
- [ ] `pnpm install` resolves; all four packages linked.
- [ ] `turbo run typecheck` — 0 errors across new packages.
- [ ] `pnpm -w lint` — 0 errors.
- [ ] `turbo run test` — green; server-side packages report 100% (trivially).
- [ ] processor `imports.test.ts` proves `effect-acp` resolves.
