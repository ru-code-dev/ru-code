# @ru-code/e2e — real-Chrome harness for the real app

Playwright drives the REAL app (server + web, booted once per run) against the
**fake ACP CLI** (`apps/server/src/ru-code/tests/qwen/fake-acp/`), which speaks
genuine ACP over stdio and writes genuine qwen-0.13.1 JSONL transcripts. A turn
completes in ~0.5s, so a full spec is seconds, not minutes.

## Suites

| Suite       | testDir              | Config                             | Package script     | Root script              | For                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------- | ---------------------------------- | ------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core        | `tests-core/`        | `playwright.config.ts`             | `test:core`        | `test:e2e:core`          | the default suite — smoke, message-flow, scroll, agents panel, auto-update UI, mid-turn delivery, working indicator (shared globalSetup, ONE app booted for the whole suite)                                                                                                                                                                                                                 |
| contracts   | `tests-contracts/`   | `playwright.contracts.config.ts`   | `test:contracts`   | (part of `test:e2e:all`) | cross-cutting invariants against a real installed app — auth/time (A1/A2), spawn-env (E1). No globalSetup: each case self-boots its own app via the shared pin harness, which is exactly why these can't share a worker with `tests-core` (a pin's boot forces a fresh production rebuild of `apps/server/dist` mid-run, which corrupted every other tests-core spec when these lived there) |
| warm        | `tests-warm/`        | `playwright.warm.config.ts`        | `test:warm`        | (part of `test:e2e:all`) | the ACP warm-pool path — the only place session-identity handover after a Stop is exercised                                                                                                                                                                                                                                                                                                  |
| performance | `tests-performance/` | `playwright.performance.config.ts` | `test:performance` | `test:e2e:performance`   | fault-injection boots of the real installed app measuring machine behavior under stress (boot-window B1/B2/B2b/B4/B5, failure F1–F4, steady-state S1–S5) — run separately, not part of `test:e2e:all`                                                                                                                                                                                        |
| outdated    | `tests-outdated/`    | `playwright.outdated.config.ts`    | `test:outdated`    | (part of `test:e2e:all`) | quarantined pins — always SKIPPED; see `tests-outdated/README.md` for why and how to revive each                                                                                                                                                                                                                                                                                             |
| pixso       | `tests-pixso/`       | `playwright.pixso.config.ts`       | `test:pixso`       | `test:e2e:pixso`         | the Pixso MCP assistant panel; needs the ru-code-packages symlink and a free port 3667; not in test:e2e:all                                                                                                                                                                                                                                                                                  |

The shared pin harness (`pinHarness.ts`, `pinFakeCli.mjs`) lives in `harness/`
(not inside `tests-performance/`) since `tests-contracts/` depends on it too.

## Running

```bash
# one suite, from the repo root
pnpm test:e2e:core                              # core only
pnpm --filter @ru-code/e2e test:contracts        # contracts only
pnpm --filter @ru-code/e2e test:warm             # warm only
pnpm test:e2e:performance                        # performance only (run separately — not in test:e2e:all)
pnpm --filter @ru-code/e2e test:outdated         # outdated only (always green/skipped)

# one file or one case, from ru-code/e2e/
pnpm exec playwright test -c playwright.config.ts tests-core/messageFlow.e2e.test.ts
pnpm exec playwright test -c playwright.config.ts -g "case 4"
pnpm exec playwright test -c playwright.config.ts --list   # enumerate without running

# the auto-update cycle scripts (no shared globalSetup — each boots its own real installed app)
node ru-code/e2e/features/auto-update/browserRun.ts        # real-browser acceptance cycle
node ru-code/e2e/features/auto-update/liveCycle.ts         # headless integration cycle (disk-only)

# everything EXCEPT performance, in one chain (fast suites first, outdated last as the reminder
# printout) — performance is run separately since it measures the machine, not correctness
pnpm test:e2e:all                # core → contracts → warm → browserRun → liveCycle → outdated
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
- `tests-core/fixtures.ts`: harness state, `writeFakeControl` (per-prompt fake knobs:
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

## Fake Pixso MCP knobs

`harness/fakePixsoMcp.ts` is a short re-export of the REAL streamable-HTTP MCP server
standing in for the Pixso desktop plugin (the actual implementation lives in the package,
next to the real fake — `ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts`);
it also publishes `FAKE_PIXSO_ENTRY_PATH`, the spawn target `bootApp` uses. It binds
**127.0.0.1:3667** exactly (the app's endpoint is a hardcoded internal constant,
`PIXSO_MCP_ENDPOINT`), so a busy port is a hard boot failure — see `.artifacts/fake-pixso.log`.
`bootApp` starts it detached; `stopApp` kills it and sweeps.

Payloads are synthesized ONCE at boot from the three contract tables vendored verbatim in
`ru-code-packages/packages/pixso-core/dev/fake-mcp/pixso-tables/` (reached via the
`ru-code-packages` symlink; canonical source: the package's `tests/fixtures/contracts/`):
`get_node_dsl` answers example1 → example2 → example3 and then cycles, so successive scans
are distinct selections; `get_all_components` answers one shared 4648-entry catalog as the
live tool's two text items. The fake also re-parks the synthesized component identities on
INSTANCE nodes and re-keys the matching catalog entries, so the DSL⇄catalog join resolves.

`setPixsoFakeMode(state, mode)` rewrites the control file, re-read on EVERY request:

| mode        | behaviour                                                             |
| ----------- | --------------------------------------------------------------------- |
| `normal`    | the synthesized payloads (default)                                    |
| `dsl-error` | `get_node_dsl` answers an isError result → the scan settles dsl-error |
| `down`      | sockets destroyed unanswered → a genuine transport failure            |

To drive the real panel by hand (no Playwright), run the file `FAKE_PIXSO_ENTRY_PATH`
(`harness/fakePixsoMcp.ts`) names — that constant is where this path is written down, and
`bootApp.ts` spawns it for the suite itself. As of 2026-08-25 it resolves to
`ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts`, so from the repo root:
`node ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts`. It prints the
endpoint and one line per tool call.

That literal is a **dated convenience copy, not a guarantee**: no mechanism holds it equal to
the constant, so read it as «what the constant resolved to on that date» and nothing more. If
the command fails with `ERR_MODULE_NOT_FOUND`, the file has moved — take the path from
`FAKE_PIXSO_ENTRY_PATH`, which is the source of truth, and update the line above. This
paragraph used to assert the equality outright; it has now moved twice (FND-3: the package
move, then the extraction), and a prose restatement went stale each time, so the claim is
stated as a dated copy rather than propped up by a doc-scraping test (FND-30).

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

| Suite                                                  | Script                                                | Guards                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `liveCycle.ts` (integration, headless)                 | `node ru-code/e2e/features/auto-update/liveCycle.ts`  | a real install → check → press → download → verify → pointer flip → relaunch → GC, on disk                                                |
| `browserCycle.e2e.test.ts` (via `browserRun.ts`)       | `node ru-code/e2e/features/auto-update/browserRun.ts` | the restart as a USER sees it: fast restart finishes in place · slow restart hands over to the SW page and returns · the session survives |
| `autoUpdate.e2e.test.ts` + `updateInstall.e2e.test.ts` | `pnpm test:e2e:core` (part of `tests-core/`)          | the settings surface: sources, wizard, refusals, the press, the SW navigate-fallback                                                      |

Both `liveCycle.ts` and `browserRun.ts` are also chained into `pnpm test:e2e:all`
(root `package.json`), between the `warm` and `outdated` suites. Never run two
browser suites at once — they bind real ports and drive real daemons.
