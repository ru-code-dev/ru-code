// ru-code (extended-view redesign, design review round 2): the punches' browser acceptance
// on the REAL built app (design-review-2.md). Every case switches to the extended view first
// and asserts it is mounted (H1).
//   R2-1  whitespace around user bubbles, measured between the bubble's BORDER BOX and the
//         adjacent rows' VISIBLE content (never padding, never opacity-0 hover strips):
//         ≤ 40 px above the bubble, ≤ 32 px below it — every bubble of all three sessions
//   R2-2  one visual language for an agent: the lone «Verify & report results» card (6c096be2)
//         wears the SAME card box as a fleet member (class list identical modulo the fleet
//         indent), carries NO fold button (the fleet header keeps its chevron), and its body
//         click opens the detail PANEL on that agent
import { expect, test } from "@playwright/test";

import { SESSION_5EEB, SESSION_6C09, SESSION_9388 } from "../harness/realSessions.ts";
import {
  INSPECTOR,
  closeExtendedViewPanel,
  OPEN_AGENT_IN_PANEL,
  TIMELINE,
  expectExtendedMounted,
  measureBubbleGaps,
  openFreshDraft,
  replaySession,
  scrollTo,
  scrollUntilVisible,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";

const SETTLED = { pacing: { kind: "instant" }, mirrorRegistry: false } as const;
// SYNC WAVE R13/R15 restate both budgets, because the spacing they measure is now MAIN's and
// not this view's own trim:
//   ABOVE — the response's hover strip is exactly the copy button's height, and R13 made that
//     button main's 24px one (was 22): 24 + 16 (turn-end pb-4) = 40, +2 for sub-pixel rounding.
//   BELOW — R15 gave the user row main's own `pb-4` and its content-sized 24px strip, so the
//     bubble sits 4 (gap-1) + 24 + 16 = 44 above the next row, plus that row's own top offset.
//     The old 32 was this view's deliberate trim BELOW the bubble, which the owner replaced
//     with parity. Measured across the three real sessions: 46.3 … 48.8.
const ABOVE_MAX_PX = 42;
const BELOW_MAX_PX = 50;
/** The only difference a fleet member may carry: the fleet indent (AgentCards.tsx). */
const FLEET_INDENT = " ms-4";

const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

for (const fixture of [SESSION_9388, SESSION_5EEB, SESSION_6C09]) {
  test(`R2-1 (${fixture.id.slice(0, 8)}): bubble border box → adjacent content: ≤ ${ABOVE_MAX_PX} px above, ≤ ${BELOW_MAX_PX} px below`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openFreshDraft(page);
    await switchToExtended(page);
    await replaySession(page, fixture, SETTLED);
    await expectExtendedMounted(page);
    const gaps = await measureBubbleGaps(page);
    console.log(
      `[R2-1 ${fixture.id.slice(0, 8)}] ${gaps
        .map(
          (g) =>
            `«${g.bubble}»: ${g.prevKind ?? "—"} ${g.above ?? "—"} ▲ | ▼ ${g.below ?? "—"} ${g.nextKind ?? "—"}`,
        )
        .join(" || ")}`,
    );
    // A user row next to a user row is an EMPTY response (nothing to trim toward) — logged
    // above, outside the punch's target; everything else is measured.
    const above = gaps.filter((g) => g.above !== null && g.prevKind !== "user");
    const below = gaps.filter((g) => g.below !== null && g.nextKind !== "user");
    expect(above.length, "at least one content → bubble pair").toBeGreaterThan(0);
    expect(below.length, "at least one bubble → content pair").toBeGreaterThan(0);
    const aboveWide = above.filter((g) => g.above! > ABOVE_MAX_PX || g.above! < 0);
    const belowWide = below.filter((g) => g.below! > BELOW_MAX_PX || g.below! < 0);
    expect(aboveWide, `above the bubble outside 0..${ABOVE_MAX_PX}px`).toEqual([]);
    expect(belowWide, `below the bubble outside 0..${BELOW_MAX_PX}px`).toEqual([]);
  });
}

test("R2-2 (6c096be2): the lone agent wears the fleet member's card — same box, no fold, click → panel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  // Turn 1: the three background launches are a fleet (closed when settled) — open it so a
  // member card is on screen; the foreground launch L12 is the lone card right below.
  const fleet = timeline.locator("[data-agent-fleet]").first();
  await expect(fleet).toBeVisible();
  await fleet.click();
  await waitForTimelineQuiet(page);
  const member = timeline.locator("[data-agent-card]").first();
  await expect(member).toBeVisible();
  const memberClass = (await member.getAttribute("class")) ?? "";
  expect(memberClass, "a fleet member carries the fleet indent").toContain(FLEET_INDENT);
  const lone = timeline.locator("[data-agent-card]").filter({ hasText: "Verify & report results" });
  expect(await scrollUntilVisible(page, lone), "the lone card").toBe(true);
  const loneClass = (await lone.first().getAttribute("class")) ?? "";
  expect(loneClass).toBe(memberClass.replace(FLEET_INDENT, ""));
  // Nothing to fold on a lone card: no aria-expanded control, ONE button (the body).
  await expect(lone.first().locator("button[aria-expanded]")).toHaveCount(0);
  await expect(lone.first().locator("button")).toHaveCount(1);
  // The fleet header keeps its chevron (it folds its members).
  await expect(fleet).toHaveAttribute("aria-expanded", "true");
  // Body click → the detail PANEL on THIS agent.
  await lone.first().locator(OPEN_AGENT_IN_PANEL).click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  await expect(inspector).toContainText("Verify & report results");
  await closeExtendedViewPanel(page);
});
