# tests-outdated/ — quarantined pins

## Origin

These 9 cases were pulled out of the original `tests-pins/` (since re-split
into `tests-performance/` — the machine fault-injection pins — and
`tests-contracts/` — A1/A2, E1) because they encode two unfinished stories rather
than a currently-enforceable contract:

- The **§5 reconnect-loop field incident**
  (`SPECS/features/boot-performance/production-error.md`) — one user's app
  showed "no connection" every 5–10 s forever. `l-loop.pins.test.ts` (L1–L6)
  reproduces that incident end-to-end with a real freeze/thaw duty cycle on
  the real server.
- **Unfinished auth-consistency work** — the HTTP and WS layers disagree
  about whether an expired session row is dead, which the field incident's
  ticket-path entries hit directly.

Every test body below is byte-identical to its origin file; each got exactly
one line added — `test.skip(true, "outdated — see tests-outdated/README.md");`
as the first line of the test body — so the suite always reports SKIPPED and
`playwright.outdated.config.ts` exits 0.

## Per-test

- **A1b / A3** (`a-auth-outdated.pins.test.ts`; siblings A1/A2 now live in
  `tests-contracts/a-auth.e2e.test.ts`) — a REAL, UNFIXED bug: HTTP
  accepts a `wsTicket` that the WS layer then rejects for the same session
  (expired-session-row consistency between the HTTP ticket-issuance path and
  `SessionStore.verifyWebSocketToken`), and separately a presented ticket can
  be dropped when the `Host` header defeats `new URL()` parsing. **Revives
  by**: fixing the auth inconsistency so HTTP and WS agree about a dead
  session, and honoring a valid ticket regardless of Host parseability.

- **L1** — designed-red until phase-2 snapshot pagination. Its failing leg is
  one giant snapshot frame that cannot fit in any alive window; the phase-1
  fixes deliberately do not touch frame size. **Never edit this pin to
  pass** — only resumable/paginated thread-detail serving turns it green.

- **L4** — designed-red: the self-sustaining loop. A stale `afterSequence`
  cursor behind a fat event tail makes every reconnect replay the identical
  cold catch-up from byte zero, with no external fault driver — the app's
  own behavior under its own data. Revives with the same cursor/pagination
  fix as L1's underlying mechanism, or a cap on per-reconnect catch-up work.

- **L5** — designed-red: the thread list held hostage by a hanging `git`.
  `RepositoryIdentityResolver`'s uncached `git rev-parse --show-toplevel`
  runs on every resolve with a 60 s default timeout; a blocking git stalls
  every cold shell load. Revives by caching repository identity or bounding
  the git call independent of the global process-runner timeout.

- **L2 / L3 / L6** — **CONTROLS that must pass.** All six L's currently die
  at the SAME shared broken seeding step ("seed thread → visible in
  sidebar") — one repair of that step revives the whole family: L2/L3/L6 go
  green, and L1/L4/L5 go back to red at their own designed assertion
  (not at the seeding step).

- **B3** — dead: `buildAvShim()` returns `null` even with `gcc` present: the
  AV-latency LD_PRELOAD shim's build has decayed. Diagnose the compile
  failure, then either revive it (so B3's AV-latency fault genuinely
  engages) or delete the pin. Note: B5 in the staying
  `tests-performance/b-boot.perf.test.ts` references `buildAvShim()`
  conditionally for its AV-latency ingredient — until B3 is fixed, B5
  silently runs without that ingredient.

## Instruction

Re-evaluate each entry above: repair it back into its origin suite (with its
`test.skip` removed) — A1b/A3 into `tests-contracts/a-auth.e2e.test.ts` next to
A1/A2, B3 and the six L's into `tests-performance/` next to the other
fault-injection pins — or delete it outright. Do not let this folder grow
silently — every new arrival here needs its own origin/revives-by entry in
this README, and every entry needs a name attached to actually going back
and looking at it again.
