// ru-code: HTML-PREVIEW WAVE — the owner's spec v2 acceptance, end to end over the REAL
// stack. Nothing here is faked above the Pixso MCP boundary: the scan runs through the fake
// desktop plugin, the server's own `persistScan` renders the engine's `renderPreviewHtml`
// face and writes `scans/<hash>/preview.html`, the detail tier reports `htmlAvailable` from
// a real disk probe, and the panel pulls the bytes over the real `pixsoAssistant.cardHtml`
// RPC. Every assertion below is one of the owner's seven sentences:
//
//   1. the block is on the MAIN tab («Обзор»), positioned JUST ABOVE the links block
//   2. it is COLLAPSED BY DEFAULT (owner's call after live review — expanded is too heavy)
//      and, once opened, shows the html SYNTAX-HIGHLIGHTED (the repo's own Shiki
//      highlighter — a `pre.shiki`, never the plain-text fallback)
//   3. its controls are the SAME SET the sibling code blocks carry: the (+) attach and the
//      copy-to-clipboard, nothing fewer and nothing extra
//   4. «Открыть HTML» is a separate button INLINE in the tab's existing app-button row and
//      opens a NEW TAB carrying our html off a blob URL
//   5. the load actually RESOLVES, WITHOUT ANY CLICK — this spec is the execution proof for
//      the forever-«Загрузка HTML…» bug (the port had gained `cardHtml`, but the app's host
//      client and its RPC scope/handler rows never followed, so the fetch threw before it
//      ever flew). The bytes are fetched at mount, NOT on expand, so the collapsed block
//      already reports its size before anything is clicked.
//
// The links block does NOT render for the fake's corpus (its DSL carries no `url` fields on
// any layer), so §1's "above the links" is pinned two ways that are both true regardless:
// the html block precedes the links block whenever both are on screen, AND it occupies the
// last slot of the tab — which IS the slot immediately above the links block.

import { expect, readHarnessState, test, type Page } from "../tests-core/fixtures.ts";

/** The Import tab defaults to "remote"; every assertion here is about a LOCAL scan. */
async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
  await page.getByTestId("pixso-source-local").click();
  await expect(page.getByTestId("pixso-scan-button")).toBeVisible();
}

/**
 * Run one scan and wait for the SERVER-owned job to settle. The disabled edge is OBSERVED
 * with a mutation observer armed before the click, not sampled: these in-memory scans can
 * hold the button disabled for less than one Playwright poll tick.
 */
async function runScan(page: Page): Promise<void> {
  const scan = page.getByTestId("pixso-scan-button");
  await expect(scan).toBeEnabled();
  await scan.evaluate((button) => {
    const flags = window as unknown as { __pixsoScanStarted?: boolean };
    flags.__pixsoScanStarted = false;
    const isDisabled = () =>
      (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";
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

test.describe.configure({ mode: "serial" });

test("the HTML preview block rides the main tab above the links, collapsed but already loaded, highlighted once opened, with the sibling control set — and «Открыть HTML» opens our html in a new tab", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  await openPixsoPanel(page);
  await runScan(page);
  await page.getByRole("tab", { name: "Галерея" }).click();
  const cards = page.getByTestId("pixso-group-section").getByTestId("pixso-card");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await cards.first().click();

  const overview = page.getByTestId("pixso-tab-overview");
  await expect(overview).toBeVisible();

  // ---- §1: the block is ON THE MAIN TAB. Its mere presence already proves the server
  // wrote `preview.html` at persist time and reported `htmlAvailable` on the detail tier:
  // the `htmlAvailable === false` branch renders the "delete and rescan" line instead.
  const block = page.getByTestId("pixso-html-block");
  await expect(block).toBeVisible();
  await expect(page.getByTestId("pixso-html-unavailable")).toHaveCount(0);

  // The card's own name, read off the detail header — the oracle for the opened tab's
  // <title> further down. Taken from the UI rather than hard-coded so the assertion cannot
  // drift away from whichever frame the fake served.
  const cardName = (await page.getByTestId("pixso-detail-header").locator("h3").innerText()).trim();
  expect(cardName.length).toBeGreaterThan(0);

  // ---- §1: ABOVE THE LINKS BLOCK. Whenever both are on screen the html block comes first;
  // and it is the LAST block of the tab, i.e. it sits in exactly the slot the links block
  // renders into when the scanned DSL does carry designer urls.
  const placement = await overview.evaluate((root) => {
    const marked = Array.from(
      root.querySelectorAll("[data-testid='pixso-html-block'],[data-testid='pixso-links-block']"),
    ).map((node) => node.getAttribute("data-testid"));
    const html = root.querySelector("[data-testid='pixso-html-block']");
    return { marked, isLast: html !== null && html === root.lastElementChild };
  });
  expect(placement.marked[0]).toBe("pixso-html-block");
  expect(placement.isLast).toBe(true);

  // ---- §2: COLLAPSED BY DEFAULT (owner, after live review: a whole html document is too
  // heavy to open the tab with). Nothing has been clicked at this point, so the code surface
  // must not be on screen — `toBeHidden` covers both "in the DOM but hidden" and "not
  // mounted", which is the base-ui Collapsible's own closed state.
  const highlighted = block.locator("pre.shiki");
  await expect(highlighted).toBeHidden();

  // ---- §5: …and yet THE LOAD ALREADY HAPPENED, with NO click anywhere. The header's count
  // pill reads «—» until the bytes land and their size in KB afterwards, so a KB reading on
  // a still-collapsed block is the click-free proof that the mount-time fetch completed the
  // real `pixsoAssistant.cardHtml` round trip. This is the load-bug pin: it is exactly what
  // an `onOpenChange`-only fetch — the original defect — could never satisfy.
  const trigger = block.locator("button").first();
  await expect(trigger).toContainText("KB", { timeout: 30_000 });

  // ---- §2: EXPANDS ON CLICK, POPULATED. Clicking the title text toggles the collapsible
  // from inside the trigger row without going near the nested attach/copy buttons.
  await block.getByText("HTML-превью", { exact: true }).click();
  await expect(highlighted).toBeVisible({ timeout: 30_000 });
  await expect(block.getByText("Загрузка HTML…")).toHaveCount(0);
  await expect(block.getByTestId("pixso-html-error")).toHaveCount(0);

  // ---- §2: SYNTAX-HIGHLIGHTED by the repo's own highlighter. `pre.shiki` is emitted only
  // by `HighlightedCode`'s Shiki path — its failure fallback is a bare <pre> with no such
  // class — and real tokenisation means per-token colour spans, not one undifferentiated
  // text node.
  const colouredTokens = await highlighted.locator("span[style*='color']").count();
  expect(colouredTokens).toBeGreaterThan(5);

  // …and what it highlights is OUR html: the engine's face opens with this exact preamble.
  const blockCode = (await highlighted.innerText()).trim();
  expect(blockCode.startsWith("<!doctype html>")).toBe(true);
  expect(blockCode).toContain('<meta charset="utf-8">');

  // ---- §3: THE SAME CONTROL SET AS THE SIBLING BLOCKS — the (+) attach and the copy, and
  // nothing else. The header is the block's trigger row; counting ALL its buttons is what
  // makes "nothing extra" a real assertion (the first cut carried a third, open-in-new-tab
  // icon button here, which spec v2 moved out of the block entirely).
  // The attach toggle is the block's ONLY aria-pressed button; the copy carries the house
  // «Скопировать …» label. The expanded body contributes no buttons of its own, so the
  // block's whole button census is: the collapse trigger + these two, and no more.
  const attach = block.locator("button[aria-pressed]");
  const copy = block.locator("button[aria-label='Скопировать HTML']");
  await expect(attach).toHaveCount(1);
  await expect(copy).toHaveCount(1);
  await expect(block.locator("button")).toHaveCount(3); // trigger + attach + copy, nothing extra

  // ---- §3: the (+) ATTACHES. The latch is the shared `useIsAttached` selector reading the
  // real tray, so a flipped aria-pressed means the item genuinely entered the store.
  await expect(attach).toHaveAttribute("aria-pressed", "false");
  await attach.click();
  await expect(attach).toHaveAttribute("aria-pressed", "true");

  // ---- §4: «Открыть HTML» is a button of the tab's existing app-button row — the SAME row
  // the group picker's own button sits in — and NOT part of the block.
  const openHtml = page.getByTestId("pixso-open-html");
  await expect(openHtml).toBeVisible();
  await expect(openHtml).toBeEnabled();
  expect(await block.getByTestId("pixso-open-html").count()).toBe(0);
  const sharedRow = await page.evaluate(() => {
    const button = document.querySelector("[data-testid='pixso-open-html']");
    const row = button?.parentElement ?? null;
    return {
      buttonsInRow: row === null ? 0 : row.querySelectorAll("button").length,
      // The group picker's own trigger is the row's other app button: same component, so
      // the two must carry the same `data-slot` marker and the same size classes.
      slots:
        row === null
          ? []
          : Array.from(row.querySelectorAll("button[data-slot='button']")).map((node) =>
              node.className.includes("h-7") ? "xs" : "other",
            ),
    };
  });
  expect(sharedRow.buttonsInRow).toBeGreaterThan(1);
  expect(new Set(sharedRow.slots).size).toBe(1); // every app button in the row is the same size

  // ---- §4: pressing it opens a NEW TAB whose content IS our html, off a blob URL — never
  // a file:// and never an app route.
  const popupPromise = context.waitForEvent("page", { timeout: 30_000 });
  await openHtml.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url().startsWith("blob:")).toBe(true);

  // ---- TITLE INJECTION: the tab is identifiable by the CARD'S NAME rather than reading as
  // a raw blob URL. The engine's face emits no <title> at all (its bytes are corpus-pinned),
  // so this can only come from the panel-side injection.
  const popupTitle = await popup.title();
  expect(popupTitle).toContain(cardName);
  expect(popupTitle).toContain("HTML");
  expect(popupTitle.startsWith("blob:")).toBe(false);

  const popupHtml = await popup.evaluate(() => document.documentElement.outerHTML);
  expect(popupHtml).toContain('<meta charset="utf-8">');
  // A line lifted out of the block's own rendered css must appear verbatim in the opened
  // tab — the two are the same bytes, not merely two documents that both look like html.
  const cssLine = blockCode
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith("{") && line.length > 12);
  expect(cssLine).toBeDefined();
  expect(popupHtml).toContain(cssLine as string);
  await popup.close();
});
