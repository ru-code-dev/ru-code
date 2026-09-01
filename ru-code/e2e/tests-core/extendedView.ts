// ru-code (extended-view redesign): shared driver for the EXTENDED-view specs.
//
// H1 (owner 2026-09-01): every extended-view spec switches the thread to the extended view
// through the real switcher (`data-testid="extended-chat-switcher"`, ChatViewMode
// "detailed") and asserts the extended timeline is MOUNTED before any other assertion — a
// spec must never test the compact view by accident. `switchToExtended` + `expectExtendedMounted`
// are that contract; the real-session loader below (`replaySession`) drives the fake ACP's
// `replay` knob, which streams a REAL transcript into the fake-bound thread.
import { expect, type Locator, type Page } from "@playwright/test";

import type { RealSessionFixture } from "../harness/realSessions.ts";
import {
  readHarnessState,
  sendPrompt,
  writeFakeControl,
  type FakeReplayControl,
} from "./fixtures.ts";

export const TIMELINE = '[data-testid="extended-chat-timeline"]';
export const SCROLLER = '[data-testid="extended-chat-scroller"]';
export const CONTEXT_BAR = '[data-testid="extended-chat-context-bar"]';
/** The DETAIL PANEL's content (sync wave R1/R7): the pane became the global right-panel's
 *  content, and its testid moved with it, so this still names exactly what the reader sees. */
export const INSPECTOR = '[data-testid="extended-chat-inspector"]';
/** The panel's own ✕ — the family's, in `DiffPanelShell`'s header row (R4). */
export const PANEL_CLOSE =
  '[aria-label="Закрыть панель подробного вида"], [aria-label="Close the extended view panel"]';
/** The openers, by their accessible name (R12 turned the native `title=` hints into real
 *  Tooltips; the ACTION hints kept an aria-label, which is what a spec should have been
 *  reading). Attribute selectors rather than `getByLabel`, so a spec can `dispatchEvent` on
 *  one without Playwright's actionability scrolling the reader's column first. */
export const OPEN_AGENT_IN_PANEL =
  '[aria-label="Открыть агента в панели"], [aria-label="Open the agent in the panel"]';
export const OPEN_BLOCK_IN_PANEL =
  '[aria-label="Открыть в панели"], [aria-label="Open in the panel"]';
const COMPOSER = 'div[contenteditable="true"]';

/** The REAL new-draft path (pencil → /draft/…; promotion navigates to the thread route). */
export async function openFreshDraft(page: Page): Promise<void> {
  await page.goto(readHarnessState().webUrl, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  const pencil = page.getByRole("button", { name: /New thread|Новый диалог/ }).first();
  // dispatchEvent: the pencil is hover-revealed; pointer emulation is intercepted.
  await pencil.dispatchEvent("click");
  await expect(page).toHaveURL(/\/draft\//, { timeout: 10_000 });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 20_000 });
}

/** H1: the switcher, never a role lookup; asserts the mode word flipped. */
export async function switchToExtended(page: Page): Promise<void> {
  const switcher = page.getByTestId("extended-chat-switcher");
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  if (/Компактный|Compact/.test(await switcher.innerText())) {
    await switcher.click();
  }
  await expect(switcher).toContainText(/Подробный|Detailed/);
}

/** H1: the extended timeline exists only once rows render — assert it after the first send. */
export async function expectExtendedMounted(page: Page): Promise<void> {
  await expect(page.locator(TIMELINE)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("extended-chat-switcher")).toContainText(/Подробный|Detailed/);
}

/**
 * Load a REAL session into the current (fresh) thread through the fake's `replay` knob:
 * the next prompt's turn REPLAYS `fixture.file` into the thread's transcript (its agent
 * tree copied under the fake session id) with the given pacing, mirroring background
 * launches into the fake's task registry. `pacing: instant` + no hold ⇒ a settled
 * session; a paced replay keeps the turn LIVE while records land (the live states).
 */
export async function replaySession(
  page: Page,
  fixture: RealSessionFixture,
  replay: Omit<FakeReplayControl, "file" | "subagentsDir">,
): Promise<void> {
  writeFakeControl(readHarnessState(), {
    delayMs: 0,
    replay: { file: fixture.file, subagentsDir: fixture.subagentsDir, ...replay },
  });
  await sendPrompt(page, "replay");
  await expectExtendedMounted(page);
  // The list is VIRTUALIZED and follows the live tail, so "the session rendered" is either
  // the scroll node growing past a one-turn height (a full replay) or the file's FIRST user
  // message being mounted (a short `limit` replay fits one viewport) — then turn 1 must be
  // at the top of the list.
  const firstUser = fixture.firstUser.slice(0, 40);
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ scrollerSelector, text }) => {
            const node = document.querySelector(scrollerSelector) as HTMLElement | null;
            if (!node) return false;
            return node.scrollHeight > 1_200 || (node.textContent ?? "").includes(text);
          },
          { scrollerSelector: SCROLLER, text: firstUser },
        ),
      { timeout: 30_000, message: "the replayed session never rendered" },
    )
    .toBe(true);
  await waitForTimelineQuiet(page);
  await scrollTo(page, 0);
  await expect(page.locator(TIMELINE).getByText(firstUser).first()).toBeVisible({
    timeout: 30_000,
  });
}

export const scroller = (page: Page): Locator => page.locator(SCROLLER).first();

/** Close the detail panel the way a reader does — the family's ✕. Escape is NOT a close path
 *  any more (R6: the panel follows the family, which installs no key handler at all). */
export async function closeExtendedViewPanel(page: Page): Promise<void> {
  await page.locator(PANEL_CLOSE).first().click();
  await expect(page.locator(INSPECTOR)).toHaveCount(0);
  await waitForTimelineQuiet(page);
}

export async function readScrollTop(page: Page): Promise<number> {
  return await scroller(page).evaluate((el) => el.scrollTop);
}

export async function scrollTo(page: Page, top: number | "end"): Promise<void> {
  await scroller(page).evaluate((el, target) => {
    el.scrollTop = target === "end" ? el.scrollHeight : (target as number);
  }, top);
  await waitForTimelineQuiet(page);
}

/**
 * Park the reader WITH A GESTURE, which is the only thing that takes the viewport from the
 * live follow (the controller's own law — R2-F10/F11; R1-1b learned this the hard way: a
 * programmatic `scrollTo` leaves the follow owning the viewport, and the end glue then
 * reclaims the end the moment anything re-measures).
 *
 * The gesture must MOVE the reader, or no scroll event fires and the controller never hears
 * them: parking at the top starts by wheeling AWAY from it, parking at the end starts by
 * wheeling away from the end, and only then does the loop travel to the target. Arriving at
 * the end under the reader's own wheel is also what re-arms the follow (a cancelled follow
 * comes back only from the reader), which is exactly the state an «end-pinned reader» means.
 */
export async function wheelPark(page: Page, target: number | "top" | "end"): Promise<number> {
  const box = await scroller(page).boundingBox();
  if (box === null) throw new Error("the extended scroller has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The unconditional first move, away from the target, so the reader is heard.
  await page.mouse.wheel(0, target === "top" ? 900 : target === "end" ? -900 : 0);
  await page.waitForTimeout(120);
  for (let step = 0; step < 300; step += 1) {
    const top = await readScrollTop(page);
    const fromEnd = await readDistanceFromEnd(page);
    if (target === "top") {
      if (top === 0) break;
      await page.mouse.wheel(0, -600);
    } else if (target === "end") {
      if (fromEnd <= 1) break;
      await page.mouse.wheel(0, 600);
    } else {
      if (Math.abs(top - target) <= 60 || fromEnd <= 1) break;
      await page.mouse.wheel(0, top < target ? 400 : -400);
    }
    await page.waitForTimeout(60);
  }
  await waitForTimelineQuiet(page);
  return await readScrollTop(page);
}

/** Frame-quiet predicate (never wall clock): the scroll node held the same scrollTop AND
 *  scrollHeight for 12 consecutive rAF polls. */
export async function waitForTimelineQuiet(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => {
      const w = window as unknown as {
        __evQuiet?: { top: number; height: number; frames: number };
      };
      const node = document.querySelector(selector) as HTMLElement | null;
      if (!node) return false;
      const top = node.scrollTop;
      const height = node.scrollHeight;
      if (w.__evQuiet !== undefined && w.__evQuiet.top === top && w.__evQuiet.height === height) {
        w.__evQuiet.frames += 1;
      } else {
        w.__evQuiet = { top, height, frames: 0 };
      }
      return w.__evQuiet.frames >= 12;
    },
    SCROLLER,
    { timeout: 30_000, polling: "raf" },
  );
  await page.evaluate(() => {
    delete (window as unknown as { __evQuiet?: unknown }).__evQuiet;
  });
}

export interface ToggleMeasurement {
  /** scrollTop after − before (S1: 0 ± 1). */
  readonly scrollDelta: number;
  /** The toggled ROW's viewport top after − before (the row visibly stayed put). */
  readonly anchorDelta: number;
  readonly before: number;
  readonly after: number;
  /** The row identity the measurement was taken on (`data-<kind>="<id>"`). */
  readonly rowKey: string;
  /** The row's LegendList container style + duplicate-attribute count + list scrollHeight,
   *  before → after (for a red S1). */
  readonly diagnostics: string;
}

const ROW_ATTRS = [
  "data-run-summary",
  "data-agent-fleet",
  "data-agent-card",
  "data-work-block",
  "data-call-row",
  "data-task-marker",
] as const;

/** R9 — what the reader's column looks like, in one measurement: where the viewport sits, how
 *  far it is from the end, and the identity + viewport offset + HEIGHT of the topmost visible
 *  row. Identity, never index: the list recycles absolutely positioned containers. The height
 *  is part of it because the panel PUSHES the column — a narrower column rewraps text, so a
 *  row legitimately grows, and the offset may drift by exactly that much and no more. */
export interface ColumnView {
  readonly scrollTop: number;
  readonly fromEnd: number;
  readonly topRowKey: string | null;
  readonly topRowOffset: number;
  readonly topRowHeight: number;
}

/**
 * The same measurement, taken over a WINDOW instead of at one instant, plus the worst offset
 * seen during it.
 *
 * FLAKE-3: `waitForTimelineQuiet` declares quiet after 12 rAF of stable scrollTop AND
 * scrollHeight, and the compensation that moved a reader parked at 0 by 23px landed AFTER that
 * — so a single sample turned a real defect into a 1-in-3 lottery (2 of 6 executions red, same
 * numbers both times). Watching for a window makes the assertion decide the same way every run.
 */
export async function readColumnViewSettled(
  page: Page,
  windowMs = 700,
): Promise<ColumnView & { readonly worstScrollTop: number; readonly worstFromEnd: number }> {
  const worst = await scroller(page).evaluate(async (el, ms) => {
    let worstTop = Math.abs(el.scrollTop);
    let worstEnd = el.scrollHeight - el.clientHeight - el.scrollTop;
    const started = performance.now();
    while (performance.now() - started < ms) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      worstTop = Math.max(worstTop, Math.abs(el.scrollTop));
      worstEnd = Math.max(worstEnd, el.scrollHeight - el.clientHeight - el.scrollTop);
    }
    return { worstTop, worstEnd };
  }, windowMs);
  const view = await readColumnView(page);
  return { ...view, worstScrollTop: worst.worstTop, worstFromEnd: worst.worstEnd };
}

export async function readColumnView(page: Page): Promise<ColumnView> {
  return await scroller(page).evaluate((el, attrs) => {
    const box = el.getBoundingClientRect();
    let topRowKey: string | null = null;
    let topRowOffset = 0;
    let topRowHeight = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const node of el.querySelectorAll<HTMLElement>(attrs.map((a) => `[${a}]`).join(","))) {
      const rect = node.getBoundingClientRect();
      // The first row whose BOTTOM is still inside the viewport: a row scrolled half off the
      // top is what the reader is looking at, so a strictly-inside test would skip it.
      if (rect.height <= 0 || rect.bottom <= box.top + 1) continue;
      const offset = rect.top - box.top;
      if (offset < best) {
        best = offset;
        for (const attr of attrs) {
          const value = node.getAttribute(attr);
          if (value !== null) {
            topRowKey = `${attr}=${value}`;
            break;
          }
        }
        topRowOffset = offset;
        topRowHeight = rect.height;
      }
    }
    return {
      scrollTop: el.scrollTop,
      fromEnd: el.scrollHeight - el.clientHeight - el.scrollTop,
      topRowKey,
      topRowOffset,
      topRowHeight,
    };
  }, ROW_ATTRS);
}

/**
 * S1 measurement: bring `trigger` into the middle of the viewport, wait for quiet, record
 * scrollTop + the toggled ROW's viewport top, click, wait for quiet, measure the SAME row
 * again. The row is re-found by its `data-<kind>="<id>"` — never by DOM order: LegendList
 * recycles containers, so `.first()` after a commit can be a different row, and a toggle
 * that swaps its trigger subtree (agent card) leaves the old button detached.
 */
export async function measureToggle(page: Page, trigger: Locator): Promise<ToggleMeasurement> {
  await trigger.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await waitForTimelineQuiet(page);
  const rowKey = await trigger.evaluate((el, attrs) => {
    for (const attr of attrs) {
      const row = el.closest(`[${attr}]`);
      if (row !== null) return `[${attr}="${row.getAttribute(attr)!.replaceAll('"', '\\"')}"]`;
    }
    throw new Error("trigger is not inside a known row");
  }, ROW_ATTRS);
  const row = page.locator(SCROLLER).locator(rowKey).first();
  // Diagnostics for a red S1: the row's positioned container (LegendList item) and the list.
  const snapshot = () =>
    row.evaluate((el) => {
      const container = el.closest<HTMLElement>('[style*="position: absolute"]');
      const scrollNode = el.closest<HTMLElement>('[data-testid="extended-chat-scroller"]');
      return `container="${container?.getAttribute("style") ?? "?"}" matches=${document.querySelectorAll(`[${[...el.attributes].find((a) => a.name.startsWith("data-"))!.name}]`).length} scrollHeight=${scrollNode?.scrollHeight ?? -1}`;
    });
  const before = await readScrollTop(page);
  const anchorBefore = await row.evaluate((el) => el.getBoundingClientRect().top);
  const snapshotBefore = await snapshot();
  await trigger.click();
  await waitForTimelineQuiet(page);
  const after = await readScrollTop(page);
  const anchorAfter = await row.evaluate((el) => el.getBoundingClientRect().top);
  const snapshotAfter = await snapshot();
  return {
    scrollDelta: after - before,
    anchorDelta: anchorAfter - anchorBefore,
    before,
    after,
    rowKey,
    diagnostics: `[before ${snapshotBefore}] [after ${snapshotAfter}]`,
  };
}

/** rAF scrollTop recorder on the extended scroller (frame samples for S2/S3). */
export async function startScrollRecorder(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node) throw new Error("extended scroller not mounted");
    const w = window as unknown as {
      __evTrace?: Array<{ t: number; top: number; height: number }>;
      __evStop?: () => void;
    };
    w.__evStop?.();
    const trace: Array<{ t: number; top: number; height: number }> = [];
    w.__evTrace = trace;
    let frame = 0;
    const sample = () => {
      trace.push({ t: performance.now(), top: node.scrollTop, height: node.scrollHeight });
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    w.__evStop = () => cancelAnimationFrame(frame);
  }, SCROLLER);
}

export async function stopScrollRecorder(
  page: Page,
): Promise<ReadonlyArray<{ t: number; top: number; height: number }>> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __evTrace?: Array<{ t: number; top: number; height: number }>;
      __evStop?: () => void;
    };
    w.__evStop?.();
    return w.__evTrace ?? [];
  });
}

/** Distance from the bottom edge (0 = pinned at the end). */
export async function readDistanceFromEnd(page: Page): Promise<number> {
  return await scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

/** Virtualized search: page through the list until `target` is in the DOM, then centre it. */
export async function scrollUntilVisible(page: Page, target: Locator): Promise<boolean> {
  const height = await scroller(page).evaluate((el) => el.scrollHeight);
  const step = await scroller(page).evaluate((el) => Math.max(200, el.clientHeight - 100));
  for (let top = 0; top <= height; top += step) {
    await scrollTo(page, top);
    if ((await target.count()) > 0) {
      await target.first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await waitForTimelineQuiet(page);
      return true;
    }
  }
  return false;
}

export interface BubbleGap {
  /** The bubble's text (first 40 chars) — the measurement's identity. */
  readonly bubble: string;
  /** The row right ABOVE the bubble: `data-*` marker, `user`, or `prose/other`; null = none. */
  readonly prevKind: string | null;
  /** Bubble border-box top − the previous row's LAST VISIBLE content bottom (px, 0.1). */
  readonly above: number | null;
  /** The row right BELOW the bubble, same vocabulary; null = none mounted / not adjacent. */
  readonly nextKind: string | null;
  /** The next row's FIRST VISIBLE content top − bubble border-box bottom (px, 0.1). */
  readonly below: number | null;
}

/**
 * R1-7 / R2-1 measurement: for every user bubble, the gap between the bubble's BORDER BOX
 * and the VISIBLE content of the rows right above and right below it (opacity-0 hover strips
 * do not count — a reader cannot see them; padding does not count either). Rows are matched
 * by geometry, never DOM order (LegendList recycles containers); the whole list is paged
 * through so every bubble is measured once.
 */
export async function measureBubbleGaps(page: Page): Promise<BubbleGap[]> {
  const seen = new Map<string, BubbleGap>();
  // Park the pointer off the list: a row under the mouse shows its hover strip (opacity 1),
  // which would count as visible content and shrink the measured gap (run 05: 19.3 vs 38.3).
  await page.mouse.move(0, 0);
  const height = await scroller(page).evaluate((el) => el.scrollHeight);
  const step = await scroller(page).evaluate((el) => Math.max(200, el.clientHeight - 200));
  for (let top = 0; top <= height; top += step) {
    await scrollTo(page, top);
    const found = await scroller(page).evaluate((el) => {
      const containers = [...el.querySelectorAll<HTMLElement>('[style*="position: absolute"]')]
        .filter((node) => node.getBoundingClientRect().height > 0)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const isHidden = (node: Element, stop: Element): boolean => {
        for (
          let cur: Element | null = node;
          cur !== null && cur !== stop;
          cur = cur.parentElement
        ) {
          const style = getComputedStyle(cur);
          if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none")
            return true;
        }
        return false;
      };
      const visibleLeaves = (container: Element): DOMRect[] => {
        const rects: DOMRect[] = [];
        for (const node of container.querySelectorAll<HTMLElement>("*")) {
          if (node.childElementCount > 0 && node.tagName !== "svg") continue;
          const hasContent = node.tagName === "svg" || (node.textContent ?? "").trim().length > 0;
          if (!hasContent) continue;
          if (isHidden(node, container)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.height === 0) continue;
          rects.push(rect);
        }
        return rects;
      };
      const kindOf = (container: Element): string => {
        const marked = container.querySelector<HTMLElement>(
          "[data-run-summary],[data-agent-card],[data-agent-fleet],[data-work-block],[data-call-row],[data-task-marker],[data-agent-marker]",
        );
        if (marked) return [...marked.attributes].find((a) => a.name.startsWith("data-"))!.name;
        return container.querySelector(".rounded-2xl.bg-message") ? "user" : "prose/other";
      };
      const round = (value: number): number => Math.round(value * 10) / 10;
      const out: BubbleGap[] = [];
      for (let index = 0; index < containers.length; index += 1) {
        const container = containers[index]!;
        const bubble = container.querySelector<HTMLElement>(".rounded-2xl.bg-message");
        if (bubble === null) continue;
        const box = bubble.getBoundingClientRect();
        const rect = container.getBoundingClientRect();
        let prevKind: string | null = null;
        let above: number | null = null;
        const prev = containers[index - 1];
        // Adjacent by geometry: the neighbour must end where this row starts (and vice versa).
        if (prev !== undefined && Math.abs(prev.getBoundingClientRect().bottom - rect.top) <= 1) {
          const bottoms = visibleLeaves(prev).map((leaf) => leaf.bottom);
          if (bottoms.length > 0) {
            prevKind = kindOf(prev);
            above = round(box.top - Math.max(...bottoms));
          }
        }
        let nextKind: string | null = null;
        let below: number | null = null;
        const next = containers[index + 1];
        if (next !== undefined && Math.abs(next.getBoundingClientRect().top - rect.bottom) <= 1) {
          const tops = visibleLeaves(next).map((leaf) => leaf.top);
          if (tops.length > 0) {
            nextKind = kindOf(next);
            below = round(Math.min(...tops) - box.bottom);
          }
        }
        out.push({
          bubble: (bubble.textContent ?? "").trim().slice(0, 40),
          prevKind,
          above,
          nextKind,
          below,
        });
      }
      return out;
    });
    // A bubble measured twice (paging overlap): keep the fuller measurement.
    for (const entry of found) {
      const known = seen.get(entry.bubble);
      const fullness = (gap: BubbleGap) => Number(gap.above !== null) + Number(gap.below !== null);
      if (known === undefined || fullness(entry) > fullness(known)) seen.set(entry.bubble, entry);
    }
  }
  return [...seen.values()];
}
