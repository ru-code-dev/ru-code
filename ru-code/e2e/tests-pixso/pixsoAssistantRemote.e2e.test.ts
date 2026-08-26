// ru-code: the Pixso MCP assistant's REMOTE path, end to end in a real browser (task 23).
// Nothing here is stubbed inside the app: the panel dials the REAL server, the server
// dials the REAL fake Pixso MCP's REMOTE ROUTE (harness/fakePixsoMcp.ts, `/remote-mcp` —
// T10 reorg wave folded the formerly-separate `fakeRemotePixsoMcp.ts`/port 3668 into this
// ONE merged process/port 3667) — dialed because decisions 435/436 made
// `PIXSO_REMOTE_MCP_ENDPOINT` itself an in-git placeholder pointing there; no env override
// or host wiring is needed for THIS boot or any other — and the wizard/scan flow drives
// the REAL RPCs
// (`remoteTokenCheck`/`remoteTokenSave`/`scanStart`) — `web/remote/remoteStore.ts`'s
// UI-side simulation was removed by task 18.
//
// FILE NAME sorts AFTER `pixsoAssistant.e2e.test.ts` on purpose (both files share ONE
// server-side gallery across the whole run, `playwright.config.ts`'s `workers: 1` /
// `fullyParallel: false`): the local spec's assertions are pinned to "the first N scans"
// by DOM ORDER (`galleryCards(page).first()`), so this file must add its card AFTER that
// spec has already made its assertions, never before.
//
// TWO SHARED-GALLERY BUGS FOUND LIVE while wiring this spec (both fixed at their real
// layer, not papered over here):
//  1. The fake-remote's `get_node_dsl` payload reused the LOCAL fake's OWN first payload
//     byte-for-byte (`buildFakePixsoPayloads().dslTexts[0]`) — content-addressed identity
//     means a run that exercises both fakes settled the remote scan as a REIMPORT of the
//     local suite's own card, not a fresh success. FIRST fixed with a synthetic rename
//     (`uniqueRemoteDslText`) that dodged the collision by mutating served data — replaced
//     (this round) with the fake serving the TWO REAL Pixso captures instead, dispatched
//     by itemId (`harness/fakeRemotePixsoMcp.ts`'s `REMOTE_ITEM_CAPTURES`). That reopens
//     the SAME collision on purpose: `pixsoAssistant.e2e.test.ts`'s own "real Pixso
//     captures" section (this file's neighbor, guaranteed to run FIRST — see FILE NAME
//     below) already imports both `debug-3` and `debug-4` through the LOCAL fake
//     before this file's first test ever runs. A remote scan of either capture is
//     therefore a PROVABLE reimport of that same card, every time the corpus is present —
//     not a defect, and not dodged here: the first case below asserts the reimport
//     explicitly (owner instruction: fix collisions at the TEST layer, never by mangling
//     served data). See its own comment for the count-based proof.
//  2. `remoteStore.ts` classified "ok" via `outcomeImportsCard` (did a NEW card land) —
//     false for a healthy reimport, so a reimported remote scan rendered NOTHING at all.
//     Fixed to `importOutcomeOf(outcome) !== "error"` (PKG, task 18/23 follow-up) — this
//     is exactly the fix the first case below exercises: the reimported remote scan must
//     still settle visibly. UPDATED (quality wave S5/S6/S7, decisions 447/448; round-2
//     F-8): "visibly" now means the spec's OWN duplicate copy — the shared «Скан
//     завершён» title (reused, not the invented «Дубликат» headline) plus the
//     duplicate-specific message «<name> уже есть в галерее» — not the PLAIN success
//     message every settle used to get regardless of outcome — see each case's own
//     re-pin comment below.

import { REAL_CAPTURE_SETS } from "../harness/fakePixsoMcp.ts";
import {
  frameHasRemoteSource,
  loadRealCapture,
  rootLayerNameOf,
  rootSizeLabelOf,
} from "../harness/pixsoExpectations.ts";
import type { HarnessState } from "../scripts/bootApp.ts";
import { expect, readHarnessState, test, type Page } from "../tests-core/fixtures.ts";

interface FakeRemoteCalls {
  readonly calledTools: ReadonlyArray<string>;
  readonly authorizations: ReadonlyArray<string | null>;
}

/** `harness/fakePixsoMcp.ts`'s own `REMOTE_ITEM_CAPTURES`, restated here so this
 *  file names its design URLs by the REAL capture they resolve to, not by an opaque id
 *  copied out of a dump.
 *  PIN REWRITE (test-standards #9, remote-parity T6, analysis §6.2 point 3): `3035:121084`
 *  now serves the REAL remote wire capture (`debug-3/remote`, `{kind:"remote-wire"}`),
 *  never the local plugin's `debug-3` bytes over the remote route — every test below
 *  that uses it is affected only where it asserted specific debug-3 CONTENT (none do:
 *  the auth-lifecycle and full-probe tests only assert reachability/settle-title, which
 *  hold under EITHER payload). `1886:185986` is unchanged (`{kind:"local-capture"}`, still
 *  `debug-4` — owner decision, no synthetic remote Modal, DS). */
const CAPTURE_ONE_ITEM_ID = "3035:121084"; // → debug-3/remote (REAL remote wire, ~2 MB — "action sheet")
const CAPTURE_TWO_ITEM_ID = "1886:185986"; // → debug-4  (17 MB — used for the full round trip)
// T5/T6 (remote-parity wave §5.5, decisions 456): the reserved access-denied case, in the
// SAME private `9000:*` range the S9/S10 suites already use — never collides with a real id.
const ACCESS_DENIED_ITEM_ID = "9000:000014";

function designUrlFor(itemId: string): string {
  return `https://company-pixso.com/app/editor/AbCdEf123456?item-id=${encodeURIComponent(itemId)}`;
}

/** Same locator discipline as `pixsoAssistant.e2e.test.ts`'s own (unexported) helper:
 *  scoped to `pixso-group-section` — the ONE component both grouped sections and the
 *  "unsorted" bucket render through — so a row-height probe or in-flight DragOverlay
 *  ghost render never over-counts. */
function galleryCards(page: Page) {
  return page.getByTestId("pixso-group-section").getByTestId("pixso-card");
}

/** The ONLY way this process (a separate test runner) sees the fake-remote server's own
 *  call history — it runs as a detached spawned child (see bootApp.ts). */
async function fetchRemoteCalls(state: HarnessState): Promise<FakeRemoteCalls> {
  const response = await fetch(state.remotePixsoCallsUrl);
  return (await response.json()) as FakeRemoteCalls;
}

async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

// Both remote tests below dial real captures by itemId (`harness/fakePixsoMcp.ts`'s
// `REMOTE_ITEM_CAPTURES`) — honest, same discipline `pixsoAssistant.e2e.test.ts`'s own
// "real Pixso captures" section already uses, rather than a silent failure on a machine
// with no corpus. T7 (remote-parity wave §11.4, decisions 456 PHASE-2b item 1): the guard
// now ALSO requires `debug-3/remote` — `3035:121084` serves it now, not `debug-3`, and
// `debug-3/remote` is deliberately excluded from `REAL_CAPTURE_SETS`/`realCaptureSets()`
// (T6: it is a raw-JSON-RPC-shaped set, never mixed into the local route's dump-tool-shaped
// cycle), so its presence is checked directly against the file the harness actually reads.
// W0 (universality wave): the canonical corpus layout — the wire capture lives at
// debug-3/remote/raw/, and the two local sets are the debug-3/debug-4 frames.
// ru-code: the manifest states which frames carry a remote source, so this no longer
// reaches into the corpus (which lives with the package now, decisions 510/511).
const PIXSO_REMOTE_WIRE_PRESENT = frameHasRemoteSource("debug-3");
test.skip(
  !REAL_CAPTURE_SETS.includes("debug-3") ||
    !REAL_CAPTURE_SETS.includes("debug-4") ||
    !PIXSO_REMOTE_WIRE_PRESENT,
  "need debug-3 (local+remote) AND debug-4 in the package's corpus — link ru-code-packages " +
    "and run 'pnpm pixso:expectations'",
);

test("remote path: token wizard → verify → save → URL → scan → REIMPORT of the local suite's own real-capture card", async ({
  page,
}) => {
  // The 17 MB debug-4 capture (CAPTURE_TWO_ITEM_ID below) parses through one more
  // network hop than the local path (this fake, over real MCP-over-HTTP) — same D-A2
  // budget discipline `pixsoAssistant.e2e.test.ts`'s real-capture section uses, scaled
  // down: no seven-tab render here, just the round trip + one gallery count.
  test.setTimeout(180_000);

  const state = readHarnessState();
  const before = await fetchRemoteCalls(state);

  await openPixsoPanel(page);

  // ── BASELINE, before this test touches anything ───────────────────────────
  // `pixsoAssistant.e2e.test.ts`'s "real Pixso captures" section (this file's neighbor,
  // guaranteed to finish FIRST — see FILE NAME above) already imported `debug-4`
  // through the LOCAL fake. One card for it must already be sitting in the shared
  // gallery — the precondition the reimport assertion below depends on.
  const capture = loadRealCapture("debug-4");
  const rootName = rootLayerNameOf(capture) ?? "";
  const rootSize = rootSizeLabelOf(capture) ?? "";
  expect(rootName, "debug-4 has no root layer name to identify its card by").not.toBe("");
  expect(rootSize, "debug-4 has no root size to identify its card by").not.toBe("");
  const matchingCards = () =>
    galleryCards(page).filter({ hasText: rootName }).filter({ hasText: rootSize });
  await page.getByRole("tab", { name: "Галерея" }).click();
  await expect(
    matchingCards(),
    "precondition failed: the local suite's own real-capture card for debug-4 is not in the gallery",
  ).toHaveCount(1, { timeout: 10_000 });
  await page.getByRole("tab", { name: "Импорт" }).click();

  // Remote is the DEFAULT source (decisions 428 #2) — the onboarding renders with no
  // token yet, exactly S02 of states-index.md.
  await expect(page.getByTestId("pixso-remote-onboarding")).toBeVisible();

  // ── the token wizard ──────────────────────────────────────────────────────────
  await page.getByTestId("pixso-create-token").click();
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible();

  const goodToken = "pix_e2e_remote_good_token";
  await page.getByTestId("pixso-token-input").fill(goodToken);
  await expect(page.getByTestId("pixso-token-check")).toBeEnabled();
  await page.getByTestId("pixso-token-check").click();

  // SUPERSEDED PIN AGAIN (remote-parity wave T5, analysis §5.2, decisions 456 DS-A,
  // test-standards #9): «Токен работает» itself DIES — the check is re-scoped to
  // connectivity + tools/list only and can no longer claim token VALIDITY. The REAL-
  // round-trip proof this line carries (the fake's REAL tool registration, not a
  // hardcoded simulation) is still exercised — just not tied to the old wording.
  // `remoteTokenCheck`'s realness has its own dedicated proof at the unit level
  // (`tests/remoteStoreWiring.test.tsx`); this e2e's job is the visible lifecycle
  // (verify → save → scan).
  // SUPERSEDED AGAIN (round-2 F-3 RULING): DS-A's own FIRST replacement, «Сервер
  // доступен, токен сохранён», was itself false copy — this verify-ok block renders
  // BEFORE the «Сохранить токен» click below, so it cannot truthfully claim the token is
  // saved yet. Final replacement: «Сервер доступен» ONLY. The save claim's own real
  // moment is pinned two lines down, unchanged: `page.getByText("Токен сохранён")` fires
  // AFTER `pixso-token-save` is clicked — that is where "saved" becomes true.
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pixso-token-verify-ok")).toContainText("Сервер доступен");
  await expect(page.getByTestId("pixso-token-verify-ok")).not.toContainText("Токен работает");
  await expect(page.getByTestId("pixso-token-verify-ok")).not.toContainText("токен сохранён");

  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();

  // ── the per-scan URL step ───────────────────────────────────────────────────
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(CAPTURE_TWO_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();

  const scanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(scanButton).toBeEnabled();
  await scanButton.click();

  // Settle: the fake is on localhost, but this runs alongside a real browser + real app
  // server + BOTH fake MCP processes in one sandboxed run — the same margin the local
  // spec's own `runScan` gives its `scanButton.toBeEnabled()` wait (45s), and the
  // server's own JOB_DEADLINE (ScanJobService.ts) is 60s, the true ceiling.
  //
  // RE-PIN (quality wave S5/S6/S7, decisions 447/448, analysis §6.3 — this exact case
  // named as pending: "the reimport case now asserts the DUPLICATE surface, not «Скан
  // завершён»"). SUPERSEDED PIN AGAIN (round 2, F-8, test-standards #9): the invented
  // "Дубликат" headline was never a spec literal (`quality-wave-tasks.md` names only the
  // card-name + two body lines for duplicate, no separate headline word) — the shipped
  // default REUSES the S5 success title instead, so «Скан завершён» now legitimately
  // appears on BOTH surfaces. What still tells them apart is the MESSAGE: a reimport's
  // is «<name> уже есть в галерее», never the plain success's «Карточка добавлена в
  // галерею». Asserting the message (not the title) is the real proof the reimport
  // classification reaches the remote UI at all.
  await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`${rootName} уже есть в галерее`)).toBeVisible();
  // Negative pin (std 3): the PLAIN success message must NOT appear on a reimport —
  // this is what distinguishes it from a first-time import now that the title is shared.
  await expect(page.getByText("Карточка добавлена в галерею")).toHaveCount(0);

  // ── the fake-remote's OWN call log (the authoritative proof, task 18/G2-13) ──
  // Proves the REMOTE round trip actually happened — the fake really answered THIS
  // request with the real debug-4 bytes — independent of what the reimport
  // dedupe below does with the result.
  const after = await fetchRemoteCalls(state);
  const newCalls = after.calledTools.slice(before.calledTools.length);
  // SUPERSEDED PIN (resolve wave A1, decisions 465 — test-standards #9, rewritten in the
  // same change that supersedes it): «exactly ONE get_node_dsl» dies — the recursive
  // nested-node resolve now makes 1 root call + one TARGETED call per DISTINCT
  // nested-instance guid (debug-4's expansion carries ~24), ALL through the same
  // consumed tool. The consumed-tool law is UNCHANGED (the wave spec's own words: "same
  // tool, more calls") — what this pin still proves, and what a regression would break,
  // is that NO OTHER tool is ever dialed on the remote scan path.
  expect(newCalls.length).toBeGreaterThanOrEqual(1);
  expect([...new Set(newCalls)]).toEqual(["get_node_dsl"]);
  // The `Token` header carried the SAVED token, verbatim (live-contract mini-wave,
  // decisions 453 — the oracle's header, no `Bearer ` scheme prefix) — proves the RPC
  // layer actually threads the stored token onto the wire rather than dialing anonymously.
  const newAuth = after.authorizations.slice(before.authorizations.length);
  expect(newAuth.some((header) => header === goodToken)).toBe(true);

  // ── REIMPORT, not a fresh card — asserted explicitly, not dodged ───────────
  // Content-addressed identity (`ScanStore.ts`: `id = sha256Hex(dslRaw)`) means this
  // remote scan produced the EXACT SAME id as the local suite's earlier import of the
  // same capture — `persistScan`'s DUPLICATE branch runs, no second card is created,
  // and because a remote scan never calls `get_all_components` (`catalogRaw` is always
  // null on this path), the existing card's `catalogHash`/`source`/etc. are left
  // completely untouched (the `refreshed` guard in `ScanStore.ts` short-circuits on a
  // null catalogHash). So the ONLY externally observable proof available here is that
  // the gallery still shows exactly ONE card for this capture — a broken dedupe would
  // show two. (There is no remote-vs-local-origin marker in the UI to assert on
  // instead: `RemoteScanSetup.tsx`'s settle banner is identical for a fresh success and
  // a reimport — see the "Скан завершён" wait above, which is itself proof the
  // reimport-classification fix still renders something.)
  await page.getByRole("tab", { name: "Галерея" }).click();
  await expect(
    matchingCards(),
    "the remote scan must REIMPORT the local suite's existing debug-4 card, not duplicate it",
  ).toHaveCount(1, { timeout: 10_000 });
});

// round-2 F-4 (the missing headline e2e, analysis §11.4 item 1): the ENTIRE F-1 geometry
// fix's real-world stakes prove out through this ONE assertion — `data-node-id` on the
// card's root row. `3035:121084` is `pixDslNodes`' requested node (C-1: the card must root
// there); `19:39374` is the FIRST node the raw file happens to list — the pre-C-1 "assume
// the requested node is first" bug's exact wrong answer. A card that renders content but
// roots on the wrong node is a WORSE defect than an outright failure (it looks correct at
// a glance) — this is the pin analysis §11.4 named and no earlier test in this file
// actually wrote (every other case here asserts settle text or reachability, never the
// card's own identity). Also covers: the five REAL component names render (not
// axis-reconstructed placeholders, not raw guids) and no guid-shaped string leaks into any
// visible text on the card (std 3: the negative half of "names, not addresses").
test("remote path: scanning 3035:121084 opens a card rooted on THAT guid, titled «action sheet», with its five real component names — never a guid chip", async ({
  page,
}) => {
  await openPixsoPanel(page);

  // The prior test already saved a real, valid token into this run's shared server-side
  // storage — the Import tab opens straight to the per-scan URL step.
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();

  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(CAPTURE_ONE_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  await page.getByTestId("pixso-remote-scan-button").click();

  // SUPERSEDED PIN (universality wave W5, std 9): this used to assert a FRESH import
  // («Карточка добавлена в галерею») because the remote wire bytes hash differently
  // from the local capture's. W5's semantic identity (root guid + compatible file key,
  // CROSS-SOURCE only) now recognizes this scan as the SAME FRAME the local suite
  // already imported (debug-3, root 3035:121084) arriving via the other transport —
  // classified DUPLICATE-ENRICHED: the reimport surface renders, no second card is
  // created, and the existing card becomes the field-level union. That recognition is
  // exactly the wave's contract (`cardProvenanceUnion.test.ts` pins it at the store
  // level, both directions); asserting it here proves it reaches the real UI.
  await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("action sheet уже есть в галерее")).toBeVisible();
  // Negative (std 3): the PLAIN fresh-import message must NOT appear on the reimport.
  await expect(page.getByText("Карточка добавлена в галерею")).toHaveCount(0);

  // Open the (single, enriched) card from the gallery — the reimport surface points at
  // the existing card rather than offering a fresh-card button.
  await page.getByRole("tab", { name: "Галерея" }).click();
  // Scoped by root name AND root-size label — the SAME identity discipline this file's
  // first test uses, and the exact trap `realCaptures.ts`'s own `rootGuidOf` doc calls
  // out: the S9/S10 synthetic payloads are generated from contract tables sampled from
  // THESE captures, so the shared gallery legitimately holds OTHER cards whose text
  // contains "action sheet" (measured this run: 3 matches — 361×40 «Range Item» and
  // 361×520 synthetic cards beside the real 393×900 frame). A bare name filter
  // over-matches; name+size pins the real card. The count-1 proof is intact under the
  // size filter: a broken W5 branch would create a SECOND card with the same name and
  // the same 393×900 root, so this still fails on a dedupe regression.
  const capture = loadRealCapture("debug-3");
  const rootName = rootLayerNameOf(capture) ?? "";
  const rootSize = rootSizeLabelOf(capture) ?? "";
  expect(rootName, "debug-3 has no root layer name to identify its card by").not.toBe("");
  expect(rootSize, "debug-3 has no root size to identify its card by").not.toBe("");
  const actionSheetCards = galleryCards(page)
    .filter({ hasText: rootName })
    .filter({ hasText: rootSize });
  // ONE card — the semantic dedupe's own externally visible proof (a broken W5 branch
  // would show two: the local import's and a second remote-bytes card).
  await expect(actionSheetCards).toHaveCount(1, { timeout: 10_000 });
  await actionSheetCards.first().click();

  // ── the headline pin: title + root guid ─────────────────────────────────────
  const header = page.getByTestId("pixso-detail-header");
  await expect(header).toBeVisible();
  await expect(header).toContainText("action sheet");

  await page.getByRole("tab", { name: "Структура" }).click();
  const structure = page.getByTestId("pixso-tab-structure");
  const rootRow = structure.locator("[data-node-id]").first();
  await expect(rootRow).toHaveAttribute("data-node-id", "3035:121084");
  // THE RED CLAIM this pin exists for (std 3, negative pin): if the card ever roots back
  // on the raw file's first-listed node instead of the requested one, this must fail.
  await expect(rootRow).not.toHaveAttribute("data-node-id", "19:39374");

  // A guid-shaped string (`\d+:\d+`) rendered as visible TEXT is a leaked address, not a
  // name — distinct from `data-node-id` itself, an ATTRIBUTE `innerText()` never reads.
  const GUID_SHAPED = /\b\d{1,7}:\d{1,7}\b/;
  expect(await structure.innerText()).not.toMatch(GUID_SHAPED);

  // ── the five real component names, resolved (not axis-reconstructed, not a guid) ──
  await page.getByRole("tab", { name: "Компоненты" }).click();
  const components = page.getByTestId("pixso-tab-components");
  const usages = components.getByTestId("pixso-component-usage");
  await expect(usages).toHaveCount(5);
  for (const name of ["input_2.0", "switcher_2.0", "info panel", "moblie header", "select_2.0"]) {
    await expect(usages.filter({ hasText: name })).toHaveCount(1);
  }
  expect(await components.innerText()).not.toMatch(GUID_SHAPED);
});

// ROUND-3 (review round 3, capture-seat finding): S17/S18/S24/S25 — the whole auth-death
// lifecycle — were UNREACHABLE through the real wiring (remoteStore.ts's
// `looksLikeAuthDeath` never fired against the fake's real 401 shape). Fixed at the
// production layer (`pixsoMcpBoundary.ts`'s typed `httpStatus`, `fakeRemotePixsoMcp.ts`'s
// dead-gate now covering `tools/list` too) — this leg drives the REAL lifecycle end to
// end: a dead token scans successfully ONCE (the fake's own documented rule), dies on the
// SECOND scan, the Import tab must show the auth-death surface (not a plain failed-scan
// stepper), a recheck must NOT heal it, and only DELETE + a fresh token recovers.
test("remote path: a DEAD token reaches auth-death UI, survives a recheck, and only delete+re-add recovers", async ({
  page,
}) => {
  await openPixsoPanel(page);

  // This file's FIRST test already saved a real token into this run's SHARED server-side
  // storage (one boot serves the whole file, `test.describe.configure({mode:"serial"})`) —
  // the Import tab therefore opens VERIFIED, not onboarding, so `pixso-create-token`
  // (onboarding-only) never renders. Reach the SAME wizard through settings' REPLACE flow
  // (`pixso-settings-new-token`, S22) instead of assuming a fresh "none" state.
  await page.getByTestId("pixso-settings-toggle").click();
  await expect(page.getByTestId("pixso-settings-view")).toBeVisible();
  await page.getByTestId("pixso-settings-new-token").click();
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible();

  const deadToken = "pix_e2e_dead_lifecycle_token";
  await page.getByTestId("pixso-token-input").fill(deadToken);
  await page.getByTestId("pixso-token-check").click();
  // The wizard's OWN verify is a tools/list call BEFORE the token has ever touched
  // get_node_dsl — the fake's dead-gate must not reject this (positive control, ROUND-3's
  // own regression test for the harness pins this at the unit level too).
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();

  // The wizard closed back onto SETTINGS (that's where it was opened from this time, not
  // the Import tab) — leave settings to reach the per-scan URL step.
  // Scoped to the settings view: the panel's chat sidebar also has thread rows whose
  // accessible name can include "Назад"-adjacent text, and a bare page-level query is
  // ambiguous once real threads exist in this shared-gallery run.
  await page.getByTestId("pixso-settings-view").getByRole("button", { name: "Назад" }).click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();

  // debug-3/remote (the REAL remote wire capture, ~2 MB, CAPTURE_ONE_ITEM_ID) — this test is
  // about the auth lifecycle, not the round-tripped content, so it uses the SMALLER of the
  // two real captures.
  const designUrl = designUrlFor(CAPTURE_ONE_ITEM_ID);

  // ── first scan: the fake's dead-token rule 200s exactly once ──────────────────
  await page.getByTestId("pixso-design-url-input").fill(designUrl);
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  await page.getByTestId("pixso-remote-scan-button").click();
  // RE-PIN (quality wave S5/S6/S7, decisions 447/448; round-2 F-8 simplification).
  // UPDATED (remote-parity wave T6): `3035:121084` now serves the REAL remote wire bytes
  // (content-addressed, different hash from anything the LOCAL suite ever imports), so
  // this settle is now virtually certain to be a FRESH import, not a reimport — either way
  // both share the SAME title («Скан завершён» — the invented «Дубликат» headline is gone,
  // F-8), so a single assertion covers either state; this test's actual subject is the
  // AUTH lifecycle (the second scan below), not which of the two it lands on.
  await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });

  // ── second scan: NOW the token is dead — auth-death, not a plain failure ──────
  await page.getByRole("button", { name: "Новый скан" }).click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await page.getByTestId("pixso-design-url-input").fill(designUrl);
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  await page.getByTestId("pixso-remote-scan-button").click();

  // S17: the auth-death surface REPLACES the URL step entirely (RemoteScanSetup renders
  // it before the URL step once tokenStatus flips), never a red step in a stepper.
  const authDeath = page.getByTestId("pixso-auth-death");
  await expect(authDeath).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pixso-remote-url-step")).toHaveCount(0);

  // ── recheck must NOT heal it (ROUND-3's exact regression) ─────────────────────
  await page.getByTestId("pixso-auth-death-recheck").click();
  // S18 (verifying) is real but fast against the fake — assert the settle, not the
  // transient spinner, to avoid a race on a slow CI runner.
  await expect(authDeath).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pixso-token-verifying")).toHaveCount(0);

  // ── settings: the token card also reads dead, not verified (S24) ──────────────
  await page.getByTestId("pixso-settings-toggle").click();
  const tokenCard = page.getByTestId("pixso-token-card");
  await expect(tokenCard).toHaveAttribute("data-token-status", "dead");

  // ── delete resets the setup (S19) ──────────────────────────────────────────────
  await page.getByTestId("pixso-token-delete").click();
  await page.getByTestId("pixso-token-delete-confirm").click();
  // Scoped to the settings view: the panel's chat sidebar also has thread rows whose
  // accessible name can include "Назад"-adjacent text, and a bare page-level query is
  // ambiguous once real threads exist in this shared-gallery run.
  await page.getByTestId("pixso-settings-view").getByRole("button", { name: "Назад" }).click();
  await expect(page.getByTestId("pixso-token-reset-notice")).toBeVisible();
  await expect(page.getByTestId("pixso-remote-onboarding")).toBeVisible();

  // ── a FRESH token recovers to verified — dead does not poison the next token ───
  await page.getByTestId("pixso-create-token").click();
  await page.getByTestId("pixso-token-input").fill("pix_e2e_recovery_token");
  await page.getByTestId("pixso-token-check").click();
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
});

// B2 (round-2 blocker): the review's own reproduction proved debug block 3 (the wrench's
// live remote tools/list) was "WIRED" in name only — `apps/web`'s client had no
// `remoteToolsList` method (TS2741) and `apps/server`'s rpcHandlers.ts had no scope row or
// handler for it, so the RPC never reached the wire; `debugStore.ts`'s swallow-catch then
// hid the resulting failure completely, leaving block 3 stuck on its permanent "nothing
// fetched yet" placeholder. This leg is the "e2e or harness leg" the review named
// explicitly to close the gap PKG-level unit tests cannot reach (stub clients satisfy the
// interface but never touch `apps/server`'s wiring): it drives the REAL client → RPC →
// rpcHandlers → PixsoAssistantService.remoteToolsList → the REAL fake's `/remote-mcp`
// route, end to end, and asserts the tool ACCORDION renders all five real tool NAMES —
// not just block 2's already-covered tools/list count.
test("remote path (debug wrench): block 3's live tools/list actually lists the 5 real remote tools, end to end (B2)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("debugPixso", "true");
  });

  await openPixsoPanel(page);

  // This file's prior test ends by DELETING its token (S19) — server-side storage is
  // "no token" entering this test, so the panel opens onboarding, same as this file's
  // first test. Save a fresh token: block 3 has no token of its own, it reuses the gear
  // token (`RemoteStatusCard`'s own doc comment, `DiagnosticsView.tsx`).
  await expect(page.getByTestId("pixso-remote-onboarding")).toBeVisible();
  await page.getByTestId("pixso-create-token").click();
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible();
  await page.getByTestId("pixso-token-input").fill("pix_e2e_wrench_tools_token");
  await expect(page.getByTestId("pixso-token-check")).toBeEnabled();
  await page.getByTestId("pixso-token-check").click();
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();

  await expect(page.getByTestId("pixso-diagnostics-toggle")).toBeVisible();
  await page.getByTestId("pixso-diagnostics-toggle").click();
  const diagnostics = page.getByTestId("pixso-diagnostics-view");
  await expect(diagnostics).toBeVisible();

  // Block 1: the debug mode switch is its OWN key (T8) — flip it to remote explicitly,
  // never assume the default.
  // (These are the APP's own data-testids — `pixso-debug-*` is the DiagnosticsView
  // prefix, NOT a capture-set name; the W0 corpus rename never touches them.)
  await page.getByTestId("pixso-debug-mode-remote").click();
  await expect(diagnostics).toHaveAttribute("data-debug-mode", "remote");

  // Block 2: check against the REAL fake using the saved gear token — this is the call
  // block 3 chains off of (`debugStore.ts`'s `runRemoteCheck`). LIVE-CONTRACT MINI-WAVE
  // (decisions 453): the real remote tool count is 5 (get_local_styles added).
  await page.getByTestId("pixso-debug-remote-check").click();
  await expect(page.getByTestId("pixso-debug-status-remote")).toContainText("5", {
    timeout: 15_000,
  });

  // Block 3 (the actual B2 proof): expand the "Tools" block and assert the tool ACCORDION
  // rendered all five real tool names, from the fake's own tool registration — never the
  // permanently-empty "nothing fetched yet" placeholder B2 found live.
  await diagnostics.getByText("Инструменты", { exact: true }).click();
  for (const tool of [
    "get_local_styles",
    "get_node_dsl",
    "get_variable_sets",
    "get_variables",
    "get_variants",
  ]) {
    await expect(diagnostics.getByText(tool, { exact: true })).toBeVisible();
  }

  // REVIEWER ROUND-1 F-1 (MAJOR): block 7 — the diagnostics wrench's `remoteFullProbe`
  // — is the surface the review proved REGRESSED (5/5 "dead", args "{}") once
  // production's `runRemote` started synthesizing args FROM the fake's live
  // `tools/list` schema while the fake advertised none. THIS is the missing coverage
  // the review demanded: drive the REAL button, against the REAL running app, talking
  // to the REAL e2e fake — so a reopened gap between the fake's advertised schema and
  // its own runtime validator fails a real spec, not just a unit test against a
  // synthetic fixture. Block 7 "borrows the block-5 probe link" (DiagnosticsView.tsx's
  // own comment) — same URL field, testid `pixso-probe-url-input`.
  await page.getByTestId("pixso-probe-url-input").fill(designUrlFor(CAPTURE_ONE_ITEM_ID));
  const fullProbeButton = page.getByTestId("pixso-debug-remote-full-probe");
  await expect(fullProbeButton).toBeEnabled();
  await fullProbeButton.click();

  // Every one of the 5 rows must render OK, never DEAD — the exact regression the
  // review's "Executed proof B" reproduced (5/5 dead, `"args":"{}"`).
  for (const tool of [
    "get_local_styles",
    "get_node_dsl",
    "get_variable_sets",
    "get_variables",
    "get_variants",
  ]) {
    // `.last()`, not `.first()`: `div:has(code)` matches every ANCESTOR div too (the
    // whole diagnostics panel included) in document order outer→inner, so `.first()`
    // grabbed the outermost container (5 OK badges all inside it) — `.last()` is the
    // innermost match, the actual per-tool row.
    const row = diagnostics.locator("div", { has: page.locator(`code:text-is("${tool}")`) }).last();
    await expect(row.getByText("OK", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("DEAD", { exact: true })).toHaveCount(0);
  }
});

// T5/T6/T7 (remote-parity wave §5.5/§6.2/§11.4, decisions 456, PHASE-2b item 1): the
// access-denied class, end to end — link → scan → «Нет доступа к файлу» + both advice
// lines → «Заменить токен» → wizard re-entry. Drives the REAL reserved synthetic case
// (`9000:000014`, `fakePixsoMcp.ts`'s `RESERVED_REMOTE_ITEM_IDS`) through the REAL app,
// the REAL RPC layer and the REAL fake — never a stubbed classifier.
test("remote path: access-denied (reserved 9000:000014) shows «Нет доступа к файлу» + both advice lines, and «Заменить токен» re-enters the wizard", async ({
  page,
}) => {
  await openPixsoPanel(page);

  // This file's prior test (block 7 wrench) left a valid saved token — the Import tab
  // opens straight to the per-scan URL step, no onboarding/wizard detour needed.
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();

  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(ACCESS_DENIED_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  await page.getByTestId("pixso-remote-scan-button").click();

  // The oracle-worded literals, verbatim (std-11) — title, both recommendations, message.
  await expect(page.getByText("Нет доступа к файлу")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Проверьте, что ссылка открывается в браузере")).toBeVisible();
  await expect(page.getByText("Возможно, токен доступа устарел")).toBeVisible();
  await expect(page.getByText("Failed to verify file access permission")).toBeVisible();

  // Negative pin (std 3): this must NOT read as a link problem — the dsl-error class this
  // case pre-T5 would have fallen into.
  await expect(page.getByText("Pixso вернул ошибку по этой ссылке")).toHaveCount(0);

  // The action-as-data button — the SAME delete+wizard pair AuthDeathCard proves.
  const replaceButton = page.getByTestId("pixso-outcome-replace-token");
  await expect(replaceButton).toBeVisible();
  await replaceButton.click();

  // Wizard re-entry: the SAME dialog every other wizard-open path in this file proves.
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible({ timeout: 10_000 });
});
