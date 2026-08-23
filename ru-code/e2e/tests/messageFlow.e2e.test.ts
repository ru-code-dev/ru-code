// ru-code: THE 5 user-reported cases (WORKFLOW/E2E-HARNESS.md) as real-Chrome
// specs against the real app + fake ACP. RED here = the bug reproduced; these
// stay as the permanent regression net once fixed.
//
//  case 1 — switch to Подробный, send → the switcher must STAY Подробный.
//  case 2 — (with a 3s CLI delay) the sent message must render instantly.
//  case 3 — after a view switch, send → the message parks at the viewport top.
//  case 4 — with history, each send = ONE smooth animated upward motion
//            (no down-then-up jerk).
//  case 5 — after F5 in an existing chat, send keeps the SAME animated motion
//            (no instant snap, no missing scroll).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Page } from "@playwright/test";

import {
  analyzeTrace,
  expect,
  installScrollInstrumentation,
  readHarnessState,
  test,
  writeFakeControl,
  type ScrollSample,
} from "./fixtures.ts";

const ARTIFACTS = NodePath.join(import.meta.dirname, "../.artifacts");
const TIMELINE = '[data-testid="extended-chat-timeline"]';

const state = () => readHarnessState();

const COMPOSER = 'div[contenteditable="true"]';

async function openFreshThread(page: Page): Promise<void> {
  await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
  // Predicate, not a sleep: a visible sidebar thread row IS the proof the env
  // supervisor connected and the orchestration subscription delivered data —
  // driving the UI any earlier hard-fails subscriptions.
  await expect(
    page.locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]').first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]')
    // ru-code: bilingual — the shipped bundle localizes this row.
    .filter({ hasText: /New thread|Новый поток/ })
    .first()
    .click();
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 20_000 });
}

/** The REAL new-draft path: the sidebar pencil button navigates to
 *  `/draft/$draftId` (useHandleNewThread.ts) — promotion later NAVIGATES to
 *  `/{env}/{threadId}`, which is where the view-mode degrade lives. Clicking a
 *  thread ROW (openFreshThread) lands on the server-thread route directly and
 *  never crosses that boundary. */
async function openFreshDraft(page: Page): Promise<void> {
  await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
  // Same env-connected predicate as openFreshThread (see there).
  await expect(
    page.locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]').first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  const pencil = page.getByRole("button", { name: /New thread|Новый диалог/ }).first();
  // dispatchEvent: pointer emulation is intercepted by the project-header menu
  // button (the pencil is hover-revealed); the React onClick fires fine.
  await pencil.dispatchEvent("click");
  await expect(page).toHaveURL(/\/draft\//, { timeout: 10_000 });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 20_000 });
}

/** Live-DOM probe: every data-testid on the page + the switcher's real markup —
 *  locators get corrected from THIS dump, never re-guessed. */
async function dumpDomProbe(page: Page, label: string): Promise<void> {
  const probe = await page.evaluate(() => ({
    url: location.href,
    testIds: [...document.querySelectorAll("[data-testid]")].map(
      (el) => el.getAttribute("data-testid") ?? "",
    ),
    switcherHtml:
      document.querySelector('[data-testid="extended-chat-switcher"]')?.outerHTML ?? null,
    composerCount: document.querySelectorAll('div[contenteditable="true"]').length,
  }));
  NodeFS.writeFileSync(NodePath.join(ARTIFACTS, `${label}.json`), JSON.stringify(probe, null, 2));
}

async function switchToExtended(page: Page): Promise<void> {
  await dumpDomProbe(page, "dom-probe-before-switch");
  const switcher = page.getByTestId("extended-chat-switcher");
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  if ((await switcher.innerText()).includes("Компактный")) {
    await switcher.click();
  }
  await expect(switcher).toContainText("Подробный");
  // NOTE: the timeline testid only exists once rows render (the empty-thread
  // extended view shows its own empty state) — asserted after the first send.
}

async function send(
  page: Page,
  text: string,
  options?: { readonly beforeEnter?: () => Promise<void> },
): Promise<void> {
  const input = page.locator(COMPOSER).first();
  // VERIFY-BEFORE-ENTER: under CPU throttle the click's focus can land AFTER
  // the keystrokes start — characters silently go to <body> and Enter sends
  // nothing. Type, PROVE the composer holds the text, only then send; a
  // partial/empty landing clears and retypes.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.click();
    await page.keyboard.type(text);
    try {
      await expect(input).toContainText(text.slice(-12), { timeout: 5_000 });
      break;
    } catch {
      await input.press("ControlOrMeta+A");
      await page.keyboard.press("Delete");
    }
  }
  await expect(input).toContainText(text.slice(-12), { timeout: 5_000 });
  // Fires once, immediately before the FIRST Enter keypress below — never
  // before a retry — so a caller that starts the scroll recorder here gets
  // the narrowest possible pre-send window (structural fix, case5-verdict.md
  // optional hardening).
  await options?.beforeEnter?.();
  // VERIFY-AFTER-ENTER: a successful send CLEARS the composer. Under throttle
  // the app can still be settling the previous turn when Enter lands and
  // swallows it — the text stays put; re-press until the composer empties.
  let cleared = false;
  for (let attempt = 0; attempt < 8 && !cleared; attempt += 1) {
    await page.keyboard.press("Enter");
    try {
      await expect(input).not.toContainText(text.slice(-12), { timeout: 2_500 });
      cleared = true;
    } catch {
      // still holding the text — the send was swallowed; try again
    }
  }
  if (cleared) {
    // DOUBLE-SUBMIT GUARD: the re-press loop must have produced exactly ONE
    // message bubble. Scoped to the extended timeline (page-wide the text also
    // appears in the sidebar row / thread header) and matched on the EXACT full
    // text (suffix matching collided across this suite's numbered messages that
    // share a tail). Compact-view sends (no timeline mounted) skip the guard.
    const timeline = page.locator(TIMELINE);
    if ((await timeline.count()) > 0) {
      await expect(timeline.getByText(text, { exact: true })).toHaveCount(1, {
        timeout: 5_000,
      });
    }
    return;
  }
  await expect(input, "the composer never accepted the send").not.toContainText(text.slice(-12));
}

/** Send and wait for the fake's response text to render in the timeline. */
async function sendAndAwaitResponse(page: Page, text: string, response: string): Promise<void> {
  writeFakeControl(state(), { delayMs: 0, responseText: response });
  await send(page, text);
  await expect(page.getByText(response).last()).toBeVisible({ timeout: 12_000 });
}

async function collectTrace(page: Page): Promise<ScrollSample[]> {
  return await page.evaluate(() => window.__scrollTrace ?? []);
}

async function dumpScrollEvidence(page: Page, label: string): Promise<void> {
  const trace = await collectTrace(page);
  const writers = await page.evaluate(() => window.__scrollWriters ?? []);
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, `${label}.json`),
    JSON.stringify({ trace, writers: writers.slice(-80) }, null, 2),
  );
  await page.screenshot({ path: NodePath.join(ARTIFACTS, `${label}.png`), fullPage: false });
}

test.describe.configure({ mode: "serial" });

// Console capture — every case writes its browser console to the artifacts.
const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
// Playwright REQUIRES the object destructuring pattern for the fixtures
// parameter (it parses it to decide which fixtures to instantiate); this hook
// needs none, so the pattern is legitimately empty. Test-layer suppression.
// eslint-disable-next-line no-empty-pattern
test.afterEach(({}, testInfo) => {
  NodeFS.writeFileSync(
    NodePath.join(
      ARTIFACTS,
      `console-${testInfo.title.replaceAll(/[^a-z0-9]+/gi, "-").slice(0, 60)}.txt`,
    ),
    consoleLines.join("\n"),
  );
});

test("case 1: the view mode SURVIVES the first send (real draft path)", async ({ page }) => {
  await openFreshDraft(page);
  await switchToExtended(page);
  writeFakeControl(state(), { delayMs: 0, responseText: "Ответ по делу." });
  await send(page, "первый вопрос — режим должен остаться Подробный");
  // Promotion navigates /draft/<id> → /<env>/<threadId> — wait for the crossing,
  // THEN probe which surface actually renders.
  await expect(page).not.toHaveURL(/\/draft\//, { timeout: 12_000 });
  await expect(page.getByText("Ответ по делу.").last()).toBeVisible({ timeout: 12_000 });
  const surfaceProbe = await page.evaluate(() => ({
    url: location.href,
    extendedMounted: document.querySelector('[data-testid="extended-chat-timeline"]') !== null,
    switcherText:
      document.querySelector('[data-testid="extended-chat-switcher"]')?.textContent ?? null,
    bodyHasResponse: document.body.textContent?.includes("Ответ по делу.") ?? false,
  }));
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, "case1-surface.json"),
    JSON.stringify(surfaceProbe, null, 2),
  );
  // The regression flips the switcher back to Компактный on thread promotion.
  await expect(page.getByTestId("extended-chat-switcher")).toContainText("Подробный");
  await expect(page.locator(TIMELINE)).toBeVisible();
});

test("case 2: the sent message renders INSTANTLY even with a slow CLI", async ({ page }) => {
  await openFreshThread(page);
  await switchToExtended(page);
  writeFakeControl(state(), { delayMs: 3_000, responseText: "Поздний ответ." });
  const message = "медленный старт — но меня видно сразу";
  await send(page, message);
  // The bubble must appear from app state immediately — NOT after the CLI's
  // 3s JSONL write. 1.5s budget = generous UI latency, far below the delay.
  await expect(page.locator(TIMELINE).getByText(message)).toBeVisible({ timeout: 1_500 });
  // And it must never blink out while the real record lands: wait for the
  // PROOF the CLI's JSONL write arrived (the response is on screen), then the
  // optimistic bubble must still be there — the swap was atomic.
  await expect(page.getByText("Поздний ответ.").last()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(TIMELINE).getByText(message)).toBeVisible();
});

/** One instrumented send: record the scroll from the moment of send through the
 *  response render, measure the user bubble's final offset from the viewport
 *  top, and dump trace + writer stacks per send. Returns the evidence instead
 *  of asserting so a multi-send case can show EVERY send's behavior at once. */
interface SendEvidence {
  readonly label: string;
  readonly totalDelta: number;
  readonly reversalPx: number;
  readonly movingFrames: number;
  readonly maxStepPx: number;
  readonly offsetAfterAnimation: number | null;
  readonly offsetAfterResponse: number | null;
}

/** PREDICATE WAIT — no wall clock: resolves when the scroll recorder's tail
 *  sat unmoved for 6 consecutive rAF samples. The recorder is rAF-driven, so
 *  on a throttled/slow machine the samples stretch and the wait stretches with
 *  them. A send that never moves still resolves (after 30 quiet frames), so
 *  "did not scroll" surfaces as a clean verdict, not a timeout. */
/** Recorder-independent quiet predicate: resolves once the extended timeline's
 *  scroll node held the same scrollTop for 12 consecutive rAF polls. Used where
 *  the scroll recorder is not running yet — counts FRAMES, never wall clock. */
async function waitForTimelineQuiet(page: Page): Promise<void> {
  await page.waitForFunction(
    (timelineSelector) => {
      const w = window as unknown as { __quietProbe?: { top: number; frames: number } };
      const host = document.querySelector(timelineSelector);
      const node = (host?.querySelector('[data-testid="extended-chat-scroller"]') ??
        host?.querySelector('[class*="overscroll-y-contain"]') ??
        host) as HTMLElement | null;
      if (!node) return false;
      if (w.__quietProbe !== undefined && w.__quietProbe.top === node.scrollTop) {
        w.__quietProbe.frames += 1;
      } else {
        w.__quietProbe = { top: node.scrollTop, frames: 0 };
      }
      return w.__quietProbe.frames >= 12;
    },
    TIMELINE,
    { timeout: 30_000, polling: "raf" },
  );
  await page.evaluate(() => {
    delete (window as unknown as { __quietProbe?: unknown }).__quietProbe;
  });
}

/** STRENGTHENED settle gate for post-reload restores (case 5 only — see
 *  WORKFLOW/current/analyses/case5-verdict.md). Resolves once the recorder's
 *  target node held the same `scrollTop` AND `scrollHeight`, with no new
 *  traced scroll-writer call, for 30 consecutive rAF polls. `scrollHeight` is
 *  the causal signal (LegendList's post-restore `scrollAdjust` fires because
 *  content size changed); the writer-count clause observes the app's scroll
 *  COMMANDS directly rather than their side effects. Byte-proven from the
 *  failing trace: `waitForTimelineQuiet`'s 12-frame threshold resolves INSIDE
 *  the 251ms gap between the mount-settle burst and the restore's `scrollBy`
 *  burst, so it would not have closed this race — 30 frames plus the two extra
 *  clauses clears it with ~1.8s margin. Node resolution mirrors
 *  `__startScrollRecorder` (fixtures.ts) exactly so the gate and the recorder
 *  agree on the element. */
async function waitForScrollSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    (timelineSelector) => {
      const w = window as unknown as {
        __settleProbe?: { top: number; height: number; writers: number; frames: number };
        __scrollWriters?: unknown[];
      };
      const host = document.querySelector(timelineSelector);
      const node = (host?.querySelector('[data-testid="extended-chat-scroller"]') ??
        host?.querySelector('[class*="overscroll-y-contain"]') ??
        host) as HTMLElement | null;
      if (!node) return false;
      const top = node.scrollTop;
      const height = node.scrollHeight;
      const writers = w.__scrollWriters?.length ?? 0;
      if (
        w.__settleProbe !== undefined &&
        w.__settleProbe.top === top &&
        w.__settleProbe.height === height &&
        w.__settleProbe.writers === writers
      ) {
        w.__settleProbe.frames += 1;
      } else {
        w.__settleProbe = { top, height, writers, frames: 0 };
      }
      return w.__settleProbe.frames >= 30;
    },
    TIMELINE,
    // OWNER-SET FAIL-FAST CONTRACT: settle must be quick — worst measured ~1.2s.
    { timeout: 2_000, polling: "raf" },
  );
  await page.evaluate(() => {
    delete (window as unknown as { __settleProbe?: unknown }).__settleProbe;
  });
}

async function waitForScrollStable(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const trace = window.__scrollTrace;
      if (!trace || trace.length < 8) return false;
      const tail = trace.slice(-6);
      const stable = tail.every((sample) => sample.top === tail[0]!.top);
      if (!stable) return false;
      const moved = trace.some((sample) => sample.top !== trace[0]!.top);
      // No motion yet: distinguish "won't move" (a real bug — resolve so the
      // verdict reports it) from "hasn't started" (commit work still running).
      // 90 quiet FRAMES — never wall clock, so a slow machine stretches the
      // patience together with the animation start it is waiting for.
      return moved || trace.length >= 90;
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function instrumentedSend(
  page: Page,
  text: string,
  response: string,
  label: string,
): Promise<SendEvidence> {
  // Realistic CLI latency — the user's live repro runs against a 2-5s CLI and
  // the jerk shows between the send and the response records landing.
  writeFakeControl(state(), { delayMs: 1_200, responseText: response });
  // Recorder starts in send()'s beforeEnter hook, immediately before the first
  // Enter keypress — the measured window IS the send window (case5-verdict.md
  // optional hardening: structural cure for the whole instrumentedSend class).
  await send(page, text, {
    beforeEnter: async () => {
      await page.evaluate((selector) => window.__startScrollRecorder?.(selector), TIMELINE);
    },
  });
  // Upper bound only (resolves the moment it renders) — generous enough for a
  // 10×-throttled commit; the INSTANT-render guarantee is case 2's assertion.
  const bubble = page.locator(TIMELINE).getByText(text);
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  // The send-scroll animation window — settled by CONVERGENCE, not sleep.
  await waitForScrollStable(page);
  const measureOffset = async (): Promise<number | null> => {
    const bubbleBox = await bubble.boundingBox();
    const hostBox = await page.locator(TIMELINE).boundingBox();
    return bubbleBox && hostBox ? bubbleBox.y - hostBox.y : null;
  };
  const offsetAfterAnimation = await measureOffset();
  await expect(page.getByText(response).last()).toBeVisible({ timeout: 15_000 });
  await waitForScrollStable(page);
  const offsetAfterResponse = await measureOffset();
  const verdict = analyzeTrace(await collectTrace(page));
  await dumpScrollEvidence(page, label);
  const evidence: SendEvidence = { label, ...verdict, offsetAfterAnimation, offsetAfterResponse };
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, `${label}-evidence.json`),
    JSON.stringify(evidence, null, 2),
  );
  return evidence;
}

function expectSmoothPinnedSend(
  evidence: SendEvidence,
  options?: { readonly throttled?: boolean },
): string[] {
  const failures: string[] = [];
  if (Math.abs(evidence.totalDelta) < 20) {
    failures.push(`${evidence.label}: did not scroll (totalDelta=${evidence.totalDelta})`);
  }
  if (evidence.reversalPx >= 8) {
    failures.push(`${evidence.label}: moved down-then-up (reversalPx=${evidence.reversalPx})`);
  }
  // ANIMATION QUALITY (default-view parity — the user SEES the difference):
  // the browser's smooth scroll spends ~14+ frames on a ~160px hop. A send that
  // covers ≥100px must (a) move across at least 6 frames and (b) never carry
  // more than half the distance in ONE frame — a 3-frame burst with one big
  // step reads as a push/snap even though it technically "moved".
  // Under CPU throttle frames legitimately get fewer and bigger (the browser's
  // smooth scroll is time-based), so the throttled variant asserts correctness
  // (scrolls, one direction, pinned, no teleport) — not frame aesthetics.
  if (options?.throttled === true) {
    // No frame-count check under throttle: the rAF recorder lives on the
    // throttled MAIN thread while the scroll animates on the COMPOSITOR
    // thread — at 10× one sample can span the whole animation. The throttled
    // invariants are correctness ones: scrolls, one direction, pinned, no
    // drift (all asserted above/below).
  } else if (Math.abs(evidence.totalDelta) >= 100) {
    if (evidence.movingFrames < 6) {
      failures.push(
        `${evidence.label}: pushed, not animated (movingFrames=${evidence.movingFrames} for ${evidence.totalDelta}px)`,
      );
    }
    if (evidence.maxStepPx > Math.abs(evidence.totalDelta) * 0.5) {
      failures.push(
        `${evidence.label}: snap step (maxStepPx=${evidence.maxStepPx} of ${evidence.totalDelta}px total)`,
      );
    }
  } else if (evidence.movingFrames < 2) {
    failures.push(`${evidence.label}: instant snap (movingFrames=${evidence.movingFrames})`);
  }
  if (evidence.offsetAfterAnimation === null || evidence.offsetAfterAnimation >= 90) {
    failures.push(
      `${evidence.label}: bubble not pinned to top after send (offset=${evidence.offsetAfterAnimation})`,
    );
  }
  if (evidence.offsetAfterResponse !== null && evidence.offsetAfterResponse >= 90) {
    failures.push(
      `${evidence.label}: bubble drifted off the top when the response landed (offset=${evidence.offsetAfterResponse})`,
    );
  }
  return failures;
}

const TALL_RESPONSE = (n: number) =>
  `Ответ №${n} — несколько строк,\nчтобы у истории была высота,\nскроллу было куда двигаться,\nи виртуализация работала\nкак в живом чате.`;

test("case 4: EVERY subsequent send is one smooth upward motion (user repro)", async ({ page }) => {
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  // First send promotes the draft; sends 2..4 are the user's repro window
  // («second, third... message sometimes doesn't scroll / moves down then up»).
  await sendAndAwaitResponse(page, "вопрос №1 — заводим историю", TALL_RESPONSE(1));
  const allFailures: string[] = [];
  for (let index = 2; index <= 4; index += 1) {
    const evidence = await instrumentedSend(
      page,
      `вопрос №${index} — пузырь должен уехать вверх одним движением`,
      TALL_RESPONSE(index),
      `case4-send-${index}`,
    );
    allFailures.push(...expectSmoothPinnedSend(evidence));
  }
  expect(allFailures, allFailures.join("\n")).toEqual([]);
});

test("case 6: send from a scrolled-up position in a LONG history", async ({ page }) => {
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  for (let index = 1; index <= 6; index += 1) {
    await sendAndAwaitResponse(page, `история №${index} — наращиваем высоту`, TALL_RESPONSE(index));
  }
  // The user goes back to read OLD messages — far from the bottom.
  await page.locator(TIMELINE).hover();
  await page.mouse.wheel(0, -1_200);
  await waitForTimelineQuiet(page);
  // A send from up there must still be ONE smooth animated motion that parks
  // the new bubble at the viewport top (main-chat parity) — no jerk, no snap.
  const evidence = await instrumentedSend(
    page,
    "вопрос из середины истории — одно движение к верху",
    TALL_RESPONSE(7),
    "case6-scrolled-up-send",
  );
  const failures = expectSmoothPinnedSend(evidence);
  expect(failures, failures.join("\n")).toEqual([]);
});

test("case 7: a landing response must NOT move the viewport while the user reads above", async ({
  page,
}) => {
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  await sendAndAwaitResponse(page, "вопрос №1 — база", TALL_RESPONSE(1));
  // Slow turn: the bubble pins, then the user walks away BEFORE the answer.
  writeFakeControl(state(), { delayMs: 3_000, responseText: TALL_RESPONSE(2) });
  await send(page, "вопрос №2 — уйду читать выше");
  await expect(page.locator(TIMELINE).getByText("вопрос №2 — уйду читать выше")).toBeVisible({
    timeout: 3_000,
  });
  // Send animation settle + wheel settle: frame-quiet predicates, no clocks.
  await waitForTimelineQuiet(page);
  await page.locator(TIMELINE).hover();
  await page.mouse.wheel(0, -300);
  await waitForTimelineQuiet(page);
  await page.evaluate((selector) => window.__startScrollRecorder?.(selector), TIMELINE);
  // The response streams into the RESERVED space below — the viewport the user
  // parked must not move by a single frame (anchor kept, follow cancelled).
  await expect(page.getByText("Ответ №2").last()).toBeVisible({ timeout: 8_000 });
  // Recorder is live here — the stable-tail predicate replaces the old 600ms.
  await waitForScrollStable(page);
  const trace = await collectTrace(page);
  await dumpScrollEvidence(page, "case7-read-above");
  const verdict = analyzeTrace(trace);
  expect(
    Math.abs(verdict.totalDelta),
    "viewport must stay where the user parked it while the response lands",
  ).toBeLessThan(8);
  expect(verdict.reversalPx, "no transient jump either way").toBeLessThan(8);
});

test("case 8: 10× CPU throttle — sends stay correct on a slow machine", async ({ page }) => {
  // The settle logic is state-based (frames + convergence, zero wall-clock),
  // so a machine ~10× slower must produce the SAME terminal state: one-way
  // motion, bubble pinned, no mid-flight freeze (the old 750ms fallback froze
  // mid-animation exactly here). CDP CPU throttling approximates the machine.
  test.setTimeout(180_000);
  await installScrollInstrumentation(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 10 });
  try {
    await openFreshDraft(page);
    await switchToExtended(page);
    await sendAndAwaitResponse(page, "вопрос №1 — медленная машина", TALL_RESPONSE(1));
    // PROMOTION BOUNDARY: under throttle the /draft→/thread navigation lands
    // seconds late; typing into the still-draft composer would be wiped by the
    // re-key (a real race the harness must not enter blind). Cross it first.
    await expect(page).not.toHaveURL(/\/draft\//, { timeout: 30_000 });
    await expect(page.locator(TIMELINE)).toBeVisible({ timeout: 30_000 });
    const failures: string[] = [];
    for (let index = 2; index <= 3; index += 1) {
      const evidence = await instrumentedSend(
        page,
        `вопрос №${index} — медленная машина, но всё корректно`,
        TALL_RESPONSE(index),
        `case8-throttled-send-${index}`,
      );
      failures.push(...expectSmoothPinnedSend(evidence, { throttled: true }));
    }
    expect(failures, failures.join("\n")).toEqual([]);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
});

test("case 5: F5 → the next send still scrolls (user repro)", async ({ page }) => {
  await installScrollInstrumentation(page);
  // Exact user path: extended thread with ONE turn → F5 → send again.
  await openFreshDraft(page);
  await switchToExtended(page);
  await sendAndAwaitResponse(page, "вопрос до перезагрузки", TALL_RESPONSE(1));
  // PROMOTION BOUNDARY (case-8 precedent): the draft-hero view transition
  // defers the /draft→/thread navigation. The user's repro is F5 in an
  // EXISTING chat — reloading while still on the /draft URL would instead land
  // on a fresh wizard draft (the promoted draft session is gone from storage),
  // which is a different scenario. Cross the boundary first.
  await expect(page).not.toHaveURL(/\/draft\//, { timeout: 15_000 });
  // CACHE-WARM PREDICATE: on reload the thread route's not-found guard trusts
  // the RESTORED IndexedDB shell cache; an F5 fired before the cache learned
  // the just-promoted thread bounces to the root wizard (fresh-thread race —
  // NOT this spec's scenario; an «existing chat» has a warm cache by
  // definition). State-based wait: the cached shell snapshot must contain this
  // thread before we reload.
  const promotedThreadId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect
    .poll(
      () =>
        page.evaluate(async (threadId) => {
          const openRequest = indexedDB.open("ruCode:connection-runtime");
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            openRequest.addEventListener("success", () => resolve(openRequest.result), {
              once: true,
            });
            openRequest.addEventListener("error", () => reject(openRequest.error), { once: true });
          });
          try {
            const values = await new Promise<unknown[]>((resolve, reject) => {
              const getAll = database
                .transaction("shell", "readonly")
                .objectStore("shell")
                .getAll();
              getAll.addEventListener("success", () => resolve(getAll.result), { once: true });
              getAll.addEventListener("error", () => reject(getAll.error), { once: true });
            });
            return JSON.stringify(values).includes(threadId);
          } finally {
            database.close();
          }
        }, promotedThreadId),
      {
        timeout: 15_000,
        message: "the cached shell snapshot must learn the promoted thread before F5",
      },
    )
    .toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 12_000 });
  // The view must still be Подробный from the thread state — the user does NOT
  // touch the switcher after F5.
  await expect(page.getByTestId("extended-chat-switcher")).toContainText("Подробный", {
    timeout: 10_000,
  });
  await expect(page.locator(TIMELINE)).toBeVisible({ timeout: 10_000 });
  // POST-RELOAD SETTLE GATE (case5-verdict.md): LegendList re-measures the
  // restored rows and issues compensating scrollBy calls AFTER the timeline
  // mounts but BEFORE this point; gate on the restored turn's content, then on
  // scroll quiet, so the recorder's window in instrumentedSend opens only once
  // that restore transient is over — never a wall-clock sleep.
  await expect(page.locator(TIMELINE).getByText("вопрос до перезагрузки")).toBeVisible({
    timeout: 10_000,
  });
  await waitForScrollSettled(page);
  const evidence = await instrumentedSend(
    page,
    "вопрос после F5 — скролл обязан работать",
    "Ответ после перезагрузки — тоже\nв несколько строк,\nчтобы было куда скроллить.",
    "case5-f5-send",
  );
  const failures = expectSmoothPinnedSend(evidence);
  expect(failures, failures.join("\n")).toEqual([]);
});
