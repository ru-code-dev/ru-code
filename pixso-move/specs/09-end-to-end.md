# Task 9 — End-to-end: gates + manual smoke

Final wiring, the green-gate verification, and the manual smoke test (which **you** run, since this
box has no Pixso and no qwen).

## Automated gates (must all pass)
Run from the worktree root:
```bash
pnpm install
pnpm -w lint                         # oxlint — 0 errors across pixso-move/*
turbo run typecheck --filter='@pixso-move/*'   # tsc --noEmit — 0 errors
turbo run test --filter='@pixso-move/*'        # vitest --coverage
```
- **Server-side coverage = 100%** for `@pixso-move/contracts`, `@pixso-move/server`,
  `@pixso-move/processor` (thresholds enforced in each `vitest.config.ts`; only `Migrations/**`,
  `bin.ts`, and the justified `acpRunnerLive.ts` spawn glue are excluded).
- **Plugin** typechecks, lints, and `build`s (`dist/code.js` + `dist/ui.html`).

> Note on this environment: per project memory, native-binding-dependent test runs can fail in this
> box. `node:sqlite` is a built-in (Node 22, `--experimental-sqlite`) and the ACP path is faked in
> tests, so the server-side suites are expected to run headless. If any suite truly can't execute
> here, that is flagged explicitly (not silently skipped) and you run it on a real machine.

## Manual smoke (you run it)
Because Pixso and qwen live on your machine:

1. **Server**: `pnpm --filter @pixso-move/server start --port 7787 --db ./.data/pixso.sqlite
   --cli-js <path-to-qwen-cli.js>`. Confirm it logs startup (debug) and listens.
2. **Processor config**: edit `pixso-move/processor/src/config.ts` to add an entry for the
   `designerId` you'll use in the plugin, with a real prompt + `resultTag`.
3. **Plugin**: `pnpm --filter @pixso-move/plugin build`; import `pixso-move/plugin/manifest.json`
   into Pixso (Plugins → Development → Import). Open the plugin.
4. In the plugin: open **Settings**, set Server URL `http://localhost:7787`, **Generate** a key,
   **Save** (use that same `designerId` in the processor config).
5. Select **one frame** → see the preview + enabled Send. (Try selecting two unrelated items → the
   "not allowed" message; Send disabled.)
6. **Send** → expect 200 + a `nodeId`.
7. Verify storage + enrichment:
   ```bash
   curl -H "x-designer-id: <key>" http://localhost:7787/nodes
   curl -H "x-designer-id: <key>" http://localhost:7787/nodes/<nodeId>
   curl -H "x-designer-id: <key>" "http://localhost:7787/processing-data?nodeId=<nodeId>"
   ```
   `processing-data` should show rows transitioning `pending → processing → done` (or `error` with
   a message), one per configured `resultTag`, with the LLM `result` text on `done`.
8. **Robustness checks**: stop the server mid-processing and restart → `processing` rows recover to
   `pending` and finish. Point a config entry's prompt at something that makes qwen fail → the row
   goes `error` with a message; the server stays up; other jobs still process.

## What to capture
- Server logs for an ingest + a full processing cycle (`logDebug` steps + any `logError`).
- The three `curl` outputs.
- Confirmation that multi-select is rejected and single-select works.

## Acceptance (project-level)
- [ ] All automated gates green; server-side 100%.
- [ ] Manual smoke: ingest → stored → processed → readable, end to end, against real qwen.
- [ ] Crash recovery and error-marking observed working.
- [ ] Server never crashed throughout.
