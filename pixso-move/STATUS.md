# pixso-move — build status

Snapshot of what's implemented in this worktree (`ru-fork/pisxo-move`). The design specs live in
[`specs/`](./specs/); this file records the **actual state** + decisions that differ from the specs.

**Updated:** 2026-06-14

## Where we are

| Package | Lint | Typecheck | Tests | Coverage | Build | Spec |
|---|---|---|---|---|---|---|
| `@pixso-move/contracts` | ✅ 0 | ✅ | 34 | **100%** | — | [02](./specs/02-contracts.md) ✅ |
| `@pixso-move/processor` | ✅ 0 | ✅ | 36 | **100%** | — | [04](./specs/04-processor.md) ✅ |
| `@pixso-move/server` | ✅ 0 | ✅ | 27 | **100%** | ✅ `dist/bin.mjs` | [03](./specs/03-server.md) · [05](./specs/05-embed.md) ✅ |
| `@pixso-move/plugin` | ✅ 0 | ✅ | 32 | (pure helpers) | ✅ `code.js`+`ui.html` | [06–08](./specs/06-plugin-build.md) ✅ |
| web `ru-fork/pixso-move` | ✅ 0 | ✅ | — (no web tests) | — | (typecheck+lint) | reader panel — below |

**Done:** Tasks 1 (scaffold), 2 (contracts), 3 (server), 4 (processor engine), 5 (embed),
6–8 (plugin), **plus the web "Макеты Pixso" reader panel** (new — see below).
**Deferred:** Task 9 — manual smoke against real qwen on the user's machine.

## How to run

Server (from the worktree root):
```bash
# dev (watch)
NODE_OPTIONS='--experimental-strip-types --experimental-sqlite' pnpm --filter @pixso-move/server dev
# built
pnpm --filter @pixso-move/server build
node --experimental-sqlite pixso-move/server/dist/bin.mjs start --port 7787
# verify
curl -H "x-designer-id: dz_test" http://localhost:7787/nodes   # → [] 200
```
Plugin:
```bash
pnpm --filter @pixso-move/plugin dev     # browser dev server — inspect UI without Pixso
pnpm --filter @pixso-move/plugin build   # → dist/code.js + dist/ui.html, import manifest.json into Pixso
```
Gates: `pnpm -w lint` · `turbo run typecheck --filter='@pixso-move/*'` · `turbo run test --filter='@pixso-move/*'`.

> **Env gotcha:** in some shells `pnpm install` purges modules and reinstalls **macOS** native
> bindings, breaking oxlint/vite/vitest on linux. Always use
> `pnpm install --config.confirmModulesPurge=false`. (`tsc` is binding-free.)

## Architecture (actual)

```
pixso-move/
  contracts/   effect Schema: ids, ingest, node, processing, tagged errors (DesignerId/NodeId/ResultTag …)
  server/      Effect + effect-platform HTTP + node:sqlite (vendored NodeSqliteClient). Embeds the processor seam.
  processor/   ONLY the Processor service tag + NoopProcessorLive (real engine = Task 4)
  plugin/      Pixso plugin: code/ (sandbox) + ui/ (iframe React, vendored ru-code kit + themes)
```

Data model (sqlite, 2 tables): `nodes` (immutable) + `processing_results` (status-tracked ledger).
HTTP: `POST /ingest`, `GET /nodes`, `GET /node?id=`, `GET /processing-data?nodeId=` — all gated by
the `x-designer-id` header.

## Decisions / deviations from the specs (read before continuing)

**Server**
- `GET /node?id=` (query param), **not** `/nodes/:id` — a path param is always present when matched,
  leaving an uncoverable branch; query-param is fully testable.
- Oversize preview → **400** (invalid payload), not 413 (the `Base64Png` max-length rejects it).
- Atomic claim uses SQL `RETURNING`. DB errors `orDie` → HTTP 500 via the shared `route()`/`respond()`.
- The processor is a **no-op seam** (`NoopProcessorLive`); ingest calls `Processor.notify` (currently
  a void). `/processing-data` returns `[]` until Tasks 4–5.

**Plugin (lots of ru-code-fidelity iteration — keep faithful)**
- **Storage:** settings AND theme persist via `pixso.clientStorage` (sandbox), **never localStorage** —
  the Pixso iframe is sandboxed/opaque-origin and `localStorage` throws `SecurityError` (this caused a
  black-screen crash). `themeName`+`themeMode` are folded into the `StoredSettings` blob.
- **Theme:** all 7 ru-code themes + `index.css` vendored. The web's `useTheme` hook is **not** reused
  (it's localStorage-bound); `ui/theme.ts` is a minimal `applyTheme` + constants instead. Theme picker
  uses the vendored `Select`.
- **Settings page = ru-code `GeneralSettingsPanel`:** vendored `settingsLayout.tsx`
  (`SettingsSection`/`SettingsRow`/`SettingResetButton`/`SettingsPageContainer`) + `tooltip.tsx`.
  Real-time (no Save button); per-field reset icons + a header **"Сбросить настройки"** matching
  `routes/settings.tsx`'s `RestoreDefaultsButton`. Back button matches mcp `RegistryTab` (ghost `sm`,
  `ChevronLeftIcon size-4`). Settings gear = `variant="outline" size="icon-xs"` (matches mcp/diff
  header buttons). UI is Russian, no tech jargon. **Keep base+sm responsive classes as ru-code wrote
  them — do NOT change the breakpoint.**
- **Key generation:** `crypto.randomUUID()` throws in the sandbox iframe → `key.ts` builds a v4 UUID
  from `getRandomValues` with a `Math.random` fallback.
- **Preview perf:** display preview exports at **capped width 640** (cheap); the **full 1× export
  happens only on send** (`handleCollect`) so the server keeps a pixel-perfect copy. Full-res on every
  select previously froze the plugin 30–50s.
- **Preview correctness:** state tracks `selectedNodeId`; preview resets when the node changes;
  `preview-ready` carries `nodeId` and is ignored if stale (frame switched mid-export).

## Processor (Tasks 4 + 5 — done)

- `@pixso-move/processor`: pure helpers (`prompt`/`extract`/`reconcile`/`acp/collect`/`acp/handshake`),
  the contained `drain.runOneJob` (any failure/defect → `error` row + `logError`, never escapes), and
  `engine.makeProcessor` (recover → reconcile → claim → run loop, `notify` serialized via a `Ref`
  state machine, `Schedule.fixed` poll timer, `catchCause` so a tick can't kill the loop). The real
  ACP runner is `acp/acpRunnerLive.integration.ts` (the only coverage-excluded file — real qwen
  spawn glue), exposed as `makeAcpRunnerLayer(opts)`.
- **Config is the only hardcoded part** (`processor/src/config.ts`): designer
  `dz_c07a93f7-2505-4e60-94af-17a2cc068b79`, tag `html-css`, the simple prompt. **CLI path, home,
  and auth method are NOT hardcoded** — they come from `ServerConfig` (`--cli-js` / `--cli-home` /
  `--cwd` / `--no-ssl` flags; auth defaults to `"openai"`). `cliJs === ""` ⇒ no qwen configured ⇒
  jobs still run but fail gracefully into `error` rows (server never crashes).
- **Embed:** `server/src/services/processorLive.ts` builds `ProcessorDeps` from the stores + the
  `AcpRunner` service and starts/stops the processor with the layer (scoped). `server.ts` wires
  `ProcessorLive`; `bin.ts` provides the real `makeAcpRunnerLayer` (+ `NodeServices` spawner).
  `POST /ingest` calls `Processor.notify`, contained so a notify failure never breaks the request.
  Tests provide a `FakeAcpRunner` → end-to-end in-memory (ingest → `done`) with no qwen.

## Web reader panel (`apps/web/src/ru-fork/pixso-move/`)

A developer-facing reader, mirroring the MCP right-panel pattern, isolated in one ru-fork folder:
- **Left nav:** `PixsoNavGroup` adds a block under search / above projects — **«Макеты Pixso»**
  (opens the panel) and **«MCP Серверы»** (inert placeholder). Hosted **app-wide** from
  `AppSidebarLayout` (inline sidebar on desktop, `RightPanelSheet` on narrow screens), so it opens
  from anywhere.
- **Panel:** header (refresh / settings gear / close) → gallery of preview thumbnails →
  node detail (preview + node JSON via `ChatMarkdown` ```json + collapsible per-result code blocks
  from `/processing-data`) → settings (server URL + designer id + sync interval `NumberField`,
  min 5, real-time, persisted to `localStorage`). **Manual refresh only** (the sync interval is
  stored for later; no polling yet — per the product decision).
- Reads the pixso-move server (`/nodes`, `/node?id=`, `/processing-data?nodeId=`) with React Query,
  gated by the `x-designer-id` header. Validated by **typecheck + lint** (apps/web has no test target).

## Next

- **Task 9** — manual smoke against real qwen: run the server with `--cli-js <path-to-qwen cli.js>`
  (+ `--cli-home` if needed), ingest from the plugin for the configured designer, watch the
  `html-css` result transition to `done`, then view it in the web panel.
