# @ru-code/e2e — real-Chrome harness for the real app

Playwright drives the REAL app (server + web, booted once per run) against the
**fake ACP CLI** (`apps/server/src/ru-code/tests/qwen/fake-acp/`), which speaks
genuine ACP over stdio and writes genuine qwen-0.13.1 JSONL transcripts. A turn
completes in ~0.5s, so a full spec is seconds, not minutes.

## Running

```bash
pnpm test:e2e                 # from the repo root (all specs, one app boot)
pnpm test:e2e --list          # enumerate specs without running
pnpm test:e2e -g "case 4"     # one case
```

Deliberately **not** part of `pnpm test` (`vp run -r test` recurses by script
name; this package has no `test` script) — the gates never need a browser.

## How it works

- `scripts/bootApp.ts` (globalSetup): boots `dev-runner` with an isolated tmp
  `HOME`/`T3CODE_HOME`, points the CLI spawn at the fake via `RU_CODE_CLI_JS`,
  pairs with the one-time token and saves `storageState` **with
  `indexedDB: true`** (the environment connection lives in IndexedDB — without
  it every env RPC fails). Also wipes `apps/web/node_modules/.vite`: the vite
  dep-optimizer hash is lockfile-keyed, NOT content-keyed, so a rebuilt
  `@smart-tools` dist or a re-patched dep would otherwise be served stale.
- `scripts/stopApp.ts` (globalTeardown): kills the runner tree.
- `tests/fixtures.ts`: harness state, `writeFakeControl` (per-prompt fake knobs:
  `{delayMs, responseText}`), scroll instrumentation (writer tracer with call
  stacks + rAF scrollTop recorder), `analyzeTrace` verdicts
  (totalDelta / reversalPx / movingFrames / maxStepPx).
- Artifacts land in `.artifacts/`: `app-boot.log` (server, Debug + full ACP
  wire via `RU_CODE_ACP_PROTOCOL_LOG=1`), `fake-acp.log`, per-case console
  dumps, per-send evidence JSONs (`<label>-evidence.json` + trace/writer dump
  `<label>.json`), screenshots, playwright traces on failure.

## Writing a new case — the reusable pieces

```ts
await openFreshDraft(page); // pencil button → /draft/… (the REAL new-draft path;
// clicking a thread ROW skips promotion entirely)
await switchToExtended(page); // testid extended-chat-switcher (never by role)
await sendAndAwaitResponse(page, "вопрос", "ответ"); // fast turn, waits for render
const evidence = await instrumentedSend(page, text, resp, "label"); // full scroll evidence
expectSmoothPinnedSend(evidence); // one-motion/animated/pinned verdict (throttled variant available)
await waitForScrollStable(page); // predicate wait — frames, never wall clock
```

Rules that keep specs honest:

- **The fake is instant.** Any assertion waiting more than a few seconds means a
  wrong selector or a defect — abort, read `.artifacts/app-boot.log`
  (grep `DISPATCH|RESOLVED|FAILED`, `code: 'E'`), `fake-acp.log`, and
  playwright's `error-context.md`. Never wait out timeouts.
- **Predicates over sleeps.** Waits are expressed in conditions (URL crossed,
  composer cleared, scroll stable for N frames) so specs survive CPU throttle.
  Generous ceilings are fine — they resolve the instant the condition is true.
- **Verify the driver's own actions.** `send()` proves the text landed in the
  composer before Enter and proves the composer cleared after (typing races
  focus under throttle; Enter is swallowed while a turn settles).
- **Cross the promotion boundary** (`expect(page).not.toHaveURL(/\/draft\//)`)
  before typing a second message into a fresh-draft thread — the draft→thread
  re-key wipes an in-flight composer.
- **Slow-machine variant**: CDP `Emulation.setCPUThrottlingRate` (see case 8).
  Under throttle, assert terminal correctness (pinned / one direction / no
  drift), not frame aesthetics — the rAF recorder lives on the throttled main
  thread while scroll animates on the compositor.

## Fake ACP knobs

`writeFakeControl(state, { delayMs, responseText })` — re-read at every prompt;
`delayMs` shifts the JSONL record timestamps and the wire reply. Scenario
selection: `RU_CODE_FAKE_ACP=FLOW` (this harness), other built-ins live in
`fake-acp-server.ts`.

## Current specs

| Spec            | Guards                                                         |
| --------------- | -------------------------------------------------------------- |
| smoke / diag ×2 | boot, env connectivity, draft-route topology                   |
| case 1          | view mode survives draft promotion (thread-state chatViewMode) |
| case 2          | sent message renders instantly with a slow CLI, never blinks   |
| case 4          | sends 2..4: one smooth animated upward motion, bubble pinned   |
| case 6          | send from a scrolled-up position in a long history             |
| case 7          | landing response never moves the viewport while reading above  |
| case 8          | 10× CPU throttle: same terminal correctness on a slow machine  |
| case 5          | F5 → next send still animates and pins                         |

## Auto-update suites

These live under `features/auto-update/` and boot their own REAL installed app (their own
Playwright config, no shared globalSetup), which is why they are separate root scripts.

| Suite                                                  | Script                              | Guards                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `liveCycle.ts` (integration, headless)                 | `pnpm test:integration:auto-update` | a real install → check → press → download → verify → pointer flip → relaunch → GC, on disk                                                |
| `browserCycle.e2e.test.ts`                             | `pnpm test:e2e:auto-update-cycle`   | the restart as a USER sees it: fast restart finishes in place · slow restart hands over to the SW page and returns · the session survives |
| `autoUpdate.e2e.test.ts` + `updateInstall.e2e.test.ts` | `pnpm test:e2e`                     | the settings surface: sources, wizard, refusals, the press, the SW navigate-fallback                                                      |

Never run two browser suites at once — they bind real ports and drive real daemons.
