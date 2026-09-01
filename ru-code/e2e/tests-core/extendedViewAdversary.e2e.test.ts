// ru-code (extended-view redesign, ADVERSARY seat): hostile-user / hostile-data attacks on the
// redesigned extended view, every one a numeric or DOM assertion over the REAL app. Written
// born-red against packages 3aaf64d / app 09c0ffbc7 (adversary-report.md holds the digest
// pairs); each case says what it attacks and what it does NOT prove. H1: every case switches to
// the extended view first and asserts it is mounted.
//
//   ADV-E1  a LATER streaming turn must not relabel 93888941's 9 file-only agents «работают»
//   ADV-E2  expanding a member inside the PANEL's block view must not move the dialog
//   ADV-E3  toggle storm — 3 rounds of open-all / close-all over blocks, fleets and folds:
//           every toggle in place (S1), no blank rows after each shrink (S5)
//   ADV-E4  RETIRED — the 1176px pane/sheet threshold went with the pane (see the note below)
//   ADV-E5  RETIRED — superseded by R2-E5a/b/c (see the note in place of the case below)
//   ADV-E6  an agent shown in the PANEL while its turn streams keeps its content through the settle
import { expect, readHarnessState, sendPrompt, test, writeFakeControl } from "./fixtures.ts";
import { SESSION_5EEB, SESSION_6C09, SESSION_9388 } from "../harness/realSessions.ts";
import {
  CONTEXT_BAR,
  INSPECTOR,
  closeExtendedViewPanel,
  OPEN_AGENT_IN_PANEL,
  OPEN_BLOCK_IN_PANEL,
  SCROLLER,
  TIMELINE,
  expectExtendedMounted,
  measureToggle,
  openFreshDraft,
  readScrollTop,
  replaySession,
  scrollTo,
  scrollUntilVisible,
  scroller,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";

const SETTLED = { pacing: { kind: "instant" }, mirrorRegistry: false } as const;
const ROW_ATTRS = [
  "data-run-summary",
  "data-work-block",
  "data-agent-fleet",
  "data-agent-card",
  "data-call-row",
  "data-task-marker",
  "data-agent-marker",
] as const;

const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

/** S5 predicate (L2's): every positioned row container with a height carries content. */
async function blankRows(page: import("@playwright/test").Page): Promise<string[]> {
  return await scroller(page).evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('[style*="position: absolute"]')]
      .filter((node) => node.getBoundingClientRect().height > 0)
      .filter((node) => node.textContent!.trim() === "" && node.querySelector("svg") === null)
      .map((node) => node.style.transform || node.style.top || "?"),
  );
}

/** Page through the virtualized list and collect every value of `attr` (row ids, in order). */
async function collectRowIds(
  page: import("@playwright/test").Page,
  attr: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const height = await scroller(page).evaluate((el) => el.scrollHeight);
  const step = await scroller(page).evaluate((el) => Math.max(200, el.clientHeight - 100));
  for (let top = 0; top <= height; top += step) {
    await scrollTo(page, top);
    const values = await page
      .locator(SCROLLER)
      .locator(`[${attr}]`)
      .evaluateAll((nodes, name) => nodes.map((node) => node.getAttribute(name)!), attr);
    for (const value of values) seen.add(value);
  }
  return [...seen];
}

/** A visible row near the top of the viewport (by its data attribute) and its top edge. */
async function referenceRow(
  page: import("@playwright/test").Page,
  attrs: ReadonlyArray<string> = ROW_ATTRS,
): Promise<{ selector: string; top: number }> {
  return await scroller(page).evaluate((el, attrs) => {
    const host = el.getBoundingClientRect();
    for (const attr of attrs) {
      for (const node of el.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0 && rect.top >= host.top + 60 && rect.top <= host.top + 420) {
          return {
            selector: `[${attr}="${node.getAttribute(attr)!.replaceAll('"', '\\"')}"]`,
            top: rect.top,
          };
        }
      }
    }
    throw new Error("no reference row in the viewport");
  }, attrs);
}

/** The row's top edge, or null when the row is no longer mounted (it left the render window). */
async function topOf(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<number | null> {
  return await page.evaluate(
    ({ scrollerSelector, rowSelector }) => {
      const node = document.querySelector(scrollerSelector)?.querySelector(rowSelector);
      return node === null || node === undefined ? null : node.getBoundingClientRect().top;
    },
    { scrollerSelector: SCROLLER, rowSelector: selector },
  );
}

test("ADV-E1: a LATER streaming turn does not relabel 93888941's 9 file-only agents «работают»", async ({
  page,
}) => {
  // Attacks: `threadLive = isWorking` (ExtendedMessagesTimeline.tsx) feeding `agentIsActive`
  // (`open` + threadLive), the bar's running list and the summary's running count. The 9
  // backgrounded launches of turns 1–13 have no closing evidence and NO registry row
  // (`mirrorRegistry: false`): nothing the app knows changes when the user sends a new message.
  // Does NOT prove: the label of an `open` launch inside the currently streaming turn.
  test.setTimeout(150_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_9388, { ...SETTLED, mirrorRegistry: false });
  await expectExtendedMounted(page);
  const bar = page.locator(CONTEXT_BAR);
  // Settled: the board is unfinished → the bar shows the tasks chip only, no running agents.
  await expect(bar).toBeVisible();
  await expect(bar).not.toContainText(/работа|running/);
  // The user sends a new message; the fake streams it for ~7 s (30 chunks × 250 ms).
  writeFakeControl(readHarnessState(), { delayMs: 0, stream: { chunks: 30, gapMs: 250 } });
  await sendPrompt(page, "hi again");
  const timeline = page.locator(TIMELINE);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toBeVisible({ timeout: 20_000 });
  const offenders: string[] = [];
  for (let sample = 0; sample < 15; sample += 1) {
    const barText = (await bar.innerText().catch(() => "")).replace(/\s+/g, " ");
    const runningCards = await timeline
      .locator('[data-agent-card] [data-agent-status="running"]')
      .count();
    const runningSummaries = await timeline
      .locator("[data-run-summary]")
      .filter({ hasText: /работа|running/ })
      .count();
    if (/работа|running/.test(barText) || runningCards > 0 || runningSummaries > 0) {
      offenders.push(
        `sample ${sample}: bar="${barText}" runningCards=${runningCards} runningSummaries=${runningSummaries}`,
      );
    }
    await page.waitForTimeout(300);
  }
  expect(offenders, offenders.join("\n")).toEqual([]);
});

test("ADV-E2: expanding a member inside the PANEL's block view does not move the dialog", async ({
  page,
}) => {
  // Attacks: the panel's block view renders the SAME `CallRow`s with the SAME
  // `callOpenOverrides` key as the dialog's member rows — opening one in the panel opens the
  // dialog's copy too; when that copy sits ABOVE the viewport its growth moves everything the
  // reader is looking at. The anchored path measures the PANEL's element (which does not
  // move), so it compensates nothing. The panel's own width never changes during the toggle,
  // so this is about the shared open-state, not about the column reflow (R9 owns that).
  // Does NOT prove: the dialog→panel direction (cosmetic).
  test.setTimeout(180_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  const inspector = page.locator(INSPECTOR);
  const blockIds = await collectRowIds(page, "data-work-block");
  expect(blockIds.length).toBeGreaterThan(0);
  let chosen: string | null = null;
  for (const id of blockIds) {
    const block = timeline.locator(`[data-work-block="${id}"]`);
    expect(await scrollUntilVisible(page, block)).toBe(true);
    const header = block.locator("button[aria-expanded]").first();
    if ((await header.getAttribute("aria-expanded")) !== "true") {
      await header.click();
      await waitForTimelineQuiet(page);
    }
    await block.locator(OPEN_BLOCK_IN_PANEL).dispatchEvent("click");
    await expect(inspector).toHaveAttribute("data-inspector-kind", "block");
    const members = await inspector.locator("[data-call-row]").count();
    if (members >= 2) {
      chosen = id;
      break;
    }
    await closeExtendedViewPanel(page);
  }
  expect(chosen, "a work block with ≥ 2 members").not.toBeNull();
  // The dialog's copy of the FIRST member goes just above the viewport (still mounted: the list
  // renders a buffer above), the reader looks at whatever follows.
  const firstMemberId = await inspector
    .locator("[data-call-row]")
    .first()
    .getAttribute("data-call-row");
  const dialogMember = timeline.locator(`[data-call-row="${firstMemberId!}"]`).first();
  await expect(dialogMember).toBeVisible();
  const hostTop = await scroller(page).evaluate((el) => el.getBoundingClientRect().top);
  const memberBottom = await dialogMember.evaluate((el) => el.getBoundingClientRect().bottom);
  await scrollTo(page, (await readScrollTop(page)) + (memberBottom - hostTop) + 120);
  const reference = await referenceRow(page);
  const scrollBefore = await readScrollTop(page);
  // Expand the member IN THE PANE.
  await inspector.locator("[data-call-row] button[aria-expanded]").first().click();
  await waitForTimelineQuiet(page);
  const scrollAfter = await readScrollTop(page);
  const topAfter = await topOf(page, reference.selector);
  const dialogCopyOpen = await dialogMember
    .locator("button[aria-expanded]")
    .first()
    .getAttribute("aria-expanded");
  expect(topAfter, `reference ${reference.selector} left the render window`).not.toBeNull();
  expect(
    Math.abs((topAfter as number) - reference.top),
    `dialog moved: reference ${reference.selector} top ${reference.top} → ${topAfter}; scrollTop ${scrollBefore} → ${scrollAfter}; dialog copy aria-expanded=${dialogCopyOpen}`,
  ).toBeLessThanOrEqual(1);
});

test("ADV-E3: toggle storm — 3 rounds open-all/close-all over blocks, fleets and folds: 0 jumps, 0 blank rows", async ({
  page,
}) => {
  // Attacks: S1 under repetition and S5 under shrink→grow→shrink (the legend-list stale-index
  // class): the impl-a S1 case toggles each kind ONCE; design-r1 OPEN-3b saw a work-block OPEN
  // anchorDelta 155 once. Every toggle is measured (scrollTop and row top, ±1 px) and every
  // shrink is followed by the blank-container sweep.
  // Does NOT prove: toggles while records are streaming (R2-E5a/b/c cover the settle).
  test.setTimeout(420_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, SETTLED);
  await expectExtendedMounted(page);
  const timeline = page.locator(TIMELINE);
  const failures: string[] = [];
  let toggles = 0;
  const sweep = async (label: string) => {
    const blank = await blankRows(page);
    if (blank.length > 0) failures.push(`${label}: blank rows ${blank.join(", ")}`);
  };
  // Row ids are stable (record uuids / step keys): collected ONCE, reused by every round.
  const idsByAttr = new Map<string, string[]>();
  for (const attr of ["data-work-block", "data-agent-fleet", "data-run-summary"]) {
    idsByAttr.set(attr, await collectRowIds(page, attr));
  }
  const toggleAll = async (attr: string, wantOpen: boolean, label: string) => {
    const ids = idsByAttr.get(attr) ?? [];
    for (const id of ids) {
      const row = timeline.locator(`[${attr}="${id}"]`);
      if (!(await scrollUntilVisible(page, row))) {
        failures.push(`${label} ${id}: row not found`);
        continue;
      }
      // The fleet row IS its button; blocks and summaries hold theirs (S1 spec's shape).
      const trigger = timeline
        .locator(`[${attr}="${id}"][aria-expanded], [${attr}="${id}"] button[aria-expanded]`)
        .first();
      const state = await trigger.getAttribute("aria-expanded");
      if ((state === "true") === wantOpen) continue;
      if ((await trigger.isDisabled().catch(() => false)) === true) continue;
      const measured = await measureToggle(page, trigger);
      toggles += 1;
      if (Math.abs(measured.scrollDelta) > 1 || Math.abs(measured.anchorDelta) > 1) {
        failures.push(
          `${label} ${measured.rowKey}: scrollDelta=${measured.scrollDelta} anchorDelta=${measured.anchorDelta} ${measured.diagnostics}`,
        );
      }
    }
  };
  for (let round = 1; round <= 3; round += 1) {
    await toggleAll("data-work-block", true, `r${round} open block`);
    await toggleAll("data-agent-fleet", true, `r${round} open fleet`);
    await sweep(`r${round} after grow`);
    await toggleAll("data-work-block", false, `r${round} close block`);
    await toggleAll("data-agent-fleet", false, `r${round} close fleet`);
    await sweep(`r${round} after shrink`);
    await toggleAll("data-run-summary", false, `r${round} fold response`);
    await sweep(`r${round} after fold`);
    await toggleAll("data-run-summary", true, `r${round} unfold response`);
    await sweep(`r${round} after unfold`);
  }
  console.log(`[ADV-E3] toggles measured: ${toggles}, failures: ${failures.length}`);
  expect(toggles).toBeGreaterThan(30);
  expect(failures, failures.join("\n")).toEqual([]);
});

// ADV-E4 RETIRED (sync wave R9): it guarded the container-query flip between the beside-PANE
// and the bottom SHEET at 1176px — a threshold that no longer exists. The detail surface is the
// host's global right-panel now: it PUSHES the column at every desktop width and becomes the
// family's sheet at the host's own 980px media query, neither of which is a per-width scroll
// hazard the way the transform-slide was. What survives of its promise — the column's scroll
// position across an open/replace/close — is S4' in extendedViewSessions.e2e.test.ts, measured
// at three park positions instead of four viewport widths.

// Round 3 additionally measured the axis at park depths 100/300/600/900 plus an armed send anchor,
// a pill return, a resize and an open inspector: zero scroll writers of any class in every case
// (adversary-r3-report.md §1). Nothing here is left unguarded; re-adding this case would only
// re-assert the false premise.

test("ADV-E6: an agent shown in the PANEL while its turn streams keeps its content through the settle", async ({
  page,
}) => {
  // Attacks: the panel's content reads the agent's attachment/approval back from EMITTED rows
  // (`derived.rows.find(agent-card …)`); a fleet member is emitted only while its fleet is open
  // and the fleet's default flips to CLOSED at settle (`?? unsettled`). The shown agent's
  // flow (fetched by entity, `ExtendedViewPanel`'s `inspectedCallId`) silently degrades to
  // the state-B fallback. Skipped-with-log when the agent's file did not attach before the
  // settle (nothing to lose then) — the unit spec ADV-5 pins the mechanism regardless.
  test.setTimeout(240_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 6c096be2 to record 13 (3 background launches + the foreground one), held 8 s, then settle.
  await replaySession(page, SESSION_6C09, {
    pacing: { kind: "records", intervalMs: 80 },
    limit: 13,
    holdMs: 8_000,
  });
  const timeline = page.locator(TIMELINE);
  const fleet = timeline.locator('[data-agent-fleet][aria-expanded="true"]').first();
  await expect(fleet).toBeVisible({ timeout: 20_000 });
  const card = timeline.locator("[data-agent-card]").first();
  const cardId = await card.getAttribute("data-agent-card");
  await card.locator(OPEN_AGENT_IN_PANEL).click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  // R4/R6: the panel's content root IS the scroller now (the pane's header moved into the
  // family's chrome), so the body to read is the located element itself.
  const body = inspector;
  const fallback =
    /не найден|не записана|not found|No inner activity|several agent logs|несколько журналов/;
  // Give the on-demand fetch a moment to attach the agent's own file.
  await expect
    .poll(async () => (await body.innerText()).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_500);
  const before = (await body.innerText()).replace(/\s+/g, " ").trim();
  const attachedBefore = !fallback.test(before);
  console.log(
    `[ADV-E6] card=${cardId} attached before settle=${attachedBefore} body="${before.slice(0, 160)}"`,
  );
  // The turn settles (hold elapses): the fleet closes by default.
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 60_000 });
  await waitForTimelineQuiet(page);
  await expect(timeline.locator('[data-agent-fleet][aria-expanded="false"]').first()).toBeVisible();
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  const after = (await body.innerText()).replace(/\s+/g, " ").trim();
  console.log(`[ADV-E6] after settle body="${after.slice(0, 160)}"`);
  test.skip(
    !attachedBefore,
    "the agent's file did not attach before the settle — nothing to lose here",
  );
  expect(
    fallback.test(after),
    `the pane fell back after the settle: "${after.slice(0, 200)}"`,
  ).toBe(false);
});
