// ru-code: the Pixso MCP assistant, end to end in a real browser against a real MCP
// server (harness/fakePixsoMcp.ts on the hardcoded 127.0.0.1:3667). Nothing here is
// stubbed inside the app: the panel dials the real server, the server dials the fake
// plugin, and the payloads are the synthesized contract-table replays.
//
// The cases exist because they are the ONLY way to see these mechanisms at all — build,
// typecheck and lint are blind to every one of them (production-gap item 15):
//   · a scan actually landing a card, three distinct scans → three distinct cards;
//   · the detail card's seven tabs rendering real decoded DATA — not their chrome;
//   · E-W8 — the rewritten catalog scroller keeping the mounted row count bounded while
//     the window moves over the whole catalog;
//   · H-L13 — a dnd-kit gallery drag filing a card into a group AND the grouping
//     surviving a full reload (the failure mode is a silent no-op);
//   · E-W1 — the REAL forced failure text reaching the UI;
//   · D-A2 — a panel mounted before the environment connection still receives scan state
//     AND still fills its gallery.
//
// ASSERTION DISCIPLINE. Every «is it there» must be about data the fake produced. A tab
// title, a block header and an empty-state paragraph all render with zero rows behind
// them, so asserting those proves the tab mounted and nothing more — the vacuity this
// file was rewritten to remove. Where a data row carried no stable hook the package grew
// a `data-testid` (pixso-style-color, pixso-analytics-kind, pixso-qa-case).
//
// The fake is instant, so a slow assertion means a wrong selector or a real defect —
// never paper one over with a wait.
import {
  catalogComponentCount,
  CATALOG_ENTRY_COUNT,
  DSL_CYCLE_LENGTH,
  FORCED_DSL_ERROR,
  REAL_CAPTURE_SETS,
} from "../harness/fakePixsoMcp.ts";
import {
  expectedAxisSetName,
  expectedTextsOf,
  loadRealCapture,
  realCaptureImage,
  rootGuidOf,
  rootLayerNameOf,
  rootSizeLabelOf,
} from "../harness/pixsoExpectations.ts";

import {
  expect,
  readHarnessState,
  setPixsoFakeMode,
  test,
  type Page,
} from "../tests-core/fixtures.ts";

/**
 * E-W8: whatever the window is, it must never approach the full catalog. Rows are now
 * MEASURED and variable-height (a collapsed card is ~52 px, an expanded one much taller),
 * so the window is «viewport ÷ the shortest row + 2×8 overscan» rather than a fixed
 * count — ≈35 rows over this panel. 60 still absorbs a viewport that grows, while an
 * unwindowed regression (626 components mounted at once) fails by an order of magnitude.
 */
const MOUNTED_ROW_CEILING = 60;

/** The Промпт tab's own chrome — both section headers, the two explanatory paragraphs,
 *  the option labels and the char counter — measures ~350 characters with an EMPTY
 *  payload. The old `> 40` was below even that; this sits well above it. */
const PROMPT_CHROME_CEILING = 2_000;

// One app, one server-side gallery: the cases build on each other in order.
test.describe.configure({ mode: "serial" });

/**
 * SUPERSEDED PIN (task 18/G3, decisions 429c, RULES 4.1/test-standards #9): the Import
 * tab's default source flipped to "remote" (row 428 #2) — this whole file's every
 * assertion is about the LOCAL flow, so it force-selects "Локально" the instant the panel
 * opens, once per fresh page load (the switch is pure client state, reset by
 * `page.goto`). Re-expressed here rather than at every call site: every test in this file
 * already calls `openPixsoPanel` first, so this is the ONE place the local-mode
 * precondition needs stating.
 */
async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  // The composer is the app's own "SPA booted + environment connected" signal (smoke).
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
}

/** The panel's own root: the app renders role=alert banners of its own, and the gallery
 *  drain signal (`data-pixso-syncing`) is stamped here. */
function panelRoot(page: Page) {
  return page.getByTestId("pixso-panel-root");
}

/**
 * Run one scan and wait for the job to settle (the button re-enables on settle).
 *
 * The click is NOT optimistic — the button disables only when the SERVER-owned job
 * answers `running`, and re-enables when it settles. Returning without waiting for that
 * disabled edge makes this a broken boundary: a caller looping over runScan fires the next
 * click while the previous start is still in flight, the idempotent start folds the two
 * into one run, and the loop quietly produces one card fewer than it asked for.
 *
 * The edge is OBSERVED, not sampled. A normal scan holds the button disabled for ~1 s, but
 * a forced-failure scan settles in milliseconds — far inside any polling interval — so a
 * `toBeDisabled` poll reports "never disabled" for a run that ran perfectly. A mutation
 * observer armed before the click catches the transition whatever its duration.
 */
async function runScan(page: Page): Promise<void> {
  const scan = page.getByTestId("pixso-scan-button");
  await expect(scan).toBeEnabled();
  await scan.evaluate((button) => {
    const flags = window as unknown as { __pixsoScanStarted?: boolean };
    flags.__pixsoScanStarted = false;
    const isDisabled = () =>
      (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";
    // React mutates the attribute on the SAME node (same element type, same position), so
    // the observer armed here survives the re-render that disables the button.
    new MutationObserver(() => {
      if (isDisabled()) flags.__pixsoScanStarted = true;
    }).observe(button, { attributes: true });
  });
  await scan.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __pixsoScanStarted?: boolean }).__pixsoScanStarted === true,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(page.getByTestId("pixso-import-stepper")).toBeVisible();
  await expect(scan).toBeEnabled({ timeout: 45_000 });
}

async function openGallery(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Галерея" }).click();
}

/** Wait until every optimistic gallery edit has been ACKNOWLEDGED by the server. The edit
 *  is on screen the instant it is made, so without this gate a reload can outrun the
 *  persistence RPC and «it survived» would be racing the write, not proving it. */
async function awaitGalleryPersisted(page: Page): Promise<void> {
  await expect(panelRoot(page)).toHaveAttribute("data-pixso-syncing", "false");
}

/**
 * The gallery's REAL cards. `pixso-card` alone would over-count: the grid's row-height
 * authority (CardMeasureProbe) renders one more card in a zero-height clipped box, and
 * the DragOverlay renders another while a drag is in flight — both outside any section.
 */
function galleryCards(page: Page) {
  return page.getByTestId("pixso-group-section").getByTestId("pixso-card");
}

test("three scans import three distinct cards", async ({ page }) => {
  await openPixsoPanel(page);

  // The Import tab is the default view — one big scan action, no cards yet.
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();

  // The fake answers example1 → example2 → example3 on successive calls, so each scan
  // is a genuinely different selection and the server's content-hash dedupe lets all
  // three through.
  for (let index = 0; index < 3; index += 1) {
    await runScan(page);
  }

  await openGallery(page);
  await expect(galleryCards(page)).toHaveCount(3);
});

test("the detail card renders all seven tabs over real decoded data", async ({ page }) => {
  await openPixsoPanel(page);
  await openGallery(page);

  // Cards are listed in scan order, so the first one is the FIRST payload's (example1) —
  // which is what every count below is pinned against.
  await galleryCards(page).first().click();

  // 1 — Обзор: the ALGORITHMIC preview. It must be the real <img> carrying the rendered
  // SVG as a data URI: `getByRole("img")` is also satisfied by the lucide icon of the
  // "image unavailable" branch, i.e. by the preview having FAILED.
  const overview = page.getByTestId("pixso-tab-overview");
  await expect(overview).toBeVisible();
  await expect(overview.locator('img[src^="data:image/svg+xml"]').first()).toBeVisible();
  // …and THIS card has no `get_image` screenshot (the fake only synthesizes one for the
  // real captures, whose dumps record the dimensions), so the source toggle must not exist
  // at all. The no-image path is the old behaviour, unchanged.
  await expect(overview.getByTestId("pixso-preview-source")).toHaveCount(0);

  // The detail header names the card, its size and its DSL version — and NOT the 64-hex
  // scan hash, which used to be printed in full on the line under the name. It survives as
  // the dimensions line's `title`, one hover away, which is where an address belongs.
  const header = page.getByTestId("pixso-detail-header");
  await expect(header).toBeVisible();
  expect(await header.innerText()).not.toMatch(/[0-9a-f]{64}/i);
  await expect(header.locator("[title^='id ']")).toHaveAttribute("title", /^id [0-9a-f]{64}$/i);

  // 2 — Структура: the layers tree, one row per decoded node.
  await page.getByRole("tab", { name: "Структура" }).click();
  const structure = page.getByTestId("pixso-tab-structure");
  await expect(structure).toBeVisible();
  const layerRows = structure.locator("[data-node-id]");
  await expect(layerRows.first()).toBeVisible();
  expect(await layerRows.count()).toBeGreaterThan(2);

  // 3 — Стили: the palette the scan precomputed. «Цвета»/«Шрифты» are unconditional block
  // TITLES — they render with count 0 — so the assertion is on the color ROWS. (This
  // selection carries no font records at all, which is exactly why «Шрифты» is not
  // asserted: it would be an assertion about an empty block again.)
  await page.getByRole("tab", { name: "Стили" }).click();
  const styles = page.getByTestId("pixso-tab-styles");
  await expect(styles).toBeVisible();
  const colorRows = styles.getByTestId("pixso-style-color");
  await expect(colorRows.first()).toBeVisible();
  expect(await colorRows.count()).toBeGreaterThan(0);

  // 4 — Компоненты: the DSL⇄catalog join, BOTH outcomes at once. The fake correlates every
  // instance key to a catalog entry except one deliberate hold-out (see HOLD-OUT in
  // harness/fakePixsoMcp.ts), so this card's three component rows are 2 resolved plus
  // exactly 1 carrying the unresolved badge. A join that resolves everything and a join
  // that resolves nothing are both failures here.
  await page.getByRole("tab", { name: "Компоненты" }).click();
  const components = page.getByTestId("pixso-tab-components");
  await expect(components).toBeVisible();
  await expect(components.getByTestId("pixso-component-usage")).toHaveCount(3);
  await expect(components.getByTestId("pixso-component-unresolved")).toHaveCount(1);

  // 5 — QA: cases GENERATED from the DSL. The «violations» group opens by default, so its
  // rows are mounted; the counter reports the whole generated set.
  await page.getByRole("tab", { name: "QA" }).click();
  const qa = page.getByTestId("pixso-tab-qa");
  await expect(qa).toBeVisible();
  await expect(qa.getByTestId("pixso-qa-case").first()).toBeVisible();
  await expect(qa.getByTestId("pixso-qa-case-count")).toHaveText(/[1-9]\d* кейсов/);

  // 6 — Аналитика: the per-kind node breakdown. «Слои по видам» is an unconditional block
  // TITLE and the block is collapsed by default — open it and assert the rows, each a
  // decoded kind with a non-zero tally.
  await page.getByRole("tab", { name: "Аналитика" }).click();
  const analytics = page.getByTestId("pixso-tab-analytics");
  await expect(analytics).toBeVisible();
  await analytics.getByText("Слои по видам").click();
  const kindRows = analytics.getByTestId("pixso-analytics-kind");
  await expect(kindRows.first()).toBeVisible();
  expect(await kindRows.count()).toBeGreaterThan(1);
  await expect(kindRows.first()).toHaveText(/×[1-9]/);

  // 7 — Промпт: exactly what the model would receive. The markers are STRUCTURAL parts of
  // the generated payload — the collapsed component instances and the CSS section header —
  // which no amount of panel chrome can produce.
  await page.getByRole("tab", { name: "Промпт" }).click();
  const prompt = page.getByTestId("pixso-tab-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("<Component name=");
  await expect(prompt).toContainText("## SCREEN — CSS");
  expect((await prompt.innerText()).length).toBeGreaterThan(PROMPT_CHROME_CEILING);
});

test("the catalog view windows the whole catalog (E-W8)", async ({ page }) => {
  await openPixsoPanel(page);
  await openGallery(page);
  await galleryCards(page).first().click();
  await page.getByRole("tab", { name: "Компоненты" }).click();

  // The catalog tier is fetched ONLY when «Каталог» opens (§8.4) — until then the toggle
  // has no count to show. Both the toggle label and the footer report the same total, and
  // that total is a COMPONENT count: a set of variants is ONE component (owner rule), so
  // the 4648 catalogue ENTRIES the fake serves are 626 components. The expected number is
  // derived by running the app's own chain over the fake's own payload
  // (`catalogComponentCount`, harness) — never written down here.
  const catalogToggle = page.getByTestId("pixso-components-view-catalog");
  await expect(catalogToggle).toHaveText("Каталог");
  await catalogToggle.click();

  const components = catalogComponentCount();
  expect(components).toBeGreaterThan(0);
  expect(components).toBeLessThan(CATALOG_ENTRY_COUNT);

  const count = page.getByTestId("pixso-catalog-count");
  await expect(count).toContainText(String(components), { timeout: 30_000 });
  // …and it is not the entry count wearing the word «компонентов». Both surfaces are
  // pinned: the toggle above the panel used to print `entries.length` while the panel's
  // own footer counted components, one line apart.
  await expect(count).not.toContainText(String(CATALOG_ENTRY_COUNT));
  await expect(catalogToggle).toContainText(String(components));
  await expect(catalogToggle).not.toContainText(String(CATALOG_ENTRY_COUNT));

  // One mounted element per WINDOWED ROW, whichever kind it renders: `pixso-catalog-row`
  // is now only the SINGLETON card (a component set renders `pixso-catalog-set-card`), so
  // counting it would count a subset of the window and understate an unwindowed
  // regression. `MeasuredRow` — the wrapper that reports its natural height back to the
  // offset table — is exactly one per mounted row and is what the bound is about.
  const rows = page.getByTestId("pixso-catalog-measured-row");
  await expect(rows.first()).toBeVisible();
  const mountedBefore = await rows.count();
  expect(mountedBefore).toBeGreaterThan(0);
  expect(mountedBefore).toBeLessThan(MOUNTED_ROW_CEILING);

  const firstBefore = await rows.first().innerText();

  // Scroll the shared viewport (the grid's own scroll container) deep into the list.
  // The offset scale is no longer «rows × 52 px» — heights are measured, so the target is
  // read off the scrolled element itself (half its own scrollable height) instead of the
  // literal 40 000 that used to stand for «deep». `applied` proves the scroll actually
  // happened: a container that cannot scroll would silently keep the window where it was.
  const grid = page.getByTestId("pixso-catalog-grid");
  const applied = await grid.evaluate((element) => {
    const viewport = element.parentElement;
    if (viewport === null) return 0;
    viewport.scrollTop = Math.floor(viewport.scrollHeight / 2);
    return viewport.scrollTop;
  });
  expect(applied).toBeGreaterThan(1_000);

  // The window MOVED (different first row) and stayed bounded — that is the whole claim.
  await expect
    .poll(async () => (await rows.first().innerText()) !== firstBefore, { timeout: 15_000 })
    .toBe(true);
  const mountedAfter = await rows.count();
  expect(mountedAfter).toBeGreaterThan(0);
  expect(mountedAfter).toBeLessThan(MOUNTED_ROW_CEILING);
});

test("a card dragged into a group is filed there and survives a reload (H-L13)", async ({
  page,
}) => {
  await openPixsoPanel(page);
  await openGallery(page);

  // A fresh, empty group — its empty-state body is the drop target.
  const groupName = `E2E ${String(Date.now())}`;
  await page.getByTestId("pixso-new-group-button").click();
  await page.getByTestId("pixso-new-group-name").fill(groupName);
  await page.getByTestId("pixso-new-group-create").click();
  // The dialog's backdrop covers the whole panel and outlives the click by one exit
  // animation. Pressing before it is gone puts pointerdown on the BACKDROP, the card
  // never sees it, and the drag silently never arms — proven with an event trace.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Creating the group is optimistic too — let it reach the server before anything here
  // depends on the server knowing about it.
  await awaitGalleryPersisted(page);

  const group = page.getByTestId("pixso-group-section").filter({ hasText: groupName }).first();
  await expect(group).toBeVisible();
  await expect(group.getByTestId("pixso-group-dropzone")).toBeVisible();

  // The card to file — the new group is empty, so the first real card is an unsorted one.
  // Remember its name so the reload assertion is about THIS card.
  const card = galleryCards(page).first();
  await expect(card).toBeVisible();
  const cardName = (await card.innerText()).split("\n")[0] ?? "";
  expect(cardName.length).toBeGreaterThan(0);

  const dropzone = group.getByTestId("pixso-group-dropzone");
  // Actionability gate: hovering only succeeds once the card is stable AND actually
  // receives pointer events — the press below cannot land on anything else.
  await card.hover();
  const from = await card.boundingBox();
  expect(from).not.toBeNull();

  // Every gallery card element, INCLUDING the measure probe — while a drag is armed
  // dnd-kit mounts one more (the DragOverlay clone), which is the cheapest true signal
  // that the press became a drag rather than a click.
  const everyCardElement = page.getByTestId("pixso-card");
  const idleCardElements = await everyCardElement.count();

  // dnd-kit's PointerSensor arms after 4px of movement, so the press must be followed by
  // real intermediate moves — a single jump to the target never starts a drag. Grab the
  // card by its lower half: the ⋯ menu in the top-right stops pointerdown propagation.
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 12, from!.y + from!.height * 0.75 + 12, {
    steps: 6,
  });
  await expect(everyCardElement).toHaveCount(idleCardElements + 1);

  // Re-measure AFTER the drag armed: dragging re-renders every section (drop-target
  // outlines, and an empty «Неразобранное» is added to the list), so a box measured
  // before the press can point at the wrong row by the time the pointer gets there.
  const to = await dropzone.boundingBox();
  expect(to).not.toBeNull();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 20 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2 + 1);
  // The section reports the pointer is over it — the drop will land here, not nowhere.
  await expect(dropzone).toContainText("Отпустите здесь");
  await page.mouse.up();

  // Filed: the group now holds exactly this card.
  await expect(group.getByTestId("pixso-card")).toHaveCount(1);
  await expect(group.getByTestId("pixso-card").first()).toContainText(cardName);

  // …and the grouping is SERVER state, not a client illusion: a full reload rebuilds the
  // gallery from the persisted snapshot. The drain gate is what makes this a PROOF —
  // reloading while the move is still on the wire would assert against a snapshot that
  // legitimately predates it, and the case would be reporting a race, not persistence.
  await awaitGalleryPersisted(page);
  await openPixsoPanel(page);
  await openGallery(page);
  const groupAfterReload = page
    .getByTestId("pixso-group-section")
    .filter({ hasText: groupName })
    .first();
  await expect(groupAfterReload).toBeVisible();
  await expect(groupAfterReload.getByTestId("pixso-card")).toHaveCount(1);
  await expect(groupAfterReload.getByTestId("pixso-card").first()).toContainText(cardName);
});

// SUPERSEDED PIN (reorg wave T4, decisions 438/442, RULES 4.1/test-standards #9): the
// 429(f)-era pin above asserted the debug gate was GONE. T4 RESTORES it, under a NEW key
// (`debugStore.ts`'s `DEBUG_GATE_STORAGE_KEY = "debugPixso"`, not the old `pixsoDebug`)
// and fails CLOSED — `PixsoAssistantPanel.tsx`'s wrench toggle only renders inside
// `isDebugGateOpen() ? … : null`. This spec must therefore set the flag itself (a real
// e2e run has no owner sitting at devtools setting it by hand) — `page.addInitScript`
// writes it into `localStorage` BEFORE the app's own JS runs on the next navigation,
// scoped to THIS test only (every sibling test in the file keeps the gate closed, the
// realistic default). Re-expressed as the true CURRENT contract: present WITH the flag —
// the mirror-image PKG-side pin (`webRender.test.tsx`'s "the diagnostics wrench is GATED
// again") already covers "absent without it" at the unit level, so this e2e spec need not
// re-prove that half through a full browser boot.
test("diagnostics is reachable once debugPixso is set, and a forced tool failure reaches the UI (E-W1)", async ({
  page,
}) => {
  const state = readHarnessState();
  await page.addInitScript(() => {
    window.localStorage.setItem("debugPixso", "true");
  });

  await openPixsoPanel(page);
  await expect(page.getByTestId("pixso-diagnostics-toggle")).toBeVisible();

  // Diagnostics opens on the real connection panel (read-only endpoint + tools/list).
  await page.getByTestId("pixso-diagnostics-toggle").click();
  const diagnostics = page.getByTestId("pixso-diagnostics-view");
  await expect(diagnostics).toBeVisible();
  // The endpoint is shown read-only in an input (internal constant, never configurable).
  // T10: this is now `state.pixsoEndpoint`'s LIVE value (`/local-mcp`, not `/mcp`) — read
  // from the harness state rather than a literal, so this assertion tracks the constant.
  await expect(diagnostics.getByRole("textbox").first()).toHaveValue(state.pixsoEndpoint);
  await expect(diagnostics.getByTestId("pixso-debug-rescan")).toBeVisible();
  await page.getByTestId("pixso-diagnostics-toggle").click();

  // A DEAD plugin (sockets destroyed unanswered) is a TRANSPORT failure, and the panel
  // must classify it as such: the mcp-down branch is the only one whose advice mentions
  // the port. Classification keys on the failure ORIGIN, never on message text (B-J5).
  // Scoped to the panel — role=alert is the app's own banner role too, and an unscoped
  // `.first()` can end up reporting on somebody else's notice entirely.
  setPixsoFakeMode(state, "down");
  try {
    await runScan(page);
    await expect(panelRoot(page).getByRole("alert").first()).toContainText("3667");
  } finally {
    setPixsoFakeMode(state, "normal");
  }

  // Force the plugin to answer get_node_dsl with an error and scan: the run settles
  // `dsl-error` and the outcome block must carry the SERVER's own message verbatim.
  setPixsoFakeMode(state, "dsl-error");
  try {
    await runScan(page);
    await expect(page.getByTestId("pixso-outcome-message")).toContainText(FORCED_DSL_ERROR);
  } finally {
    setPixsoFakeMode(state, "normal");
  }

  // No card was created by the failed run.
  await openGallery(page);
  await expect(galleryCards(page)).toHaveCount(3);
});

test("an early-mounted panel recovers both boot tiers — subscription and gallery (D-A2)", async ({
  page,
}) => {
  // This case now walks the WHOLE DSL cycle, and the cycle's tail is the real captures —
  // one of which is a 10 MB document whose scan (parse + instance expansion + a 5 541-entry
  // catalogue join) is seconds rather than milliseconds. The default 120 s budget is a
  // per-case guard against a hang, not a performance claim; a real corpus needs more of it.
  test.setTimeout(360_000);
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  // Deliberately do NOT wait for the composer (the app's connected signal): open the panel
  // as early as the nav button exists.
  //
  // The TITLE is what this pins, and it is deliberately not «mounted before the
  // connection»: nothing observable reports «the primary environment was still null when
  // the panel mounted» — the app exposes no deterministic control over connection
  // registration, and on a warm boot it usually lands before the click does. That
  // precondition is unpinnable from the outside, so naming it would make a case that
  // passes without ever entering the state it claims. What IS pinned is the RECOVERY an
  // early mount depends on, on both tiers the panel boots: the scan subscription is
  // reactive (a settled state still arrives, and a new run still replaces it), and the
  // gallery still fills — the snapshot half's failure mode is permanent skeletons, the
  // defect two audits found on exactly this path.
  const nav = page.getByRole("button", { name: "Pixso", exact: true });
  await nav.waitFor({ state: "attached", timeout: 30_000 });
  await nav.click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
  // SUPERSEDED PIN (task 18/G3, decisions 429c) — same fix as `openPixsoPanel`, restated
  // here because this test deliberately bypasses that helper (early-mount, no composer
  // wait). Pure client state, so it takes effect the instant the switch is on screen.
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();

  // The previous case left the last settled run on the forced failure; the subscription
  // replays it into the freshly mounted panel.
  const outcome = page.getByTestId("pixso-outcome-message");
  await expect(outcome).toContainText(FORCED_DSL_ERROR, { timeout: 30_000 });

  // Snapshot half: whether the mount's own fetch won the race or the subscription's first
  // event redid it after a failure, the cards are on screen.
  await openGallery(page);
  await expect(galleryCards(page)).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("tab", { name: "Импорт" }).click();

  // The fake's DSL cycle is `DSL_CYCLE_LENGTH` payloads long — example1→2→3, the two
  // hand-built cards, then one entry per REAL capture set this machine holds — and only the
  // first three were ever consumed (the "three scans" case, above; every later scan in this
  // file forced a failure, which never advances the cursor). Burn the rest of the cycle,
  // each a genuinely NEW distinct selection: `success`, not `reimport` — that renders no
  // outcome block at all (`outcomeContentFor`), so nothing is asserted about them beyond
  // "the scan settles" (runScan already waits for that).
  //
  // The loop bound is DERIVED, not written down. It used to be the literal 2 that made the
  // five-payload cycle wrap, which pinned this case to a cycle length that the real-capture
  // entries changed — and a wrong bound here does not fail loudly, it makes the assertion
  // below silently about a `success` run instead of the `reimport` it is named for.
  for (let index = 3; index < DSL_CYCLE_LENGTH; index += 1) {
    await runScan(page);
  }

  // A new run must REPLACE the replayed outcome — the settled state only ever arrives over
  // the subscription, so a changed outcome message is proof the binding is live. The
  // cursor has now wrapped back to the first payload, so THIS run settles `reimport`,
  // which DOES render an outcome block: assert the block is there before asserting what it
  // no longer says. A `success` renders no block at all, and a bare `.not.toContainText`
  // against a missing element burns the whole timeout to report «element not found»
  // instead of the change that actually failed.
  await runScan(page);
  await expect(outcome).toBeVisible();
  await expect(outcome).not.toContainText(FORCED_DSL_ERROR);

  // …and every payload of the cycle really did land: one distinct card each — EXCEPT that
  // "each" is no longer `DSL_CYCLE_LENGTH` (WAVE B root-cause, 2026-08-15, replacing an
  // earlier same-session guess that widening this assertion's timeout would fix a race —
  // it did not: the count was STABLE at one short of `DSL_CYCLE_LENGTH` across the whole
  // wait window, never fluctuating, which is the signature of a deterministic shortfall,
  // not a timing race). Root cause: `debug-6` was onboarded (decisions 467/468) as a
  // genuine re-capture of `debug-2`'s exact real node — same root guid
  // (`fakeRemotePixsoMcp.test.ts`'s own collision proof, wave B). This app's OWN
  // duplicate-detection (S10, decision 460 — "cross-source identity ⇒ DUPLICATE-ENRICHED
  // union card") correctly recognizes the SECOND scan of that guid as the SAME design and
  // enriches the existing card rather than adding a new gallery entry — a real, INTENDED
  // feature interacting with a real corpus fact this test's pin (written before `debug-6`
  // existed) never accounted for. The expected count is DERIVED here, never hand-written,
  // so a future corpus change (another shared-guid re-capture, or its removal) updates
  // this test with zero edits: `DSL_CYCLE_LENGTH` minus how many of `REAL_CAPTURE_SETS`'
  // OWN root guids are NOT first-seen in the set (i.e. collide with an earlier one).
  const seenGuids = new Set<string>();
  let duplicateGuidCount = 0;
  for (const set of REAL_CAPTURE_SETS) {
    const guid = rootGuidOf(loadRealCapture(set));
    if (guid === null) continue;
    if (seenGuids.has(guid)) duplicateGuidCount += 1;
    else seenGuids.add(guid);
  }
  const expectedDistinctCards = DSL_CYCLE_LENGTH - duplicateGuidCount;
  await openGallery(page);
  await expect(galleryCards(page)).toHaveCount(expectedDistinctCards, { timeout: 30_000 });
});

// ── the REAL captures ─────────────────────────────────────────────────────────────────
//
// Everything above drives synthesized payloads. They exercise the pipeline, but not one of
// them is something Pixso produced, so none of them could ever show that the app renders a
// REAL selection: real component names, real Cyrillic copy, a real 10 MB document. These
// cases do, against the machine-local corpus the fake now serves last in its cycle
// (harness/realCaptures.ts). The previous case walked the whole cycle, so the cards are
// already in the gallery.
//
// NOTHING IS HARD-CODED FROM A DUMP. Every expected string is read out of the capture file
// at run time. A literal copied out of a dump would leak raw evidence into the repository
// (ratified: it stays out) and would rot the moment the owner drops in a third capture.
//
// Absent corpus ⇒ the fake serves five payloads, `REAL_CAPTURE_SETS` is empty, and these
// cases skip with their reason named — never silently pass.

/** A 40-hex component key. It is an ADDRESS, and it must never reach a human-readable
 *  surface — the four leak sites this phase closed all put one where a NAME belongs. */
const HASH_ANYWHERE = /[0-9a-f]{40}/i;

/**
 * Collect the page's own console errors. A React render error inside a tab does NOT fail a
 * locator assertion — the tab simply renders its error boundary or nothing — so without
 * this the "every tab mounts" case would pass over a crash.
 *
 * TWO known-benign lines are filtered, both named rather than pattern-swallowed:
 *   · the 404 is the app's own documented boot behaviour (see smoke.e2e.test.ts) — the root
 *     draft wizard optimistically fetches a thread that does not exist yet;
 *   · React's DOM-nesting validator ("cannot contain a nested" / "cannot be a descendant
 *     of") — a `<button>` inside a `<button>`, from the detail card's data-block
 *     header, which renders its copy/attach buttons INSIDE the collapsible trigger button
 *     (`DataBlock.tsx`). PRE-EXISTING and unrelated to anything asserted here — it fires on
 *     the synthetic cards too, and this case is simply the first one that ever looked at the
 *     console. Filed for the owner; fixing it means changing which part of every block
 *     header is clickable, which is a UI decision, not a data-correctness one. Everything
 *     else still fails the case.
 */
function collectConsoleErrors(page: Page): () => readonly string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      message.text().includes("the server responded with a status of 404") &&
      message.location().url.includes("/api/orchestration/threads/")
    ) {
      return;
    }
    // React's DOM-nesting validator, whichever of its two wordings this render path takes.
    if (
      message.text().includes("cannot contain a nested") ||
      message.text().includes("cannot be a descendant of")
    ) {
      return;
    }
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return () => errors;
}

test.describe("real Pixso captures", () => {
  test.skip(
    REAL_CAPTURE_SETS.length === 0,
    "no Pixso captures on this machine — link ru-code-packages and run 'pnpm pixso:expectations'",
  );

  for (const set of REAL_CAPTURE_SETS) {
    test(`the card for the real capture «${set}» renders its own data`, async ({ page }) => {
      // Seven tabs derived from a payload up to 10 MB — see the D-A2 note on the budget.
      test.setTimeout(300_000);
      const consoleErrors = collectConsoleErrors(page);
      const capture = loadRealCapture(set);
      const rootName = rootLayerNameOf(capture);
      const rootGuid = rootGuidOf(capture);
      const rootSize = rootSizeLabelOf(capture);
      const expectedTexts = expectedTextsOf(capture, 3);
      expect(rootName, `${set} has no root layer name`).not.toBeNull();
      expect(rootGuid, `${set} has no root guid to identify its card by`).not.toBeNull();
      expect(rootSize, `${set} has no root size to identify its card by`).not.toBeNull();

      await openPixsoPanel(page);
      await openGallery(page);

      // FIND THE CARD BY ITS NAME **AND ITS SIZE**, then PROVE it by its root guid.
      //
      // Neither the name nor the guid alone selects it. The synthesized payloads are
      // generated from contract tables extracted from THESE captures, so a synthetic card
      // is genuinely called «action sheet» and genuinely carries this capture's root guid on
      // its root node — selecting on either silently asserted everything about the wrong
      // card. The one thing the generator does not reproduce is the real geometry (sizes
      // come from the table's numeric ranges), so name + size is the discriminator, and the
      // guid is then re-checked as a post-condition: a wrong card fails here, loudly.
      const candidates = galleryCards(page)
        .filter({ hasText: rootName ?? "" })
        .filter({ hasText: rootSize ?? "" });
      await expect(
        candidates.first(),
        `no gallery card «${rootName ?? ""}» at ${rootSize ?? ""} — the real capture produced no card`,
      ).toBeVisible();
      // The gallery card's own name is a NAME, not an address.
      expect(await candidates.first().innerText()).not.toMatch(HASH_ANYWHERE);

      // Gallery-TILE PNG (G7a, e2e gap ii): distinct from the OverviewTab's own PNG/SVG
      // toggle asserted below — this is `NodeCard.tsx`'s thumbnail, BEFORE the card is even
      // opened. `card.imageAvailable` drives it (`preview-image.tsx`'s `data:image/png`
      // branch); this capture set records a `get_image` blob (`realCaptureImage`), so the
      // tile must show the screenshot, not the SVG/skeleton fallback.
      const captureImage = realCaptureImage(set);
      if (captureImage !== null) {
        const tilePng = candidates.first().locator('img[src^="data:image/png;base64,"]');
        await expect(
          tilePng,
          `${set} records a get_image blob — the gallery tile must show it, not the SVG fallback`,
        ).toBeVisible({ timeout: 30_000 });
        expect((await tilePng.getAttribute("src")) ?? "").toMatch(
          /^data:image\/png;base64,.{500,}$/,
        );
      }

      await candidates.first().click();
      await expect(page.getByTestId("pixso-tab-overview")).toBeVisible();
      await page.getByRole("tab", { name: "Структура" }).click();
      await expect(
        page.getByTestId("pixso-tab-structure").locator("[data-node-id]").first(),
      ).toHaveAttribute("data-node-id", rootGuid ?? "");

      // 1 — the preview. This capture's scan ran `get_image` in parallel with the catalogue
      // fetch and the fake answered with a PNG at the dimensions the dump records, so the
      // card DEFAULTS to that screenshot and offers a toggle back to our own render. Both
      // sides are asserted: a default that never switches and a toggle that shows the same
      // picture twice are both failures.
      //
      // The data URI is the selector on purpose — `getByRole("img")` is also satisfied by
      // the lucide icon of the «image unavailable» branch, i.e. by the preview having FAILED.
      await page.getByRole("tab", { name: "Обзор" }).click();
      const overview = page.getByTestId("pixso-tab-overview");
      await expect(overview).toBeVisible();

      // `captureImage` computed above (hoisted for the gallery-tile PNG assertion).
      if (captureImage !== null) {
        const toggle = overview.getByTestId("pixso-preview-source");
        await expect(
          toggle,
          `${set} records a get_image blob, so its card must offer the screenshot toggle`,
        ).toBeVisible();
        // DEFAULT: the screenshot.
        const png = overview.locator('img[src^="data:image/png;base64,"]').first();
        await expect(png).toBeVisible({ timeout: 30_000 });
        expect((await png.getAttribute("src")) ?? "").toMatch(/^data:image\/png;base64,.{500,}$/);
        const pngSource = (await png.getAttribute("src")) ?? "";
        // …the toggle really switches to OUR render, not to the same bytes again…
        await overview.getByTestId("pixso-preview-source-svg").click();
        await expect(overview.locator('img[src^="data:image/png"]')).toHaveCount(0);
        await expect(overview.locator('img[src^="data:image/svg+xml"]').first()).toBeVisible();
        // …AND BACK: the screenshot returns, byte-identical, with no refetch to wait on.
        await overview.getByTestId("pixso-preview-source-png").click();
        await expect(
          overview.locator('img[src^="data:image/png;base64,"]').first(),
        ).toHaveAttribute("src", pngSource);
        await expect(overview.locator('img[src^="data:image/svg+xml"]')).toHaveCount(0);
        // Leave it on the render for the assertions below.
        await overview.getByTestId("pixso-preview-source-svg").click();
      } else {
        await expect(overview.getByTestId("pixso-preview-source")).toHaveCount(0);
      }

      // Whichever branch ran, the algorithmic render is on screen now — the SVG half is
      // still the one that proves what the PARSER understood, so it is asserted either way.
      const preview = overview.locator('img[src^="data:image/svg+xml"]').first();
      await expect(preview).toBeVisible();
      const source = await preview.getAttribute("src");
      expect(source ?? "").not.toBe("");
      expect((source ?? "").length).toBeGreaterThan("data:image/svg+xml,".length + 100);

      // 2 — the layers tree carries this capture's own COPY, read out of the capture file
      // at run time. How MUCH is asserted follows what the file proves (see
      // `ExpectedTexts`): a selection with copy of its own must show ALL of it, while a
      // selection made only of instances can only be held to "at least one string from the
      // masters it names" — which is nonetheless false unless the expansion join ran.
      await page.getByRole("tab", { name: "Структура" }).click();
      const structure = page.getByTestId("pixso-tab-structure");
      await expect(structure).toBeVisible();
      expect(expectedTexts.texts.length, `${set} carries no copy to assert`).toBeGreaterThan(0);
      if (expectedTexts.origin === "selection") {
        for (const text of expectedTexts.texts) {
          await expect(structure.getByText(text, { exact: false }).first()).toBeVisible();
        }
      } else {
        const tree = await structure.innerText();
        const present = expectedTexts.texts.filter((text) => tree.includes(text));
        expect(
          present.length,
          `none of the component masters' copy reached the card — the instance-expansion join produced nothing readable (looked for: ${expectedTexts.texts.join(" | ")})`,
        ).toBeGreaterThan(0);
      }
      // …and no row anywhere in the tree shows a 40-hex address.
      expect(await structure.innerText()).not.toMatch(HASH_ANYWHERE);

      // The Phase-3 row markers, on real data. Every one of these fields has been on the
      // wire since Phase 2 and rendered nowhere, so their presence here is the whole point:
      // both captures carry all three (86/62 named components, 43/31 expanded instances,
      // 31/15 vector placeholders in the two wire trees).
      await expect(structure.getByTestId("pixso-layer-component").first()).toBeVisible();
      await expect(structure.getByTestId("pixso-layer-expansion").first()).toBeVisible();
      // The component chips are NAMES — the surface the 40-hex key used to leak into.
      const componentChips = structure.getByTestId("pixso-layer-component");
      expect(await componentChips.count()).toBeGreaterThan(0);
      for (const chip of await componentChips.all()) {
        expect(await chip.innerText()).not.toMatch(HASH_ANYWHERE);
      }

      // 3 — the component rows carry HUMAN names. Both halves: at least one row exists (a
      // real selection is built from components), and not one of them is a hash.
      await page.getByRole("tab", { name: "Компоненты" }).click();
      const components = page.getByTestId("pixso-tab-components");
      await expect(components).toBeVisible();
      const usages = components.getByTestId("pixso-component-usage");
      const usageCount = await usages.count();
      expect(usageCount, `${set} produced no component rows`).toBeGreaterThan(0);
      for (let index = 0; index < usageCount; index += 1) {
        const name = (await usages.nth(index).innerText()).split("\n")[0] ?? "";
        expect(name.length, "a component row with no name at all").toBeGreaterThan(0);
        expect(name, "a 40-hex component key leaked where a name belongs").not.toMatch(
          HASH_ANYWHERE,
        );
        expect(name).not.toMatch(/^[0-9a-f]{40}$/i);
      }

      // Axis block on a REAL capture (e2e gap i, wave-f-review.md F-5): `pixso-catalog-set-axis`
      // is `CatalogAxisRow`'s only emitter, mounted exclusively by `CatalogPanel` inside THIS
      // (detail) Components tab's «Каталог» view, and only inside an EXPANDED multi-variant
      // set's body — never in the gallery. Default CI synthetic names carry no `Prop=Value`
      // suffix, so the axis block only ever proves itself against a real capture's own names.
      //
      // `expectedAxisSetName` reads the capture's OWN catalog at run time for a state-group
      // shared by ≥2 entries (a real SET, same discipline as `expectedTextsOf`: never a
      // literal out of the dump) — both real captures have one (`realCaptures.ts`, corpus-
      // measured: pixso-debug's catalog alone has 147 such groups). Searching for it directly
      // sidesteps the windowed grid (E-W8) entirely instead of guessing at scroll positions.
      const axisSetName = expectedAxisSetName(capture);
      const catalogToggle = components.getByTestId("pixso-components-view-catalog");
      if (axisSetName !== null && (await catalogToggle.count()) > 0) {
        await catalogToggle.click();
        const catalogPanel = components; // same tab container, view swapped in place
        await expect(catalogPanel.getByTestId("pixso-catalog-measured-row").first()).toBeVisible({
          timeout: 30_000,
        });
        await catalogPanel.getByPlaceholder("Поиск по компонентам…").fill(axisSetName);
        const setHeaders = catalogPanel.getByTestId("pixso-catalog-set-header").filter({
          hasText: axisSetName,
        });
        await expect(
          setHeaders.first(),
          `${set}: searching «${axisSetName}» (a real multi-entry state group from this capture's own catalog) surfaces no set card`,
        ).toBeVisible({ timeout: 15_000 });
        await setHeaders.first().click(); // expand
        const axisRows = catalogPanel.getByTestId("pixso-catalog-set-axis");
        await expect(
          axisRows.first(),
          `${set}: the «${axisSetName}» set expands but renders no axis row (only \`pixso-catalog-set-axes-empty\`) — e2e gap (i) is NOT demonstrated`,
        ).toBeVisible();
        const label = await axisRows
          .first()
          .getByTestId("pixso-catalog-set-axis-label")
          .innerText();
        expect(label.trim().length, `${set}'s axis row has no name`).toBeGreaterThan(0);
        expect(label, "a 40-hex address leaked as an axis name").not.toMatch(HASH_ANYWHERE);
        const options = axisRows.first().getByTestId("pixso-catalog-set-axis-option");
        expect(
          await options.count(),
          `${set}'s axis «${label}» renders no option chips`,
        ).toBeGreaterThan(0);
        await catalogPanel.getByPlaceholder("Поиск по компонентам…").fill("");
        await components.getByTestId("pixso-components-view-used").click(); // leave as found
      }

      // 4 — every remaining tab mounts over this payload without throwing. Each assertion
      // is about DATA the tab derived, never about its chrome: a title renders with zero
      // rows behind it, which is the vacuity this file exists to avoid.
      await page.getByRole("tab", { name: "Стили" }).click();
      await expect(page.getByTestId("pixso-tab-styles")).toBeVisible();
      await expect(
        page.getByTestId("pixso-tab-styles").getByTestId("pixso-style-color").first(),
      ).toBeVisible();

      await page.getByRole("tab", { name: "QA" }).click();
      await expect(page.getByTestId("pixso-tab-qa")).toBeVisible();
      await expect(
        page.getByTestId("pixso-tab-qa").getByTestId("pixso-qa-case").first(),
      ).toBeVisible();

      await page.getByRole("tab", { name: "Аналитика" }).click();
      const analytics = page.getByTestId("pixso-tab-analytics");
      await expect(analytics).toBeVisible();
      await analytics.getByText("Слои по видам").click();
      await expect(analytics.getByTestId("pixso-analytics-kind").first()).toBeVisible();

      await page.getByRole("tab", { name: "Промпт" }).click();
      const prompt = page.getByTestId("pixso-tab-prompt");
      await expect(prompt).toBeVisible();
      // The payload the model would receive carries the capture's own copy too, and — the
      // point of the whole naming chain — no address anywhere in it.
      //
      // How much is asserted follows the SAME rule the structure assertion above follows,
      // and for the same reason. A selection with copy of its own must show it. A selection
      // made only of INSTANCES has none, and every string in the masters it names may be
      // overridden per instance — this capture's four instances override all three — so the
      // strings the raw file offers are exactly the ones the drawn design does NOT say. What
      // the prompt must state is THIS card's rendered copy, enumerated and counted, which is
      // what the `## TEXT` section is: one row per visible text node, closed with its own
      // total. (The structure view is about the FILE and still shows the masters' copy; the
      // prompt is about the DESIGN, and a spec that listed text the design hides is the
      // defect `prompt-eval.md` recorded as M29.)
      const promptText = await prompt.innerText();
      if (expectedTexts.origin === "selection") {
        expect(promptText).toContain(expectedTexts.texts[0] ?? "");
      } else {
        expect(
          promptText,
          "the prompt states no copy at all — the TEXT section is missing or empty",
        ).toMatch(/Строк: [1-9]\d*\./);
      }
      expect(promptText).not.toMatch(HASH_ANYWHERE);

      // 5 — the JS console stayed clean while all seven tabs mounted. A React render error
      // does not fail a locator assertion; it fails here.
      expect(consoleErrors()).toEqual([]);
    });
  }
});

/**
 * The preview screenshot is a BONUS, and this is the case that holds it to that.
 *
 * `image-timeout` wedges the fake's `get_image` handler — it never answers, ever — while
 * every other tool keeps working. The scan's image call is fired concurrently with the
 * catalogue fetch under its own 10 s deadline, so the RUN must still settle normally and the
 * gallery must be exactly what it was. The failure mode this pins is a scan that hangs (or
 * settles `tool-timeout`, or loses its card) because a decorative tool went away — which is
 * invisible to build, typecheck, lint and every unit test.
 *
 * Last in the file on purpose: it advances the fake's DSL cursor, and nothing after it may
 * depend on where that cursor is.
 */
test("a wedged get_image never blocks a scan — the card still lands, on the SVG (I1)", async ({
  page,
}) => {
  // One scan, plus the 10 s the image deadline deliberately burns, over a cycle whose tail
  // is a 10 MB capture.
  test.setTimeout(240_000);
  const state = readHarnessState();
  await openPixsoPanel(page);
  await openGallery(page);
  const before = await galleryCards(page).count();
  expect(before).toBeGreaterThan(0);

  setPixsoFakeMode(state, "image-timeout");
  try {
    await page.getByRole("tab", { name: "Импорт" }).click();
    // `runScan` waits for the settle edge — a scan that hung on `get_image` fails HERE.
    await runScan(page);
  } finally {
    setPixsoFakeMode(state, "normal");
  }

  // Every payload has been scanned before, so this run is a reimport: the gallery is
  // unchanged, and — the point — it is still there at all.
  await openGallery(page);
  await expect(galleryCards(page)).toHaveCount(before);

  // A card the fake never gave a screenshot for renders the algorithmic SVG and offers no
  // toggle — the no-image path, unchanged by any of this.
  await galleryCards(page).first().click();
  const overview = page.getByTestId("pixso-tab-overview");
  await expect(overview).toBeVisible();
  await expect(overview.locator('img[src^="data:image/svg+xml"]').first()).toBeVisible();
  await expect(overview.getByTestId("pixso-preview-source")).toHaveCount(0);
});
