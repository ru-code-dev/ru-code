// ru-code (extended-view SYNC wave, R17): THE PIXEL ACCEPTANCE for the user bubble.
//
// One thread, one exchange — «Hi» → «Hello» — rendered by BOTH views, at 1440×900 @2x, in
// both themes. The claim under test is the owner's, stated exactly: at REST the two views are
// indistinguishable. So the case does two things and neither is a proxy:
//
//   1. THE PIXELS. Both views are clipped to the SAME box — the timeline scroller, i.e. the
//      chat column from the header's bottom edge to the composer's top, minimap gutter
//      included — and the two PNGs must be identical. Playwright encodes both with the same
//      encoder from the same-sized raster, so byte-equality of the two files is exactly
//      «zero differing pixels» (threshold 0, no tolerance term anywhere). On a mismatch both
//      images are attached to the report, next to the numeric diff, so the failure says WHY.
//   2. THE NUMBERS (§4 of the map report): the bubble's box, its computed background, border,
//      padding, radius and font, the assistant text's top, and the first row's offset from the
//      container top. A picture that matched while a number drifted would mean the crop was
//      wrong; a number that matched while the picture drifted means colour or antialiasing.
//      Each one names the ruling it belongs to (R14 border/surface, R16 the 48px inset).
//
// Does NOT prove: hover states (the extended view deliberately shows MORE on hover — owner),
// any state with an agent, a tool call or a context bar in it, or the narrow layout.
import * as NodeFS from "node:fs";

import {
  expect,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
  type Page,
} from "./fixtures.ts";
import { expectExtendedMounted, openFreshDraft, switchToExtended } from "./extendedView.ts";

/** Main's timeline scroller has no testid; it is the one `scrollbar-gutter-both` node in the
 *  chat column (the same handle the map's geometry harness measured both views through). */
const SCROLLER_BY_VIEW = {
  main: ".scrollbar-gutter-both",
  extended: '[data-testid="extended-chat-scroller"]',
} as const;

interface BubbleNumbers {
  readonly scroller: { readonly width: number; readonly height: number };
  readonly bubble: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly background: string;
    readonly borderTopWidth: string;
    readonly borderTopColor: string;
    readonly borderRadius: string;
    readonly padding: string;
    readonly font: string;
    readonly color: string;
  };
  readonly assistantTextTop: number;
  readonly helloBox: string;
  readonly bubbleTextBox: string;
  readonly firstRowOffset: number;
}

async function readNumbers(page: Page, view: keyof typeof SCROLLER_BY_VIEW) {
  return await page.evaluate((selector): BubbleNumbers => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const scroller = document.querySelector(selector);
    if (scroller === null) throw new Error(`no scroller for ${selector}`);
    const scrollerBox = scroller.getBoundingClientRect();
    const nodes = [...scroller.querySelectorAll<HTMLElement>("div, p, span")];
    const bubble = nodes.find(
      (node) =>
        String(node.className).includes("rounded-2xl") && (node.textContent ?? "").trim() === "Hi",
    );
    if (bubble === undefined) throw new Error("no «Hi» bubble");
    // The MARKDOWN container, not «the first node whose text is Hello»: both views render the
    // answer through the app's own ChatMarkdown, so this is the same element on both sides —
    // whereas the outermost node whose text trims to «Hello» is a different ancestor in each.
    const hello = [...scroller.querySelectorAll<HTMLElement>(".chat-markdown")].find(
      (node) => (node.textContent ?? "").trim() === "Hello",
    );
    if (hello === undefined) throw new Error("no «Hello» markdown");
    const firstRow = [...scroller.querySelectorAll<HTMLElement>("div")].find((node) => {
      const className = String(node.className);
      return className.includes("mx-auto") && className.includes("max-w-3xl");
    });
    if (firstRow === undefined) throw new Error("no row shell");
    const style = getComputedStyle(bubble);
    const bubbleBox = bubble.getBoundingClientRect();
    return {
      scroller: { width: round(scrollerBox.width), height: round(scrollerBox.height) },
      bubble: {
        top: round(bubbleBox.top),
        left: round(bubbleBox.left),
        width: round(bubbleBox.width),
        height: round(bubbleBox.height),
        background: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
        borderRadius: `${style.borderTopLeftRadius} ${style.borderTopRightRadius} ${style.borderBottomRightRadius} ${style.borderBottomLeftRadius}`,
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        font: `${style.fontFamily} / ${style.fontSize} / ${style.lineHeight} / ${style.fontWeight}`,
        color: style.color,
      },
      assistantTextTop: round(hello.getBoundingClientRect().top),
      helloBox: (() => {
        const r = hello.getBoundingClientRect();
        return `${round(r.top)},${round(r.left)},${round(r.width)},${round(r.height)}`;
      })(),
      bubbleTextBox: (() => {
        const inner = bubble.querySelector<HTMLElement>(".chat-markdown") ?? bubble;
        const r = inner.getBoundingClientRect();
        return `${inner.tagName}.${String(inner.className).slice(0, 30)} ${round(r.top)},${round(r.left)},${round(r.width)},${round(r.height)}`;
      })(),
      firstRowOffset: round(firstRow.getBoundingClientRect().top - scrollerBox.top),
    };
  }, SCROLLER_BY_VIEW[view]);
}

/** Park everything that could differ for a reason other than layout: the pointer off the
 *  column (both views reveal a meta strip on hover), the scroll at the very top, and no
 *  caret in the composer. Then wait for the raster to hold still for two frames. */
async function settleForShot(page: Page, view: keyof typeof SCROLLER_BY_VIEW): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate((selector) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const scroller = document.querySelector<HTMLElement>(selector);
    if (scroller !== null) scroller.scrollTop = 0;
  }, SCROLLER_BY_VIEW[view]);
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return false;
      const state = window as unknown as { __r17?: { top: number; frames: number } };
      if (state.__r17 !== undefined && state.__r17.top === node.scrollTop) {
        state.__r17.frames += 1;
      } else {
        state.__r17 = { top: node.scrollTop, frames: 0 };
      }
      return state.__r17.frames >= 20;
    },
    SCROLLER_BY_VIEW[view],
    { timeout: 30_000, polling: "raf" },
  );
  await page.evaluate(() => {
    delete (window as unknown as { __r17?: unknown }).__r17;
  });
}

/** THE CROP, per R17: the chat column, from the header's bottom edge (the scroller's top) to
 *  the COMPOSER's top. The scroller's own box runs on BEHIND the overlay composer — it reserves
 *  that space rather than ending at it — so clipping to the scroller would put the composer's
 *  view chip («Компактный» / «Подробный») inside the comparison, which is the one thing the two
 *  views are supposed to differ by. The composer overlay is the app's own marked element. */
async function captureView(page: Page, view: keyof typeof SCROLLER_BY_VIEW) {
  await settleForShot(page, view);
  const numbers = await readNumbers(page, view);
  const scrollerBox = await page.locator(SCROLLER_BY_VIEW[view]).first().boundingBox();
  if (scrollerBox === null) throw new Error(`no scroller box for ${view}`);
  const composerBox = await page.locator('[data-chat-composer-overlay="true"]').boundingBox();
  if (composerBox === null) throw new Error("no composer overlay box");
  const box = {
    x: scrollerBox.x,
    y: scrollerBox.y,
    width: scrollerBox.width,
    height: Math.max(1, Math.round(composerBox.y - scrollerBox.y)),
  };
  const png = await page.screenshot({ clip: box, animations: "disabled", scale: "device" });
  return { numbers, png, box };
}

// R17's own terms: 1440×900 at DEVICE SCALE 2 — the density the map measured §4 at, and the
// one that makes a half-pixel divergence a whole differing pixel instead of a rounding.
test.use({ deviceScaleFactor: 2 });

for (const colorScheme of ["light", "dark"] as const) {
  test(`R17 (${colorScheme}): «Hi» → «Hello» is pixel-identical in both views at rest`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme });
    await openFreshDraft(page);
    if (colorScheme === "dark") {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark, "the app must follow prefers-color-scheme for the dark half").toBe(true);
    }
    // The COMPACT view first — the same thread renders both, so the transcript is identical
    // by construction and nothing about the comparison depends on two replays matching.
    const switcher = page.getByTestId("extended-chat-switcher");
    await expect(switcher).toBeVisible({ timeout: 15_000 });
    if (/Подробный|Detailed/.test(await switcher.innerText())) await switcher.click();
    await expect(switcher).toContainText(/Компактный|Compact/);
    // One plain exchange: no tools, no agents, no context bar — the state the claim is about.
    writeFakeControl(readHarnessState(), { delayMs: 0, responseText: "Hello" });
    await sendPrompt(page, "Hi");
    await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });

    const main = await captureView(page, "main");
    await switchToExtended(page);
    await expectExtendedMounted(page);
    await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });
    const extended = await captureView(page, "extended");

    // The crop must be the SAME box in both views, or the picture comparison means nothing.
    expect(
      { width: Math.round(extended.box.width), height: Math.round(extended.box.height) },
      "the two views' timeline areas are not the same box",
    ).toEqual({ width: Math.round(main.box.width), height: Math.round(main.box.height) });

    console.log(
      `[R17 ${colorScheme}] main=${JSON.stringify(main.numbers)}\n[R17 ${colorScheme}] extended=${JSON.stringify(extended.numbers)}`,
    );

    // §4 numeric table — every row the map measured, side by side.
    expect(extended.numbers.bubble, "the bubble box / surface / border / font (R14)").toEqual(
      main.numbers.bubble,
    );
    expect(extended.numbers.assistantTextTop, "the assistant text's top (R15)").toBeCloseTo(
      main.numbers.assistantTextTop,
      1,
    );
    expect(
      extended.numbers.firstRowOffset,
      "the first row's offset — the 48px inset (R16)",
    ).toBeCloseTo(main.numbers.firstRowOffset, 1);

    // ZERO differing pixels. Same encoder, same-sized raster ⇒ identical bytes ⟺ identical
    // pixels; there is no threshold to soften and none is wanted.
    if (!extended.png.equals(main.png)) {
      // Both crops land beside the report AND on disk: a difference this case cannot describe
      // in numbers is one a human has to look at.
      await testInfo.attach(`r17-${colorScheme}-main.png`, {
        body: main.png,
        contentType: "image/png",
      });
      await testInfo.attach(`r17-${colorScheme}-extended.png`, {
        body: extended.png,
        contentType: "image/png",
      });
      NodeFS.writeFileSync(testInfo.outputPath(`r17-${colorScheme}-main.png`), main.png);
      NodeFS.writeFileSync(testInfo.outputPath(`r17-${colorScheme}-extended.png`), extended.png);
    }
    expect(
      extended.png.equals(main.png),
      `the two views differ in the timeline area (${colorScheme}); both crops are attached to this report.\nmain=${JSON.stringify(main.numbers)}\nextended=${JSON.stringify(extended.numbers)}`,
    ).toBe(true);
  });
}
