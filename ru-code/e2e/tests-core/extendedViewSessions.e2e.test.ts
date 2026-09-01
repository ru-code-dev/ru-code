// ru-code (extended-view redesign): the REDESIGNED extended view on the owner's REAL
// sessions, in real Chromium against the real built app. The fake ACP's `replay` knob
// (H2) streams a real transcript into the thread; every case switches to the extended
// view first and asserts it is mounted (H1).
//
// What the concept promised (phase2-concept.md) and each case pins:
//   P1  run summary line only on responses that did work
//   P2  agent cards carry the ENTITY status (5eeb: a cancelled card WITH a relaunch link;
//       6c096be2: completed-via-notification vs open)
//   S4' the detail PANEL opens / replaces / closes without losing the reader's place, at
//       three park positions (R9); R6 no key press closes it
//   P6  the task board is one section per PLAN (93888941: turn 13 re-plans, F2 ruling)
//   G4/G5 no gap rows, no filter chips, no per-turn tasks row, no floating overlay in the DOM
//   S1  every NEW row kind toggles in place (scrollTop delta 0 ± 1)
import { expect, test } from "./fixtures.ts";
import { SESSION_5EEB, SESSION_6C09, SESSION_9388 } from "../harness/realSessions.ts";
import {
  INSPECTOR,
  closeExtendedViewPanel,
  OPEN_AGENT_IN_PANEL,
  readColumnView,
  readColumnViewSettled,
  TIMELINE,
  expectExtendedMounted,
  measureToggle,
  openFreshDraft,
  replaySession,
  scroller,
  scrollTo,
  wheelPark,
  scrollUntilVisible,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";

/** A SETTLED, FILE-ONLY session: everything lands at once, the turn ends, and the registry
 *  is NOT mirrored — these cases pin what the FILE says (a settled thread has no live
 *  registry to consult; the live states live in extendedViewLive.e2e.test.ts). */
const SETTLED = { pacing: { kind: "instant" }, mirrorRegistry: false } as const;

// Each case loads its own thread; independent, so one red never hides the others.
const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  // A React render error in the redesigned rows would surface here, not as a red locator.
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

test("H2 harness: the replay knob puts the REAL session's redesigned rows on screen", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  // The file's 7 human turns are 7 user bubbles; turn 1 launched 5 agents → a run summary
  // line + at least one agent card / fleet row exist in the DOM (virtualized: top of list).
  await scrollTo(page, 0);
  await expect(timeline.locator("[data-run-summary]").first()).toBeVisible({ timeout: 15_000 });
  await expect(timeline.locator("[data-agent-fleet], [data-agent-card]").first()).toBeVisible();
  // The retired forms are gone: no «Выполнено за …» fold row, no filter chips, no «+42с» gap.
  await expect(timeline.getByRole("button", { name: /Выполнено за|Done in/ })).toHaveCount(0);
  await expect(timeline.getByText(/^все$|^all$/)).toHaveCount(0);
  await expect(timeline.getByText(/^\+\d+(\.\d+)?\s?(с|s|м|m)/)).toHaveCount(0);
});

test("P1: a run summary line sits on every response that did work — and on none that did not", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 6c096be2: turn 1 (5 launches) has a summary; the tail turns («dfgd», «dfgdfg») are
  // trivial prose-only responses → no summary line (P1 "trivial responses: just prose").
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  const firstSummary = timeline.locator("[data-run-summary]").first();
  await expect(firstSummary).toBeVisible();
  // Turn 1's summary states the fleet: «5 агентов» (4 bg + 1 fg… the file's 5 launches in
  // turn 1) and the cancelled one is coloured — the counts come from the ENTITIES.
  await expect(firstSummary).toContainText(/агент|agent/);
  // The trivial tail: no summary is rendered BELOW the last user bubble («dfgdfg»). Compared
  // by GEOMETRY, never DOM order — LegendList recycles its row containers, so DOM order says
  // nothing about which row follows which.
  await scrollTo(page, "end");
  const tailUser = timeline.getByText("dfgdfg", { exact: true }).first();
  await expect(tailUser).toBeVisible();
  const summariesAfterTail = await page.evaluate((selector) => {
    const timelineEl = document.querySelector(selector);
    const bubble = [...(timelineEl?.querySelectorAll("*") ?? [])].find(
      (el) => el.childElementCount === 0 && el.textContent?.trim() === "dfgdfg",
    );
    if (!bubble) return -1;
    const bubbleBottom = bubble.getBoundingClientRect().bottom;
    return [...(timelineEl?.querySelectorAll("[data-run-summary]") ?? [])].filter(
      (summary) => summary.getBoundingClientRect().top >= bubbleBottom,
    ).length;
  }, TIMELINE);
  expect(summariesAfterTail, "a prose-only response must carry no run summary").toBe(0);
});

test("P2 (5eeb): a cancelled agent card says «отменён» and links to its relaunch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  // Turn 1's three launches are ONE fleet (closed on a settled turn); open it.
  const fleet = timeline.locator("[data-agent-fleet]").first();
  await expect(fleet).toBeVisible();
  await fleet.click();
  await waitForTimelineQuiet(page);
  // fork-80c5da56 «Create analysis scripts» was cancelled (notification L55) — the CARD
  // carries the entity status, never the launch result's «успешно» (I38 changed).
  const cancelledCard = timeline
    .locator("[data-agent-card]")
    .filter({ hasText: "Create analysis scripts" })
    .first();
  await expect(cancelledCard).toBeVisible();
  await expect(cancelledCard.locator('[data-agent-status="cancelled"]')).toBeVisible();
  await expect(cancelledCard.getByText(/перезапущен|relaunched/)).toBeVisible();
  // No card anywhere reads «успешно».
  await expect(timeline.locator("[data-agent-card]").getByText(/^успешно$|^success$/)).toHaveCount(
    0,
  );
});

test("P2 (6c096be2): completed-via-notification vs open cards; the fleet header counts them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  const fleet = timeline.locator("[data-agent-fleet]").first();
  await expect(fleet).toBeVisible();
  await fleet.click();
  await waitForTimelineQuiet(page);
  // general-purpose-57493924 and Explore-876672a8 were closed by notifications (L88/L91):
  // «завершён»; general-purpose-dee95829 never got one → «не подтверждён» on a settled file.
  await expect(
    timeline.locator('[data-agent-card] [data-agent-status="completed"]').first(),
  ).toBeVisible();
  await expect(
    timeline.locator('[data-agent-card] [data-agent-status="open"]').first(),
  ).toBeVisible();
  await expect(
    timeline
      .locator("[data-agent-card]")
      .getByText(/не подтверждён|unconfirmed/)
      .first(),
  ).toBeVisible();
});

test("S4' (R9): open / replace / close the PANEL — the reader's place in the column survives, at three park positions", async ({
  page,
}) => {
  // R9 restates S4 for a surface that REFLOWS the column instead of floating over it. The
  // panel is a flex sibling of the routed content (RightGlobalPanelHost, `shrink-0` + an
  // explicit width), so opening it takes those pixels off the chat column and the rows rewrap.
  // «Nothing moved» is therefore no longer «scrollTop is unchanged» — that would be a false
  // promise. What must hold, per park position:
  //   (a) a reader at the TOP stays at 0 (Δ ≤ 1) — the top is an absolute place;
  //   (b) a reader PINNED TO THE END stays pinned (distance-from-end Δ ≤ 1) — likewise;
  //   (c) a reader parked MID-SESSION keeps the SAME topmost row topmost (identity, not
  //       index), and that row's viewport offset drifts no more than the row's own height
  //       change — i.e. only what the rewrap itself accounts for.
  // Each is measured across OPEN, REPLACE (one block's members → another's) and CLOSE.
  //
  // EVERY opener is fired with `dispatchEvent("click")`, never `click()`: Playwright's click
  // scrolls its target into view first, which would move the reader itself and measure the
  // harness instead of the product. The AGENT CARD is the opener, because a card is mounted at
  // every one of the three parks in this session (measured: top 2, mid 1, end 1).
  // Does NOT prove: the narrow (≤ 980px) sheet, which does not reflow the column at all; and
  // REPLACE is measured only where the park has TWO distinct openers mounted (a replace needs
  // a second target reachable WITHOUT scrolling) — the case asserts at least one park measured
  // it, and logs the parks that could not.
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  const inspector = page.locator(INSPECTOR);
  const failures: string[] = [];

  /** The ids of every agent card currently MOUNTED, in list order. */
  const mountedCardIds = async (): Promise<string[]> =>
    await timeline
      .locator("[data-agent-card]")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute("data-agent-card") ?? "")
          .filter((id) => id.length > 0),
      );

  /** Open a mounted card's agent in the panel WITHOUT moving the reader. */
  const openCard = async (id: string): Promise<void> => {
    const card = timeline.locator(`[data-agent-card="${id}"]`).first();
    await card.locator(OPEN_AGENT_IN_PANEL).dispatchEvent("click");
    await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
    await waitForTimelineQuiet(page);
  };
  let replacesMeasured = 0;

  const drive = async (label: string, park: () => Promise<void>): Promise<void> => {
    if ((await inspector.count()) > 0) await closeExtendedViewPanel(page);
    await park();
    const before = await readColumnView(page);
    const cards = await mountedCardIds();
    if (cards.length === 0) {
      failures.push(`${label}: no agent card mounted here — nothing to open the panel with`);
      return;
    }

    const check = (
      step: string,
      after: Awaited<ReturnType<typeof readColumnViewSettled>>,
    ): void => {
      if (label === "top") {
        // The WORST offset seen across the settle window, not the one at the instant we looked:
        // the write this guards against lands after `waitForTimelineQuiet` says quiet (FLAKE-3).
        if (after.worstScrollTop > 1) {
          failures.push(`${label}/${step}: scrollTop 0 → ${after.worstScrollTop}`);
        }
        return;
      }
      if (label === "end") {
        // «Still at the end», not «the same number»: the column rewrapped, and the list's own
        // end keeper lands within its at-end band rather than on the exact pixel. 8px is a
        // third of the shortest row this view emits, so it cannot hide a lost row — measured
        // residual after the reflow: 4px on open and on close.
        if (after.worstFromEnd > 8) {
          failures.push(`${label}/${step}: fromEnd ${before.fromEnd} → ${after.worstFromEnd}`);
        }
        return;
      }
      if (after.topRowKey !== before.topRowKey) {
        failures.push(`${label}/${step}: topmost row ${before.topRowKey} → ${after.topRowKey}`);
        return;
      }
      // The column narrowed, so the row itself may have grown; the offset may drift by that
      // much and no more (plus 1px of sub-pixel rounding).
      const allowed = Math.abs(after.topRowHeight - before.topRowHeight) + 1;
      const drift = Math.abs(after.topRowOffset - before.topRowOffset);
      if (drift > allowed) {
        failures.push(
          `${label}/${step}: top row ${before.topRowKey} offset ${before.topRowOffset} → ${after.topRowOffset} (drift ${drift.toFixed(1)} > allowed ${allowed.toFixed(1)}; height ${before.topRowHeight} → ${after.topRowHeight})`,
        );
      }
    };

    await openCard(cards[0]!);
    check("open", await readColumnViewSettled(page));

    // REPLACE — a second card swaps the panel's content in the SAME instance (R3b): the panel
    // never unmounts, and the column must not move for a content swap at all. The candidate is
    // re-read HERE, not before the open: the column narrowed, so the list re-virtualized and
    // the set of mounted rows is not the one measured a moment ago.
    const second = (await mountedCardIds()).find((candidate) => candidate !== cards[0]);
    if (second !== undefined) {
      // Two agents can share a display NAME (`general-purpose` twice over), so the swap is
      // read off the whole body — the target header's description and the flow below it.
      const bodyBefore = (await inspector.innerText()).replace(/\s+/g, " ").trim();
      await openCard(second);
      await expect(inspector).toHaveCount(1);
      const bodyAfter = (await inspector.innerText()).replace(/\s+/g, " ").trim();
      expect(bodyAfter, `${label}: the panel did not swap content`).not.toBe(bodyBefore);
      replacesMeasured += 1;
      check("replace", await readColumnViewSettled(page));
    } else {
      console.log(`[S4' ${label}] replace not measured — only one opener is mounted here`);
    }

    // CLOSE — the family's ✕ hands the pixels back.
    await closeExtendedViewPanel(page);
    check("close", await readColumnViewSettled(page));
  };

  // EVERY park is a GESTURE. A programmatic `scrollTo` never cancels the live follow (the
  // controller's law), so the end glue would reclaim the end the moment the panel's reflow
  // re-measures the content — measured here as `top/open: scrollTop 0 → 2805` before the
  // parks were fixed. That is the product behaving correctly for a reader who never moved;
  // R1-1b learned the same lesson in round 2.
  await drive("top", async () => {
    await wheelPark(page, "top");
  });
  await drive("end", async () => {
    await wheelPark(page, "end");
  });
  await drive("mid", async () => {
    await wheelPark(page, "end");
    const height = await scroller(page).evaluate((el) => el.scrollHeight);
    const parked = await wheelPark(page, Math.round(height / 2));
    expect(parked, "the mid park must be neither the top nor the end").toBeGreaterThan(0);
  });
  expect(failures, failures.join("\n")).toEqual([]);
  expect(replacesMeasured, "no park could measure a content REPLACE").toBeGreaterThan(0);
});

test("R6: no key press closes the panel — Escape follows the family, which handles none", async ({
  page,
}) => {
  // The retired unit cases (`escapeClosesInspector`, 5 of them) guarded a bespoke window
  // keydown handler that no longer exists: the detail surface is a member of the global
  // right-panel family, and NOT ONE of those panels installs an Escape handler
  // (RightGlobalPanelHost / McpPanel / ItemsPanel: zero `Escape` sites). The surviving promise
  // is this one, and only the real app can show it.
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_6C09, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  const standalone = timeline
    .locator("[data-agent-card]")
    .filter({ hasText: "Verify & report results" });
  expect(await scrollUntilVisible(page, standalone), "the standalone card").toBe(true);
  await standalone.locator(OPEN_AGENT_IN_PANEL).click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitForTimelineQuiet(page);
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  // …and the ✕ still closes it, so the panel is not simply stuck.
  await closeExtendedViewPanel(page);
});

test("P6 (93888941): turn 13 RE-PLANS — a new board section, turn 1's plan superseded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_9388, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  // Turn 1's todo_write is a one-line MARKER («план создан 0/3 · версия 1»), not a call row
  // and not a per-turn «Задачи» block.
  const marker = timeline.locator("[data-task-marker]").first();
  await expect(marker).toBeVisible();
  await expect(marker).toContainText(/версия 1|version 1/);
  await expect(timeline.getByText(/^Задачи$|^Tasks$/)).toHaveCount(0);
  await marker.click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toHaveAttribute("data-inspector-kind", "tasks");
  // FIX-1 F2 ruling (I32): turn 13's list («Launch 3 fresh background agents…», ids 1–5)
  // shares only the small-integer COUNTERS with turn 1's — no item text in common — so it is
  // a NEW plan. Turn 1's plan therefore stands alone: 3 items, superseded, ONE version (no
  // stepper), and the re-plan sits in the fold beside it.
  await expect(inspector).toContainText(/заменён|superseded/);
  await expect(inspector).toContainText("0/3");
  await expect(inspector.getByText(/версия \d+\/\d+|version \d+\/\d+/)).toHaveCount(0);
  await expect(inspector.getByText(/Другие планы|Other plans/)).toHaveCount(1);
  await closeExtendedViewPanel(page);
  // Turn 13's plan is the CURRENT one: two versions (its two todo_writes join by id AND
  // text), latest 1/5, and it is not superseded.
  // The list recycles absolutely-positioned containers, so DOM order is not visual order:
  // the marker is chosen by its own text — turn 13's SECOND todo_write is «версия 2», the
  // only version-2 marker in this session (plan 1 has a single version).
  const last = timeline.locator("[data-task-marker]").filter({ hasText: /версия 2|version 2/ });
  expect(await scrollUntilVisible(page, last), "turn 13's second marker never mounted").toBe(true);
  await last.first().click();
  await expect(inspector).toHaveAttribute("data-inspector-kind", "tasks");
  await expect(inspector).toContainText(/версия 2\/2|version 2\/2/);
  await expect(inspector).toContainText("1/5");
  await expect(inspector.getByText(/заменён|superseded/)).toHaveCount(0);
  await closeExtendedViewPanel(page);
});

test("S1: every new row kind toggles in place (scrollTop delta 0 ± 1)", async ({ page }) => {
  test.setTimeout(180_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  await scrollTo(page, 0);
  const failures: string[] = [];
  const check = async (label: string, trigger: import("@playwright/test").Locator) => {
    // Virtualized list: page through it until the trigger is mounted.
    if (!(await scrollUntilVisible(page, trigger))) {
      failures.push(`${label}: trigger not found`);
      return;
    }
    const open = await measureToggle(page, trigger.first());
    if (Math.abs(open.scrollDelta) > 1 || Math.abs(open.anchorDelta) > 1) {
      failures.push(
        `${label} OPEN ${open.rowKey}: scrollDelta=${open.scrollDelta} anchorDelta=${open.anchorDelta} ${open.diagnostics}`,
      );
    }
    // The SAME row's trigger again (re-found by row id — the button may have been swapped;
    // the fleet row IS its own button, the others hold theirs).
    const sameRow = page
      .locator(TIMELINE)
      .locator(`${open.rowKey}[aria-expanded], ${open.rowKey} button[aria-expanded]`)
      .first();
    const close = await measureToggle(page, sameRow);
    if (Math.abs(close.scrollDelta) > 1 || Math.abs(close.anchorDelta) > 1) {
      failures.push(
        `${label} CLOSE ${close.rowKey}: scrollDelta=${close.scrollDelta} anchorDelta=${close.anchorDelta} ${close.diagnostics}`,
      );
    }
  };
  // The fleet header (agents), a work block (tools), the run-summary chevron (whole-response
  // fold). An agent card has no toggle (R2-2: a lone card is the card; the fleet header folds).
  await check("agent-fleet", timeline.locator("[data-agent-fleet]"));
  await check("work-block", timeline.locator("[data-work-block] button[aria-expanded]"));
  await check("run-summary", timeline.locator("[data-run-summary] button[aria-expanded]"));
  expect(failures, failures.join("\n")).toEqual([]);
});
