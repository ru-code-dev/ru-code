// ru-code (extended-view redesign, design review round 1): the punches' browser acceptance
// on the REAL built app (design-review-1.md). Every case switches to the extended view first
// and asserts it is mounted (H1).
//   R1-1  the context bar never covers a row at scroll top (bar bbox ∩ first row bbox = ∅)
//   R1-5  the PANEL pushes the dialog at 1440 wide: the column loses exactly the panel's
//         pixels, no card / summary / fleet / block pixel is covered, and a reader at the
//         top keeps the top (R9 a)
//   R1-7  vertical rhythm: the DOM gap between a response's last VISIBLE content and the
//         next user bubble is ≤ 42 px in all three real sessions
//   R1-11 (owner) a settled turn whose background agents still run: the bar KEEPS listing
//         them (running chips) while the composer's background-liveness banner shows too,
//         and the two surfaces do not overlap
//   R1-12 mode switch mid-turn: compact → detailed leaks no main-chat-only element (the
//         spawn CTA row); detailed → compact leaves nothing of the extended view behind —
//         the global detail PANEL included (R3 d)
import { expect, test, type Locator, type Page } from "@playwright/test";

import { SESSION_5EEB, SESSION_6C09, SESSION_9388 } from "../harness/realSessions.ts";
import {
  CONTEXT_BAR,
  INSPECTOR,
  closeExtendedViewPanel,
  OPEN_AGENT_IN_PANEL,
  TIMELINE,
  expectExtendedMounted,
  measureBubbleGaps,
  openFreshDraft,
  readScrollTop,
  replaySession,
  scroller,
  scrollTo,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";
import { readHarnessState, sendPrompt, writeFakeControl } from "./fixtures.ts";

const SETTLED = { pacing: { kind: "instant" }, mirrorRegistry: false } as const;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
};
const intersects = (a: Box, b: Box): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

/** The bar's pill (the visible surface — the outer overlay spans the whole width). */
const barPill = (page: Page): Locator =>
  page
    .locator(CONTEXT_BAR)
    .locator("div")
    .filter({ hasText: /работа|running|задачи|tasks/ })
    .last();

/** Row containers of the virtualized list, top-most first (geometry, never DOM order). */
async function topmostRowBox(page: Page): Promise<Box & { text: string }> {
  return await scroller(page).evaluate((el) => {
    const containers = [...el.querySelectorAll<HTMLElement>('[style*="position: absolute"]')]
      .filter((node) => node.getBoundingClientRect().height > 0)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const first = containers[0]!;
    const rect = first.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      text: (first.textContent ?? "").trim().slice(0, 40),
    };
  });
}

test("R1-1a: SETTLED session at scrollTop 0 — the bar sits in the reserved inset, over no row pixel", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 5eeb settled: the board is unfinished → the bar shows «задачи 1/5 · не завершено» (the
  // 5eeb/01 defect: the pill on the user bubble's corner).
  await replaySession(page, SESSION_5EEB, SETTLED);
  await expectExtendedMounted(page);
  const bar = page.locator(CONTEXT_BAR);
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await scrollTo(page, 0);
  expect(await readScrollTop(page)).toBe(0);
  const firstRow = await topmostRowBox(page);
  const pill = await boxOf(barPill(page));
  expect(
    intersects(pill, firstRow),
    `bar ${JSON.stringify(pill)} overlaps the first row ${JSON.stringify(firstRow)}`,
  ).toBe(false);
  expect(pill.bottom).toBeLessThanOrEqual(firstRow.top);
});

test("R1-1b: LIVE anchored turn — the send-anchored bubble lands below the bar, not under it", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // live-02 state: 6c096be2 to record 13, held — 4 running agents → the bar is showing over a
  // LIVE turn. The invariant is the bar-vs-bubble geometry with the reader AT THE TOP.
  //
  // THE READER MUST TAKE THE TOP WITH A GESTURE. `scrollTo(0)` is a PROGRAMMATIC write, and a
  // programmatic write never cancels the live follow (only wheel/touch/pointer do — the
  // controller's own law), so the follow legitimately reclaims the viewport and pulls back to
  // the end: measured `scrollTop 32`, where the short held turn's end leaves the bubble 4 px
  // below the scroller top and under the 28 px bar. The old precondition asserted the literal
  // 0 and RACED that reclaim (2 red / 3 solo, adversary R2 §6) — it failed on the premise,
  // never on the invariant this case guards. A wheel is what a reader actually does, and it
  // is the only thing that takes the viewport from the follow; then 0 is a stable, honest
  // precondition.
  await replaySession(page, SESSION_6C09, {
    pacing: { kind: "records", intervalMs: 80 },
    limit: 13,
    holdMs: 90_000,
  });
  const bar = page.locator(CONTEXT_BAR);
  await expect(bar).toBeVisible({ timeout: 20_000 });
  const box = (await scroller(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // ALWAYS gesture, even when the viewport already happens to sit at 0: what the
  // precondition needs is not the position but the CANCELLED follow. Skipping the
  // wheel there left the follow owning the viewport, and the glue then took the
  // reader to the end as the held turn re-measured — measured 0 → 32, 2 red / 3.
  for (let wheel = 0; wheel < 12; wheel += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(120);
    if ((await readScrollTop(page)) === 0) break;
  }
  await waitForTimelineQuiet(page);
  let restTop = await readScrollTop(page);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(250);
    const next = await readScrollTop(page);
    if (next === restTop) break;
    restTop = next;
  }
  // The reader took the top and NOTHING may move them off it — the gesture cancelled the
  // follow, and the end glue is off for a reader who left the end (R2-F10).
  expect(restTop, "the reader holds the top after their own gesture").toBe(0);
  const timeline = page.locator(TIMELINE);
  const bubble = timeline
    .locator(".rounded-2xl.bg-message")
    .filter({ hasText: SESSION_6C09.firstUser.slice(0, 40) })
    .first();
  await expect(bubble).toBeVisible();
  const bubbleBox = await boxOf(bubble);
  const pill = await boxOf(barPill(page));
  const diagnostics = await scroller(page).evaluate((el) => {
    const host = el.getBoundingClientRect();
    return {
      scrollTop: el.scrollTop,
      containers: [...el.querySelectorAll<HTMLElement>('[style*="position: absolute"]')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return `top=${Math.round(rect.top - host.top)} h=${Math.round(rect.height)} text="${(node.textContent ?? "").trim().slice(0, 24)}"`;
        })
        .slice(0, 5),
    };
  });
  expect(
    intersects(pill, bubbleBox),
    `bar ${JSON.stringify(pill)} overlaps the anchored bubble ${JSON.stringify(bubbleBox)}\n${JSON.stringify(diagnostics)}`,
  ).toBe(false);
  expect(pill.bottom, "the anchored bubble must start below the bar").toBeLessThanOrEqual(
    bubbleBox.top,
  );
});

test("R1-5 (R9): at 1440 wide the PANEL pushes the dialog — no card/summary pixel covered, the reader keeps their place", async ({
  page,
}) => {
  // The detail surface is the host's global right-panel now: a flex SIBLING of the routed
  // content that shrinks the chat column, never a layer over it (RightGlobalPanelHost's own
  // words: «an inline right column that PUSHES/shrinks the chat … NOT a fixed overlay»). So
  // «beside, not over» is stated the same way it always was — zero row pixels under the panel
  // box — while the scroll clause follows R9: a reader at the TOP stays at 0.
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  // Open turn 1's fleet so its member cards are on screen, then open the first card's agent.
  const fleet = timeline.locator("[data-agent-fleet]").first();
  await expect(fleet).toBeVisible();
  await fleet.click();
  await waitForTimelineQuiet(page);
  const card = timeline.locator("[data-agent-card]").first();
  await expect(card).toBeVisible();
  const timelineBefore = await boxOf(timeline);
  await card.locator(OPEN_AGENT_IN_PANEL).click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  await waitForTimelineQuiet(page);
  // R9 (a): the reader was at the top and the top is an absolute place.
  expect(
    Math.abs(await readScrollTop(page)),
    "the reader at the top stayed at 0",
  ).toBeLessThanOrEqual(1);
  // PUSH, not overlay: the chat column itself got narrower by (at least) the panel's width.
  const pane = await boxOf(inspector);
  const timelineAfter = await boxOf(timeline);
  const paneWidth = pane.right - pane.left;
  expect(paneWidth, "the panel is at least the family's minimum width").toBeGreaterThanOrEqual(320);
  expect(
    timelineBefore.right - timelineAfter.right,
    `the column must lose the panel's pixels: ${timelineBefore.right} → ${timelineAfter.right}`,
  ).toBeGreaterThanOrEqual(paneWidth - 1);
  // …and therefore no visible card / summary / fleet / block box intersects the panel at all.
  const covered = await page.evaluate(
    ({ timelineSelector, paneBox }) => {
      const root = document.querySelector(timelineSelector)!;
      const rows = [
        ...root.querySelectorAll<HTMLElement>(
          "[data-agent-card], [data-run-summary], [data-agent-fleet], [data-work-block]",
        ),
      ];
      const hits: string[] = [];
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const overlaps =
          rect.left < paneBox.right &&
          paneBox.left < rect.right &&
          rect.top < paneBox.bottom &&
          paneBox.top < rect.bottom;
        if (overlaps) {
          const attr = [...row.attributes].find((a) => a.name.startsWith("data-"))!;
          hits.push(
            `${attr.name}=${attr.value} right=${Math.round(rect.right)} > panel.left=${Math.round(paneBox.left)}`,
          );
        }
      }
      return hits;
    },
    { timelineSelector: TIMELINE, paneBox: pane },
  );
  expect(covered, `rows under the panel:\n${covered.join("\n")}`).toEqual([]);
  await closeExtendedViewPanel(page);
  expect(
    Math.abs(await readScrollTop(page)),
    "closing left the reader at the top",
  ).toBeLessThanOrEqual(1);
  const timelineClosed = await boxOf(timeline);
  expect(
    Math.abs(timelineClosed.right - timelineBefore.right),
    "the column must get its pixels back",
  ).toBeLessThanOrEqual(1);
});

for (const fixture of [SESSION_9388, SESSION_5EEB, SESSION_6C09]) {
  test(`R1-7 (${fixture.id.slice(0, 8)}): response → next bubble DOM gap ≤ 42 px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openFreshDraft(page);
    await switchToExtended(page);
    await replaySession(page, fixture, SETTLED);
    await expectExtendedMounted(page);
    // Shared with R2-1 (extendedView.ts): the bubble's border box vs the previous row's LAST
    // VISIBLE content; a user row directly followed by a user row is an EMPTY response (no
    // response row to measure from) — logged, outside this punch's target.
    const gaps = (await measureBubbleGaps(page)).filter(
      (gap): gap is typeof gap & { above: number; prevKind: string } => gap.above !== null,
    );
    console.log(
      `[R1-7 ${fixture.id.slice(0, 8)}] ${gaps.map((g) => `${g.above}px (${g.prevKind} → «${g.bubble}»)`).join(" | ")}`,
    );
    const responsePairs = gaps.filter((g) => g.prevKind !== "user");
    expect(
      responsePairs.length,
      "at least one response → bubble pair must be measured",
    ).toBeGreaterThan(0);
    // R13/R16: the hover strip is exactly the copy button's height, and that button is now
    // main's own `Button size="xs"` — 24px, not the 22px of the hand-rolled one. The rhythm
    // budget follows it: 24 (strip) + 16 (turn-end pb-4) + 2 (sub-pixel line-box rounding).
    const wide = responsePairs.filter((g) => g.above > 42 || g.above < 0);
    expect(wide, `gaps outside 0..42px: ${JSON.stringify(wide)}`).toEqual([]);
  });
}

test("R1-11: settled turn, background agents still running — the bar keeps them and coexists with the banner", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 6c096be2 to record 13 (three background launches mirrored into the registry, no
  // notification lands), then the turn ENDS after the hold: settled turn, agents running.
  await replaySession(page, SESSION_6C09, {
    pacing: { kind: "records", intervalMs: 60 },
    limit: 13,
    holdMs: 2_500,
  });
  const timeline = page.locator(TIMELINE);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 60_000 });
  // The owner-ruled composer banner (ChatView backgroundLivenessBannerItem, RU built bundle).
  const banner = page
    .getByText(/работа(ет|ют) в фоне|working in the background|Background work running/)
    .first();
  await expect(banner).toBeVisible({ timeout: 20_000 });
  // The bar KEEPS the running agents (R1-11 correction): a running count + agent chips.
  const bar = page.locator(CONTEXT_BAR);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/работа(ет|ют)|running/);
  expect(
    await bar
      .getByRole("button")
      .filter({ hasText: /Explore|general-purpose/ })
      .count(),
  ).toBeGreaterThanOrEqual(1);
  // The settled turn collapsed its fleet (P9) — the header counts the running agents; open
  // it and the member cards still say «работает» from the live registry.
  await scrollTo(page, 0);
  const fleet = timeline.locator("[data-agent-fleet]").first();
  await expect(fleet).toContainText(/работа(ет|ют)|running/);
  await fleet.click();
  await waitForTimelineQuiet(page);
  await expect(
    timeline.locator('[data-agent-card] [data-agent-status="running"]').first(),
  ).toBeVisible();
  // The two surfaces do not overlap.
  const barBox = await boxOf(
    bar
      .locator("div")
      .filter({ hasText: /работа|running/ })
      .first(),
  );
  const bannerBox = await boxOf(banner);
  expect(
    intersects(barBox, bannerBox),
    `bar ${JSON.stringify(barBox)} vs banner ${JSON.stringify(bannerBox)}`,
  ).toBe(false);
});

test("R1-12: mode switch mid-turn — nothing leaks in either direction", async ({ page }) => {
  test.setTimeout(150_000);
  await openFreshDraft(page);
  // Start in the COMPACT view with two background agents running and the turn parked.
  const switcher = page.getByTestId("extended-chat-switcher");
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  if (/Подробный|Detailed/.test(await switcher.innerText())) await switcher.click();
  await expect(switcher).toContainText(/Компактный|Compact/);
  // The replay knob is the one fake path that writes the TRANSCRIPT (cards for the extended
  // view) AND mirrors the launches onto the wire/registry (the main chat's CTA row): 6c096be2
  // to record 13, held — three background agents running, the turn open.
  writeFakeControl(readHarnessState(), {
    delayMs: 0,
    replay: {
      file: SESSION_6C09.file,
      subagentsDir: SESSION_6C09.subagentsDir,
      pacing: { kind: "records", intervalMs: 60 },
      limit: 13,
      holdMs: 90_000,
    },
  });
  await sendPrompt(page, "replay");
  // The main chat's spawn CTA row (MessagesTimeline AgentSpawnCtaRow) is on screen.
  const cta = page.getByRole("button", { name: /subagent|субагент/i }).first();
  await expect(cta).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(TIMELINE)).toHaveCount(0);
  // compact → detailed while the agents run
  await switcher.click();
  await expectExtendedMounted(page);
  await expect(page.getByRole("button", { name: /subagent|субагент/i })).toHaveCount(0);
  await expect(page.locator(TIMELINE).locator("[data-agent-card]").first()).toBeVisible({
    timeout: 20_000,
  });
  // R3(d): with the DETAIL PANEL open, leaving the extended view must CLOSE it — the panel
  // lives above the routes and would otherwise keep showing a thread that no longer renders.
  await page
    .locator(TIMELINE)
    .locator("[data-agent-card]")
    .first()
    .locator(OPEN_AGENT_IN_PANEL)
    .click();
  await expect(page.locator(INSPECTOR)).toHaveAttribute("data-inspector-kind", "agent");
  // detailed → compact
  await switcher.click();
  await expect(switcher).toContainText(/Компактный|Compact/);
  await expect(page.locator(TIMELINE)).toHaveCount(0);
  await expect(page.locator(CONTEXT_BAR)).toHaveCount(0);
  await expect(page.locator(INSPECTOR)).toHaveCount(0);
  await expect(
    page.locator("[data-agent-card], [data-run-summary], [data-agent-fleet]"),
  ).toHaveCount(0);
  await expect(cta).toBeVisible();
});
