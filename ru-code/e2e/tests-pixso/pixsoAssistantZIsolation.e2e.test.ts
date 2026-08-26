// ru-code: QUALITY WAVE — S9 STATE ISOLATION (by the two-instance construction).
// `WORKFLOW/current/briefs/quality-wave-tasks.md:68-71`: "failed remote scan NEVER
// renders in local stepper and vice versa, incl. across reload." Per-task rule:
// "the analyst's located leak (PixsoAssistantPanel.tsx:60 routes ALL stream events to the
// local store) pinned dead."
//
// PHASE 2 (decisions 447/448): the leak is fixed — `ScanJobState` carries a
// server-computed `origin` (additive optional, `contracts/scan.ts`), threaded through
// every settle/publish site in `ScanJobService.ts`, and `store.ts`'s `applyScanJobState`
// drops any event whose `origin === "remote"` instead of adopting it — forwarding it to
// `remoteStore.ts`'s own `applyRemoteBootReplay` instead (the SAME one boot subscription,
// never a second wire subscription), which is what makes the REMOTE stepper survive
// reload too (case 5/6 below).
//
// Three cases, ascending strength:
//  1. Live-switch (no reload): the simplest reproduction of the located leak.
//  2. Reload variant: proves the fix holds across `page.goto`, not just within one
//     session (the analysis's own case table calls this "the strongest — cannot pass by
//     accident").
//  3. Mirror direction (local fails, switch remote): proves isolation holds BOTH ways,
//     not only remote→local.
//
// No real Pixso captures are required anywhere in this file: the remote scan is forced
// to FAIL deterministically via a bogus item-id, which `fakePixsoMcp.ts`'s remote route
// answers with an honest `isError: true` unconditionally (`callRemoteGetNodeDsl`,
// "unknown guid … valid ids are …" — live-contract mini-wave, decisions 453, renamed
// from "unknown itemId" alongside the wire params); the local scan is forced to fail via
// the harness's existing `down` control-file mode (DS-1: the harness's own selector idiom).
//
// FILE NAME sorts AFTER `pixsoAssistantRemote.e2e.test.ts` on purpose (same reasoning
// that file's own header states about sorting after `pixsoAssistant.e2e.test.ts`): all
// pixso specs share ONE server-side session (`playwright.config.ts`'s `workers: 1` /
// `fullyParallel: false`), and this file's OWN token-wizard flow (test 1) saves a real
// token into that SHARED storage — `pixsoAssistantRemote.e2e.test.ts`'s first case
// depends on opening with NO token saved yet, so this file must never run before it.
// Local's stepper state is read via a FINGERPRINT, not an assumed-empty count, for the
// same reason: `pixsoAssistant.e2e.test.ts` (which sorts BEFORE this file) leaves the
// local scanJob settled from its own last case, and this file's claim — "the remote
// failure changes nothing about the local tab" — holds regardless of what the local tab
// already contained when this file's tests start.

import {
  expect,
  readHarnessState,
  setPixsoFakeMode,
  test,
  type Page,
} from "../tests-core/fixtures.ts";

function designUrlFor(itemId: string): string {
  return `https://company-pixso.com/app/editor/AbCdEf123456?item-id=${encodeURIComponent(itemId)}`;
}

// An item-id that is well-shaped (parseDesignUrl only checks structure) but NOT a key in
// `fakePixsoMcp.ts`'s `REMOTE_ITEM_CAPTURES` — guaranteed to hit the fake's unconditional
// "unknown guid" error arm, real captures or not.
const UNKNOWN_ITEM_ID = "9999:999999";

// S10 (quality wave, decisions 447/448, DS-1): the RESERVED SYNTHETIC "imported" case —
// needs no real corpus, unlike the two real-capture item-ids. Used by cases 3/4 below (a
// genuine REMOTE success, independent of machine-local captures) — scanned exactly ONCE
// across this whole file, so it always settles as a fresh import, never a reimport.
const RESERVED_IMPORTED_ITEM_ID = "9000:000001";

async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
}

/** `null` when the local stepper does not exist at all (a genuinely fresh session);
 *  otherwise its own markup — a fingerprint good enough to detect "something about it
 *  changed", never assuming what the pre-existing state (if any) happens to be. */
async function localStepperFingerprint(page: Page): Promise<string | null> {
  const stepper = page.getByTestId("pixso-import-stepper");
  const count = await stepper.count();
  return count === 0 ? null : stepper.innerHTML();
}

/** Reaches the remote URL step regardless of whether a token was ALREADY saved by an
 *  earlier spec in this shared session (`pixsoAssistantRemote.e2e.test.ts` saves one in
 *  its own first case; running the whole pixso suite together means "no token yet" is
 *  true for at most ONE file). Runs the wizard only when onboarding is actually showing
 *  — never a second, redundant save over an existing token. */
async function ensureRemoteUrlStep(page: Page): Promise<void> {
  await page.getByTestId("pixso-source-remote").click();
  const onboarding = page.getByTestId("pixso-remote-onboarding");
  const urlStep = page.getByTestId("pixso-remote-url-step");
  await expect(onboarding.or(urlStep)).toBeVisible({ timeout: 15_000 });
  if (await urlStep.isVisible()) return; // a token from an earlier spec is already saved.

  await page.getByTestId("pixso-create-token").click();
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible();
  const goodToken = "pix_e2e_isolation_good_token";
  await page.getByTestId("pixso-token-input").fill(goodToken);
  await expect(page.getByTestId("pixso-token-check")).toBeEnabled();
  await page.getByTestId("pixso-token-check").click();
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(urlStep).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("S9 leak, live-switch case: a FAILED remote scan must NEVER surface in the local stepper on tab switch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openPixsoPanel(page);

  // BASELINE (std 6, non-vacuity): capture the LOCAL tab's own content BEFORE any remote
  // scan runs — a FINGERPRINT, not an assumed-empty count, because this file may run
  // standalone (fresh session, local stepper absent) OR after `pixsoAssistant.e2e.test.ts`
  // in the SAME shared server session (that file's own last case settles a `reimport`,
  // so the local stepper legitimately already shows SOMETHING). Either way, the claim
  // this test proves is "the remote failure changes NOTHING about it" — captured as a
  // fingerprint so the claim holds regardless of which state the baseline happens to be.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  const localStepperBefore = await localStepperFingerprint(page);

  // RE-PIN (found running this suite end to end, not a claim carried over): remote is the
  // DEFAULT source (decisions 428 #2), but "onboarding renders with no token" is only true
  // the FIRST time any pixso spec saves one this session — `pixsoAssistantRemote.e2e.test.ts`
  // (which sorts BEFORE this file, see FILE NAME above) saves its OWN real token in its
  // first case, so a combined run of the whole suite reaches this file with a token
  // ALREADY saved and opens straight to the URL step, never onboarding. Reuse this file's
  // own tolerant helper (already relied on by cases 2/3/5 below) instead of assuming a
  // fresh "none" state — the ORIGINAL assumption here was simply never exercised end to
  // end before this session.
  await ensureRemoteUrlStep(page);

  // ── force a REMOTE scan FAILURE (no real captures needed — see UNKNOWN_ITEM_ID) ──
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(UNKNOWN_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  const scanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(scanButton).toBeEnabled();
  await scanButton.click();

  // Settle as a FAILURE: the remote stepper's own failed row appears, and the success
  // banner ("Скан завершён", the ONLY thing a settled remote scan renders today per
  // `RemoteScanSetup.tsx:356-374`) must NOT appear.
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 45_000 });
  // At least one destructive-styled node in the failed row (icon + label both carry the
  // class, `ImportStepper.tsx:48-50,97`) — the exact count is an implementation detail,
  // "a failed row rendered at all" is the fact this asserts.
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Скан завершён")).toHaveCount(0);

  // ── THE PIN: switch to LOCAL — the remote failure just settled must change NOTHING
  // about it, whatever it was showing before ──
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  if (localStepperBefore === null) {
    // The fresh-session case (this file run standalone): correct (post-fix) behaviour
    // is that the local stepper still does not exist — nothing ever ran locally. The
    // located leak (`PixsoAssistantPanel.tsx:60` used to route every stream event into
    // the ONE shared local store regardless of which mode produced it) would have made
    // the REMOTE failure render here instead.
    await expect(page.getByTestId("pixso-import-stepper")).toHaveCount(0, { timeout: 5_000 });
  } else {
    // The shared-session case (this file run after `pixsoAssistant.e2e.test.ts`): the
    // local stepper already existed — it must be BYTE-IDENTICAL to the baseline, proving
    // the remote failure changed nothing about it.
    await expect
      .poll(() => localStepperFingerprint(page), { timeout: 5_000 })
      .toBe(localStepperBefore);
  }
});

test("S9 case 6 (reload variant, the analysis's own 'strongest' case): a FAILED remote scan replayed across reload must NEVER surface in the local stepper", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  // This file's FIRST test already saved a real token into this run's SHARED
  // server-side storage (same pattern `pixsoAssistantRemote.e2e.test.ts`'s own second
  // test documents) — the Import tab therefore opens straight to the URL step, not
  // onboarding.
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();

  // BASELINE (std 6) — see test 1's own comment for why this is a fingerprint, not an
  // assumed-empty count: this file's OWN test 1 never triggers a real local scan, but a
  // combined run alongside `pixsoAssistant.e2e.test.ts` can still leave local state.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  const localStepperBefore = await localStepperFingerprint(page);
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();

  // Force a FRESH remote failure (a different bogus id, so this is unambiguously a NEW
  // settle, not a replay of test 1's).
  const secondUnknownId = "9999:999998";
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(secondUnknownId));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  const scanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(scanButton).toBeEnabled();
  await scanButton.click();
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });

  // ── RELOAD — a fresh page load, fresh client stores, server-owned job replays ──
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();

  // THE PIN (post-fix): the REMOTE stepper survives reload with ITS OWN truth — the
  // `applyRemoteBootReplay` mechanism this task adds. (This half FAILED before S9: the
  // remote store's `scan` was created fresh at module init with no boot subscription at
  // all, so a reload always showed an idle/onboarding remote tab regardless of history.)
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });

  // THE PIN (case 6 itself): switch to LOCAL — the fresh remote failure above, and the
  // reload, must change NOTHING about it, incl. across the reload.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  if (localStepperBefore === null) {
    await expect(page.getByTestId("pixso-import-stepper")).toHaveCount(0, { timeout: 5_000 });
  } else {
    await expect
      .poll(() => localStepperFingerprint(page), { timeout: 5_000 })
      .toBe(localStepperBefore);
  }
});

test("S9 mirror direction: a FAILED local scan must NEVER surface on the remote tab on live switch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  // (No baseline assertion here — unlike tests 1/2, this test's own claim is entirely
  // about the REMOTE tab after a FRESH local failure; whatever local showed before this
  // point, forcing a new `mcp-down` failure below and checking its own destructive row
  // appeared is proof enough that THIS run's failure is the one under test.)

  // Force a LOCAL scan failure via the harness's own selector idiom (DS-1: the control
  // file, not an item-id — local addressing stays untouched).
  setPixsoFakeMode(state, "down");
  try {
    const scan = page.getByTestId("pixso-scan-button");
    await scan.click();
    await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    setPixsoFakeMode(state, "normal");
  }

  // ── THE PIN: switch to REMOTE — this file's earlier tests already saved a token, so
  // the URL step renders directly (not onboarding); it must show ITS OWN truth, never
  // the local failure just settled above. ──
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  // Non-vacuity (std 6): the remote stepper from THIS FILE's earlier remote tests may
  // legitimately still be showing (server-owned, survives tab switches by design) — the
  // claim here is specifically that it is NOT the local failure. A destructive-styled
  // row is expected (the earlier remote failures), so the precise claim is the ABSENCE
  // of local's own connect-step failure signature: local's `mcp-down` class fails at
  // step 0 (`ImportStepper`'s failedStep), which — mapped through `remoteStepIndex` —
  // would be indistinguishable by row position alone, so this asserts the STRONGER,
  // unambiguous fact instead: the remote tab's own scan button and URL input are
  // present and enabled, proving the remote UI is rendering ITS OWN component tree and
  // state, not a local-sourced error takeover.
  await expect(page.getByTestId("pixso-design-url-input")).toBeVisible();
  await expect(page.getByTestId("pixso-remote-scan-button")).toBeVisible();
});

test("S9 case 5 (reload variant, mirror of case 6): a FAILED local scan replayed across reload must NEVER surface on the remote tab", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  // BASELINE (std 6) — the remote tab's own pre-existing content (this file's earlier
  // tests already settled remote failures; a combined run alongside
  // `pixsoAssistantRemote.e2e.test.ts` may also have left a real settle). Captured as a
  // fingerprint for the SAME reason test 1/2 use one: the claim under test is "the local
  // failure below, and the reload, change NOTHING about it" — true regardless of what it
  // already was.
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  const remoteStepperBefore = await page.getByTestId("pixso-import-stepper").innerHTML();

  // Force a FRESH local scan failure via the harness's own selector idiom (DS-1: the
  // control file, not an item-id — local addressing stays untouched).
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  setPixsoFakeMode(state, "down");
  try {
    const scan = page.getByTestId("pixso-scan-button");
    await scan.click();
    await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    setPixsoFakeMode(state, "normal");
  }

  // ── RELOAD — a fresh page load, fresh client stores, server-owned job replays ──
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();

  // THE PIN (case 5 itself, mirror of case 6): switch to REMOTE — the fresh LOCAL
  // failure above, and the reload, must change NOTHING about the remote tab, incl.
  // across the reload. Before S14's two-instance registry (ONE shared `stateRef`), a
  // reload's single snapshot event would have replayed whichever instance ran LAST —
  // here that is the local failure — so the remote tab would have shown it (or, under
  // the earlier single-ref-with-client-filter patch, shown nothing at all, since the
  // ONE ref's last write was local-tagged and the remote store never got its OWN replay).
  // Two independent server-side refs is what makes the remote tab's OWN last truth
  // survive this reload untouched.
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("pixso-import-stepper").innerHTML(), { timeout: 10_000 })
    .toBe(remoteStepperBefore);
});

// S9 cases 3/4 (quality wave, decisions 447/448, PHASE-2 COMPLETION DISPATCH #2): "both
// ran, then reload — EACH stepper replays ITS OWN truth", the case the design's own §6.4
// calls out as needing a genuine REMOTE success leg — deferred in the prior return because
// the remote route only served REAL, machine-gated captures. S10's reserved synthetic
// "imported" case (`RESERVED_IMPORTED_ITEM_ID`, needs no corpus) dissolves that: LOCAL
// success uses the pre-existing `mode: "normal"` cycle (always succeeds, no captures
// either), so both legs are now machine-independent.
//
// Architecturally, this is the case the pre-S14 single shared `stateRef` COULD NOT PASS:
// with one ref, only the LAST run's state survives a reload, so whichever instance ran
// SECOND would win the replay and the other would show idle, not its own settled truth.
// Two independent per-instance refs are what make BOTH directions provable at once.

test("S9 case 3: LOCAL fails, REMOTE succeeds, then reload — EACH stepper replays its own run", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  // ── LOCAL leg: force a failure (down mode, no captures needed) ──
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  setPixsoFakeMode(state, "down");
  try {
    await page.getByTestId("pixso-scan-button").click();
    await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    setPixsoFakeMode(state, "normal");
  }
  // ROUND-1 F-5 (universality wave): the destructive marker and the stepper's final
  // settle render are two separate paints — a single raw read here captured spinner
  // markup once (the seat-4 disclosed failure). Same two-equal-reads stability poll the
  // case-4 success leg already uses.
  let localStepperAfterFail = await localStepperFingerprint(page);
  await expect
    .poll(
      async () => {
        const next = await localStepperFingerprint(page);
        const stable = next === localStepperAfterFail;
        localStepperAfterFail = next;
        return stable;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // ── REMOTE leg: force a SUCCESS via the S10 reserved "imported" case ──
  await ensureRemoteUrlStep(page);
  // F-10 (round 2, review finding): fingerprint the stepper BEFORE the click — the
  // file's own `expect.poll` idiom (used below for the post-reload pins), not a fixed
  // wait. On a SHARED remote instance this file's earlier tests already settled, the
  // stepper can already be present before this click, so `null` is not assumed —
  // whatever markup (or absence) exists right now is the baseline the poll below waits
  // to move away from.
  const remoteStepperBeforeClick = await page
    .getByTestId("pixso-import-stepper")
    .count()
    .then((count) => (count === 0 ? null : page.getByTestId("pixso-import-stepper").innerHTML()));
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(RESERVED_IMPORTED_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  const scanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(scanButton).toBeEnabled();
  await scanButton.click();
  // RISK-7 (analysis §7, quality wave): a REMOTE scan NEVER fetches a catalog
  // (`catalogInput = {kind:"absent-by-design"}`), so `catalogDegraded` is true on EVERY
  // remote settle — a FIRST-TIME remote import therefore always classifies
  // `success-warnings`, which F-1 (round 2) renders as the SAME S5 success surface
  // local's own settle gets (deviations go to diagnostics only — never invisible). So
  // the proof of a genuine settle here is the STEPPER completing (all three steps done,
  // no destructive row).
  //
  // F-10 (round 2): was a fixed `page.waitForTimeout(1_500)` — a real repro proved
  // `toBeEnabled()`/`toBeDisabled()` transition checks are BOTH unsound for these fast,
  // in-memory synthesized scans (the "running" window can be shorter than one
  // Playwright poll tick), which is why the wait existed at all; `expect.poll` on the
  // stepper's OWN markup fingerprint is the idiomatic replacement this same file already
  // uses for the post-reload pins below — it waits exactly as long as needed and no
  // longer, and it cannot pass on stale pre-click state the way a bare `toBeEnabled()`
  // could.
  await expect
    .poll(
      () =>
        page
          .getByTestId("pixso-import-stepper")
          .count()
          .then((count) =>
            count === 0 ? null : page.getByTestId("pixso-import-stepper").innerHTML(),
          ),
      { timeout: 15_000 },
    )
    .not.toBe(remoteStepperBeforeClick);
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("pixso-import-stepper").locator(".text-destructive")).toHaveCount(
    0,
    { timeout: 10_000 },
  );
  await expect(scanButton).toBeEnabled(); // settled, not still running
  // F-1 (round 2, MAJOR — the missing e2e this finding named explicitly): THIS is the
  // first-ever touch of `RESERVED_IMPORTED_ITEM_ID` in this shared server session (no
  // other pixso spec file scans it — `pixsoAssistantRemote`/`pixsoAssistantS10Dupli
  // cateEnriched` use their own distinct reserved/enriched ids), so this settle IS a
  // genuine first-time remote import. Before the fix, `success-warnings` rendered
  // NOTHING — no headline, no message, no `[Открыть карточку][Новый скан]` pair — a
  // silent success. Now it renders the SAME S5 surface a local success gets.
  await expect(page.getByText("Скан завершён")).toBeVisible();
  await expect(page.getByText("Карточка добавлена в галерею")).toBeVisible();
  await expect(page.getByRole("button", { name: "Новый скан" })).toBeVisible();
  const remoteStepperAfterSuccess = await page.getByTestId("pixso-import-stepper").innerHTML();

  // ── RELOAD — fresh client stores, server-owned per-instance state replays ──
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();

  // THE PIN: LOCAL still shows ITS OWN failure — the remote success must not have
  // overwritten or cleared it.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  await expect
    .poll(() => localStepperFingerprint(page), { timeout: 10_000 })
    .toBe(localStepperAfterFail);
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });

  // THE PIN: REMOTE still shows ITS OWN success — the local failure must not have
  // overwritten it, and reload must not have reset it to idle either (the single-ref
  // architecture this fix replaces could only ever remember ONE of the two).
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("pixso-import-stepper").innerHTML(), { timeout: 10_000 })
    .toBe(remoteStepperAfterSuccess);
  await expect(page.getByTestId("pixso-import-stepper").locator(".text-destructive")).toHaveCount(
    0,
  );
});

test("S9 case 4 (mirror of case 3): REMOTE fails, LOCAL succeeds, then reload — EACH stepper replays its own run", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  // ── REMOTE leg: force a failure (unknown item-id, no captures needed) ──
  await ensureRemoteUrlStep(page);
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(UNKNOWN_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  const remoteScanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(remoteScanButton).toBeEnabled();
  await remoteScanButton.click();
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });
  // ROUND-1 F-5: same stability poll as the local fail leg above — never a single raw read.
  let remoteStepperAfterFail = await page.getByTestId("pixso-import-stepper").innerHTML();
  await expect
    .poll(
      async () => {
        const next = await page.getByTestId("pixso-import-stepper").innerHTML();
        const stable = next === remoteStepperAfterFail;
        remoteStepperAfterFail = next;
        return stable;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // ── LOCAL leg: a genuine success (mode: normal — the default, always succeeds) ──
  await page.getByTestId("pixso-source-local").click();
  const localScanButton = page.getByTestId("pixso-scan-button");
  await expect(localScanButton).toBeVisible();
  // F-10 (round 2): fingerprint BEFORE the click, same idiom as the case-3 fix above.
  const localStepperBeforeClick = await localStepperFingerprint(page);
  await localScanButton.click();
  // F-10 (round 2): was a fixed `page.waitForTimeout(1_500)`. TWO real repros while
  // writing this suite ruled both transition-check variants out: (1) a bare
  // `toBeEnabled()` wait passes IMMEDIATELY if the click's own RPC round trip has not
  // yet flipped `scanJob.phase` to "running" — confirmed via a captured fingerprint
  // that literally showed the step-1 spinner; (2) a `toBeDisabled()` pre-check is
  // equally unsound for these fast, in-memory synthesized scans — the "running" window
  // can be shorter than one Playwright poll tick, so the check sometimes never observes
  // it and times out on a scan that in fact completed instantly. `expect.poll` on the
  // fingerprint sidesteps both failure modes — it does not care whether it ever
  // observes "running", only that the SETTLED markup differs from the pre-click one.
  await expect
    .poll(() => localStepperFingerprint(page), { timeout: 15_000 })
    .not.toBe(localStepperBeforeClick);
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 15_000 });
  await expect(localScanButton).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId("pixso-import-stepper").locator(".text-destructive")).toHaveCount(
    0,
    { timeout: 10_000 },
  );
  // A real flake was found here running the full combined suite: `localScanButton`
  // re-enabling reflects `scanJob.phase !== "running"` alone — it does NOT wait for the
  // settle handler's OWN follow-up async work (`store.ts`'s `applyScanJobState` fires
  // `refreshSnapshot()`/`loadReport()` off the SAME settle, not synchronously with it),
  // so a fingerprint captured on the very next tick can race a card-name-dependent
  // re-render that lands a moment later — and the POST-reload fingerprint (a fresh boot,
  // fully hydrated) would then legitimately differ from a PRE-reload one taken too early.
  // Poll until the fingerprint stops changing (two consecutive reads agree) instead of
  // trusting the first read after settlement.
  let localStepperAfterSuccess = await localStepperFingerprint(page);
  await expect
    .poll(
      async () => {
        const next = await localStepperFingerprint(page);
        const stable = next === localStepperAfterSuccess;
        localStepperAfterSuccess = next;
        return stable;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // ── RELOAD ──
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();

  // THE PIN: REMOTE still shows ITS OWN failure.
  await page.getByTestId("pixso-source-remote").click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("pixso-import-stepper").innerHTML(), { timeout: 10_000 })
    .toBe(remoteStepperAfterFail);
  await expect(
    page.getByTestId("pixso-import-stepper").locator(".text-destructive").first(),
  ).toBeVisible({ timeout: 5_000 });

  // THE PIN: LOCAL still shows ITS OWN success.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
  await expect
    .poll(() => localStepperFingerprint(page), { timeout: 10_000 })
    .toBe(localStepperAfterSuccess);
  await expect(page.getByTestId("pixso-import-stepper").locator(".text-destructive")).toHaveCount(
    0,
  );
});
