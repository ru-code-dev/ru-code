// ADVERSARY R2 — F3 re-adjudicated under the orchestrator's ruling (a). ADV-E5's gesture is
// AMENDED: the reader is taken to the end (arming the follow the way L2 does), then wheels UP,
// so `fromEnd > 0` is a real, ASSERTED precondition instead of the no-op ADV-E5 measured. The
// criterion is the ruling's: across the settle, zero programmatic scroll writers or a movement
// of at most 1 px.
//
// MECHANISM (both red cases are the SAME end-follow, at the two ends of the reader axis):
//   * `timelineScrollController.ts` `suppressDataAdjust: () => sendAnchor !== null &&
//     liveFollowActive()` — the list's `maintainVisibleContentPosition` data adjust is enabled
//     PRECISELY BECAUSE the user scrolled away (the gesture cleared `liveFollowGeneration` in
//     `onUserNavigation`). Its `scrollBy` writes then push the reader past the end, the scroller
//     clamps at the end, and `onScrollSignal(true)` re-arms the follow: the not-at-end direction
//     is guarded against programmatic movement («Transient not-at-end from PROGRAMMATIC
//     movement … neither the pill nor the mode reacts») but the at-end direction is NOT. The
//     follow the user cancelled is resurrected by a write the user never made (R2-E5a).
//   * `onRecordsArrived` is the follow's only scroll trigger, and `shouldRestoreOnSizeChange`
//     returns null while the follow is active — so the content growth that the SETTLE's own
//     re-derivation produces (no new records) is never followed, and the end-pinned reader is
//     left behind (R2-E5c).
// Together these REFUTE the «ADV-E5 and S3 are mutually unsatisfiable» reading: at one and the
// same settle the off-the-end reader is dragged toward the end AND the end-pinned reader fails
// to reach it. R2-E5b pins the position where the behaviour is already correct (a deep park,
// where the adjust writes never reach the end and nothing re-arms).
//
// Does NOT prove: which of the two writers should change (product fix is not the adversary's);
// nor anything about a reader in a SETTLED session (no follow exists there).
import { expect, installScrollInstrumentation, test } from "./fixtures.ts";
import { SESSION_5EEB } from "../harness/realSessions.ts";
import {
  TIMELINE,
  expectExtendedMounted,
  openFreshDraft,
  readDistanceFromEnd,
  readScrollTop,
  replaySession,
  scrollTo,
  scroller,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";

const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

const SURVIVOR_ATTRS = [
  "data-run-summary",
  "data-work-block",
  "data-agent-fleet",
  "data-task-marker",
  "data-agent-marker",
] as const;

type Page = import("@playwright/test").Page;

/** How many open blocks/fleets sit fully ABOVE the viewport (the shrink the attack needs). */
async function openAboveCount(page: Page): Promise<number> {
  return await scroller(page).evaluate((el) => {
    const host = el.getBoundingClientRect();
    return [
      ...el.querySelectorAll<HTMLElement>(
        '[data-work-block] button[aria-expanded="true"], [data-agent-fleet][aria-expanded="true"]',
      ),
    ].filter((node) => node.getBoundingClientRect().bottom < host.top).length;
  });
}

/** A visible row near the top of the viewport, by its data attribute, with its offset. */
async function referenceRow(page: Page): Promise<{ selector: string; top: number } | null> {
  return await scroller(page).evaluate((el, attrs) => {
    const host = el.getBoundingClientRect();
    for (const attr of attrs) {
      for (const node of el.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        const rect = node.getBoundingClientRect();
        // SYNC WAVE: the band is «somewhere in the upper half of the viewport», harness
        // machinery for picking a row to watch — not a promise. R15/R16 moved the rows down
        // (main's 48px top inset, main's bubble spacing), and at this park NO survivor row
        // landed inside the old 40…420 window any more, so the case died on its own setup.
        // Widened to the upper half of an 848px viewport; the invariant below is untouched.
        if (rect.height > 0 && rect.top >= host.top + 40 && rect.top <= host.top + 700) {
          return {
            selector: `[${attr}="${node.getAttribute(attr)!.replaceAll('"', '\\"')}"]`,
            top: Math.round(rect.top - host.top),
          };
        }
      }
    }
    return null;
  }, SURVIVOR_ATTRS);
}

async function offsetOf(page: Page, selector: string): Promise<number | null> {
  return await scroller(page).evaluate((el, sel) => {
    const node = el.querySelector<HTMLElement>(sel);
    return node === null
      ? null
      : Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top);
  }, selector);
}

/**
 * The row's position inside the CONTENT (viewport offset + scrollTop). It falls when content
 * ABOVE the row is removed — which is how «the collapse happened above the reader's eyes» is
 * proven without depending on the collapsed rows still being mounted (they are virtualized
 * away long before they leave the viewport).
 */
async function contentOffsetOf(page: Page, selector: string): Promise<number | null> {
  return await scroller(page).evaluate((el, sel) => {
    const node = el.querySelector<HTMLElement>(sel);
    return node === null
      ? null
      : Math.round(
          node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop,
        );
  }, selector);
}

/** Writer entries since `from`, with the call frames that produced them. */
async function writersSince(page: Page, from: number): Promise<string[]> {
  return await page.evaluate((start) => {
    return (window.__scrollWriters ?? []).slice(start).map((entry) => {
      const frames = entry.stack
        .split("\n")
        .slice(1)
        .filter((line) => !/scrollToTraced|scrollByTraced|Object\.set|writer/.test(line))
        .slice(0, 3)
        .map((line) =>
          line
            .trim()
            .replace(/^at /, "")
            .replace(/https?:\/\/[^/]+/, ""),
        );
      return `${entry.kind}${Math.round(entry.value)} ← ${frames.join(" ← ")}`;
    });
  }, from);
}

/** Replay 5eeb slowly, and wait until at least one fleet/block is OPEN (something to shrink). */
async function streamTallSession(page: Page, holdMs: number): Promise<void> {
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, { pacing: { kind: "records", intervalMs: 150 }, holdMs });
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight), {
      timeout: 40_000,
    })
    .toBeGreaterThan(1_600);
  // Something OPEN must exist, or the settle collapse has nothing to shrink.
  await expect
    .poll(
      async () =>
        timeline
          .locator(
            '[data-agent-fleet][aria-expanded="true"], [data-work-block] button[aria-expanded="true"]',
          )
          .count(),
      { timeout: 40_000 },
    )
    .toBeGreaterThan(0);
}

/**
 * Arm the live follow exactly the way L2 does (the pill, else a programmatic end write), then
 * wheel UP by `upPx` — a real gesture, which cancels the follow and leaves the reader inside
 * the live turn but genuinely off the end.
 */
async function armFollowAtEnd(page: Page): Promise<void> {
  const pill = page.getByRole("button", { name: /Прокрутить вниз|Scroll to end/ });
  if (await pill.isVisible().catch(() => false)) {
    await pill.click();
  } else {
    await scrollTo(page, "end");
  }
  await waitForTimelineQuiet(page);
}

async function parkOffTheEnd(page: Page, upPx: number): Promise<void> {
  await armFollowAtEnd(page);
  const box = (await scroller(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const steps = Math.max(1, Math.round(upPx / 300));
  for (let step = 0; step < steps; step += 1) await page.mouse.wheel(0, -300);
  await page.waitForTimeout(400);
}

test("R2-E5a (F3 ruling a): a reader wheeled UP off the end INSIDE the live turn is not moved by the settle collapse", async ({
  page,
}) => {
  // ADV-E5's premise, corrected. The original wheeled DOWN from a reader already glued to the
  // end (`fromEnd 0`), so the gesture was a no-op and its +704 was S3's own end-follow. Here
  // the reader is taken to the end (arming the follow, L2's own gesture), then wheels UP; the
  // precondition `fromEnd > 200` and «open blocks/fleets above the viewport» are ASSERTED
  // before the settle, so the shrink this finding is about really happens above their eyes.
  // Does NOT prove: the reader pinned AT the end (R2-E5c — they follow by design).
  test.setTimeout(300_000);
  await streamTallSession(page, 25_000);
  const timeline = page.locator(TIMELINE);
  // A SHALLOW park: off the end, but low enough in the turn that the collapsing blocks and
  // fleets sit ABOVE the reader (a deep park puts the reader above them — the collapse then
  // happens BELOW their eyes and the attack's geometry does not exist).
  await parkOffTheEnd(page, 300);
  const fromEndBefore = await readDistanceFromEnd(page);
  const topBefore = await readScrollTop(page);
  const openAboveMounted = await openAboveCount(page);
  const reference = await referenceRow(page);
  expect(reference, "a reference row in the viewport").not.toBeNull();
  const contentBefore = await contentOffsetOf(page, reference!.selector);
  const precondition = `fromEnd=${fromEndBefore} scrollTop=${topBefore} openAboveMounted=${openAboveMounted} ref=${reference!.selector}@${reference!.top} content@${contentBefore}`;
  // THE PRECONDITION — a reader genuinely off the end (ADV-E5's false half, corrected).
  expect(fromEndBefore, `reader must be OFF the end: ${precondition}`).toBeGreaterThan(200);
  const writersBefore = await page.evaluate(() => window.__scrollWriters?.length ?? 0);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 90_000 });
  await waitForTimelineQuiet(page);
  const topAfter = await readScrollTop(page);
  const refAfter = await offsetOf(page, reference!.selector);
  const contentAfter = await contentOffsetOf(page, reference!.selector);
  const writers = await writersSince(page, writersBefore);
  const message = `${precondition} → scrollTop ${topBefore}→${topAfter}, ref ${reference!.top}→${refAfter ?? "UNMOUNTED"}, content ${contentBefore}→${contentAfter ?? "UNMOUNTED"}\nwriters after the gesture (${writers.length}):\n${writers.slice(0, 20).join("\n")}`;
  // THE CLAIM (the ruling's criterion): across the settle the reader who chose this position
  // keeps it — zero programmatic scroll writers, or a movement of at most 1 px. `content`
  // in the message is the row's offset INSIDE the content: when it is unchanged while the
  // viewport offset moved, the movement was NOT compensation for a shrink above the reader —
  // the writers dragged the reader instead.
  expect(refAfter, message).not.toBeNull();
  expect(Math.abs((refAfter as number) - reference!.top), message).toBeLessThanOrEqual(1);
});

test("R2-E5b (F3 ruling a): a reader parked off the end mid-turn is not moved while blocks stream open, then settle", async ({
  page,
}) => {
  // The same reader, sampled CONTINUOUSLY: the drift is attributed to the streaming phase or
  // to the settle instant instead of being lumped together, so the verdict names the mechanism.
  test.setTimeout(300_000);
  await streamTallSession(page, 25_000);
  const timeline = page.locator(TIMELINE);
  await parkOffTheEnd(page, 900);
  const fromEndBefore = await readDistanceFromEnd(page);
  const reference = await referenceRow(page);
  expect(fromEndBefore, "the reader must be off the end").toBeGreaterThan(200);
  expect(reference, "a reference row at park time").not.toBeNull();
  const writersBefore = await page.evaluate(() => window.__scrollWriters?.length ?? 0);
  // Streaming phase — the reader sits still while records land and blocks open below.
  const samples: Array<{ phase: string; top: number; ref: number | null }> = [];
  for (let index = 0; index < 25; index += 1) {
    samples.push({
      phase: "stream",
      top: await readScrollTop(page),
      ref: await offsetOf(page, reference!.selector),
    });
    if (
      (await timeline
        .getByText(/^Работаю|^Working/)
        .first()
        .count()) === 0
    )
      break;
    await page.waitForTimeout(250);
  }
  const streamDrift = Math.max(
    0,
    ...samples.map((sample) =>
      sample.ref === null ? 9999 : Math.abs(sample.ref - reference!.top),
    ),
  );
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 90_000 });
  await waitForTimelineQuiet(page);
  const refAfter = await offsetOf(page, reference!.selector);
  const writers = await writersSince(page, writersBefore);
  const message = `parked fromEnd=${fromEndBefore} ref ${reference!.top} → streamDrift ${streamDrift} → afterSettle ${refAfter ?? "UNMOUNTED"}; samples ${samples.map((s) => `${s.top}/${s.ref ?? "x"}`).join(" ")}\nwriters (${writers.length}):\n${writers.slice(0, 20).join("\n")}`;
  expect(streamDrift, `STREAMING phase moved the parked reader: ${message}`).toBeLessThanOrEqual(1);
  expect(refAfter, message).not.toBeNull();
  expect(Math.abs((refAfter as number) - reference!.top), message).toBeLessThanOrEqual(1);
});

test("R2-E5c (F3 ruling a): a reader AT the end still follows the end through the settle (S3)", async ({
  page,
}) => {
  // The other end of the axis, armed exactly as L2 arms it. Whatever the mid-turn rule is, the
  // end-pinned reader must keep following: the fixer's §0 «ADV-E5 and S3 are mutually
  // unsatisfiable» claim only bites if BOTH are demanded of the SAME reader.
  test.setTimeout(300_000);
  await streamTallSession(page, 20_000);
  const timeline = page.locator(TIMELINE);
  await armFollowAtEnd(page);
  await expect
    .poll(async () => readDistanceFromEnd(page), { timeout: 20_000 })
    .toBeLessThanOrEqual(8);
  const metrics = () =>
    scroller(page).evaluate((el) => ({
      top: Math.round(el.scrollTop),
      height: Math.round(el.scrollHeight),
      client: Math.round(el.clientHeight),
    }));
  const before = await metrics();
  const writersBefore = await page.evaluate(() => window.__scrollWriters?.length ?? 0);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 90_000 });
  await waitForTimelineQuiet(page);
  // The layout must be STABLE before the verdict: a shrinking/growing scrollHeight would make
  // any single reading meaningless. Poll until the content height stops changing.
  let stable = 0;
  let previous = -1;
  const heights: number[] = [];
  for (let index = 0; index < 40 && stable < 5; index += 1) {
    const sample = await metrics();
    heights.push(sample.height);
    stable = sample.height === previous ? stable + 1 : 0;
    previous = sample.height;
    await page.waitForTimeout(300);
  }
  const after = await metrics();
  const writers = await writersSince(page, writersBefore);
  const fromEnd = after.height - after.client - after.top;
  const message = `end-pinned reader after the settle: fromEnd=${fromEnd}; before top=${before.top} height=${before.height} client=${before.client} → after top=${after.top} height=${after.height}; heights ${heights.join(",")}\nwriters (${writers.length}):\n${writers.slice(-20).join("\n")}`;
  expect(fromEnd, message).toBeLessThanOrEqual(2);
});
