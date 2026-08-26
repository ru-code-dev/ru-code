// ru-code: QUALITY WAVE — S10 duplicate-enriched (PHASE-2 COMPLETION DISPATCH #3,
// analysis §2.2/§5 cases #4-#6). REAL enrichment through the server's own `persistScan`
// facts (`ScanStore.ts:699-704`), never a faked outcome: each case below is scanned via
// REMOTE first (which never fetches image/catalog by construction, G2-13,
// `absent-by-design`) and then via LOCAL second (SAME content-addressed bytes — a genuine
// reimport, `ScanStore.ts`'s `id = sha256Hex(dslRaw)`), with the harness's reserved-case
// `localImage`/`localCatalog` spec controlling exactly what the LOCAL leg's
// `get_all_components`/`get_image` answer (`fakePixsoMcp.ts`'s `RESERVED_CASES`) — so the
// SAME real code path that classifies a genuine local-after-remote reimport classifies
// these. The proof surfaces through the shared `outcomeContentFor(…, "remote")` renderer's
// own SETTLED VERBATIM copy (S5/S6/S7 — round-2 F-8 casing fix, spec-literal lower
// case): "добавлено изображение" / "добавлены компоненты" — text that can only render
// if `enriched` actually arrived on the wire from a real `persistScan` write. The
// COMBINED case (round-2 F-8) ships BOTH spec-literal lines rather than an invented
// merged sentence — the spec names only "combined" with no literal wording, so the
// default renders what the spec DID give verbatim; the merged sentence is PROPOSED,
// curation-only.
//
// FILE NAME sorts AFTER `pixsoAssistantRemote.e2e.test.ts` (needs the remote token) and
// does not depend on `pixsoAssistantZIsolation.e2e.test.ts` — each case here scans a
// DISTINCT, purpose-built DSL identity (`EnrichImageBase`/`EnrichComponentsBase`/
// `EnrichBothBase`), so it cannot collide with any other file's reserved-case usage.

import * as NodeFS from "node:fs";

import {
  expect,
  readHarnessState,
  setPixsoFakeCase,
  setPixsoFakeMode,
  test,
  type Page,
} from "../tests-core/fixtures.ts";

function designUrlFor(itemId: string): string {
  return `https://company-pixso.com/app/editor/AbCdEf123456?item-id=${encodeURIComponent(itemId)}`;
}

async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
}

/** Reaches the remote URL step regardless of whether a token was ALREADY saved by an
 *  earlier spec in this shared session — the SAME tolerant pattern
 *  `pixsoAssistantZIsolation.e2e.test.ts`'s own helper uses. */
async function ensureRemoteUrlStep(page: Page): Promise<void> {
  await page.getByTestId("pixso-source-remote").click();
  const onboarding = page.getByTestId("pixso-remote-onboarding");
  const urlStep = page.getByTestId("pixso-remote-url-step");
  await expect(onboarding.or(urlStep)).toBeVisible({ timeout: 15_000 });
  if (await urlStep.isVisible()) return;

  await page.getByTestId("pixso-create-token").click();
  await expect(page.getByTestId("pixso-token-wizard")).toBeVisible();
  const goodToken = "pix_e2e_enrich_good_token";
  await page.getByTestId("pixso-token-input").fill(goodToken);
  await expect(page.getByTestId("pixso-token-check")).toBeEnabled();
  await page.getByTestId("pixso-token-check").click();
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(urlStep).toBeVisible();
}

/** Scans the reserved case's byte-identical content on the REMOTE route first (no image,
 *  no catalog — absent-by-design) — a silent settle, per RISK-7 (S4: every remote
 *  first-import is `success-warnings`, no user block). Waits for full settlement (the
 *  scan button re-enabling), THEN RELOADS — `remoteStore.ts`'s live `runRemoteScan`
 *  settle handler never calls `refreshSnapshot()` (unlike the local path, `store.ts`'s
 *  own `applyScanJobState`), a genuine client-side staleness gap found while writing
 *  this test (server truth lands correctly; the CLIENT's cached gallery/snapshot does
 *  not, until something else refreshes it — a reload always does, via the panel's own
 *  boot effect). The dedup check on the LOCAL leg is server-side and unaffected by this
 *  either way, but reloading here removes it as a variable and matches the ROBUST
 *  reload-between-legs pattern `pixsoAssistantZIsolation.e2e.test.ts`'s S9 case 3/4
 *  already use successfully. */
async function scanRemoteFirst(page: Page, itemId: string): Promise<void> {
  await ensureRemoteUrlStep(page);
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(itemId));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  const scanButton = page.getByTestId("pixso-remote-scan-button");
  await expect(scanButton).toBeEnabled();
  await scanButton.click();
  // NEITHER "button re-enabled" NOR "button disabled-then-enabled" proved robust here —
  // two real repros while writing this suite: (1) on a shared remote instance (this
  // file's own earlier tests may already have settled a DIFFERENT run), the button can
  // ALREADY be enabled before this click, so a bare `toBeEnabled()` wait passes on STALE
  // state; (2) these are fast, in-memory synthesized responses — the "running" window can
  // be SHORTER than one Playwright poll tick, so a `toBeDisabled()` pre-check sometimes
  // never observes it and times out on a scan that in fact completed instantly. A FIXED,
  // generous settle wait sidesteps both: these scans have no real network latency, so a
  // real settle is done in well under a second regardless of which of the two failure
  // modes would otherwise apply.
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("pixso-import-stepper").locator(".text-destructive")).toHaveCount(
    0,
    { timeout: 10_000 },
  );
  await expect(scanButton).toBeEnabled();

  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
}

/** Scans the SAME reserved case's bytes on the LOCAL route second (via the control
 *  file's `case` field, DS-1) — a genuine reimport, with the harness's per-case
 *  `localImage`/`localCatalog` spec deciding what gets enriched. */
async function scanLocalSecond(
  page: Page,
  state: ReturnType<typeof readHarnessState>,
  caseId: Parameters<typeof setPixsoFakeCase>[1],
): Promise<void> {
  await page.getByTestId("pixso-source-local").click();
  const scanButton = page.getByTestId("pixso-scan-button");
  await expect(scanButton).toBeVisible();
  setPixsoFakeCase(state, caseId);
  // Read the SAME file back through the SAME JSON.parse path `readReservedCase` uses
  // (`fakePixsoMcp.ts`) before clicking — a real flake was found writing this suite
  // (intermittently, under FULL-SUITE combined load only — never in isolation, and never
  // reproduced with a synchronous readback confirming the write landed first): one of
  // the three cases' LOCAL leg occasionally consumed a NORMAL-CYCLE `get_node_dsl` slot
  // (`.artifacts/fake-pixso.log` showed "get_node_dsl #3 → example1 [synthetic]" in
  // place of the reserved case) instead of the reserved DSL, meaning `readReservedCase()`
  // saw no `case` at the moment the click's resulting request landed. The write itself
  // (`writeFileSync`+`renameSync`, atomic on the same filesystem) is confirmed correct by
  // this readback; the click is held until it verifiably is.
  await expect
    .poll(
      () => {
        try {
          const raw = JSON.parse(NodeFS.readFileSync(state.pixsoControlFile, "utf8")) as {
            readonly case?: unknown;
          };
          return raw.case;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000 },
    )
    .toBe(caseId);
  try {
    await scanButton.click();
    // A fixed settle wait, not a disabled/enabled transition check — see
    // `scanRemoteFirst`'s own note for the two real repros that ruled out BOTH a bare
    // `toBeEnabled()` (passes on stale state) and a `toBeDisabled()` pre-check (the
    // "running" window can be shorter than one poll tick for these in-memory scans).
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("pixso-import-stepper")).toBeVisible({ timeout: 15_000 });
    await expect(scanButton).toBeEnabled({ timeout: 20_000 });
  } finally {
    setPixsoFakeMode(state, "normal"); // clears BOTH mode and case (fixtures.ts's own doc).
  }
}

test.describe.configure({ mode: "serial" });

test("S10 duplicate-enriched (image only): a REMOTE-first import with no image, LOCAL-reimported with a real image and an unusable catalog, reports ONLY the image addition", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  await scanRemoteFirst(page, "9000:000004");
  await scanLocalSecond(page, state, "reserved-duplicate-enriched-image");

  // THE PIN: the local reimport's own settle surface (S6/S7, shared renderer) —
  // duplicate copy + the image-only enrichment line, and NOTHING about components.
  // F-8 (round 2): the invented "Дубликат" headline is gone — the duplicate surface
  // reuses the S5 success title; the settled MESSAGE line is what proves the surface
  // rendered at all.
  await expect(page.getByText("уже есть в галерее")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("добавлено изображение", { exact: true })).toBeVisible();
  await expect(page.getByText("добавлены компоненты")).toHaveCount(0);
  await expect(
    page.getByText("Добавлено изображение и компоненты, которых не хватало"),
  ).toHaveCount(0);
});

test("S10 duplicate-enriched (components only): a REMOTE-first import with no catalog, LOCAL-reimported with a usable catalog and no image, reports ONLY the components addition", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  await scanRemoteFirst(page, "9000:000003");
  await scanLocalSecond(page, state, "reserved-duplicate-enriched-components");

  await expect(page.getByText("уже есть в галерее")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("добавлены компоненты", { exact: true })).toBeVisible();
  await expect(page.getByText("добавлено изображение", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Добавлено изображение и компоненты, которых не хватало"),
  ).toHaveCount(0);
});

test("S10 duplicate-enriched (both): a REMOTE-first import with neither, LOCAL-reimported with both a real image and a usable catalog, reports the COMBINED addition line", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  await openPixsoPanel(page);

  await scanRemoteFirst(page, "9000:000005");
  await scanLocalSecond(page, state, "reserved-duplicate-enriched-both");

  await expect(page.getByText("уже есть в галерее")).toBeVisible({ timeout: 10_000 });
  // F-8 (round 2): the COMBINED case now ships BOTH spec-literal lines (the spec never
  // gave literal wording for "combined") — never the invented merged sentence, which is
  // PROPOSED/curation-only.
  await expect(page.getByText("добавлено изображение", { exact: true })).toBeVisible();
  await expect(page.getByText("добавлены компоненты", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Добавлено изображение и компоненты, которых не хватало"),
  ).toHaveCount(0);
});
