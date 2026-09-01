// ru-code (extended-view redesign): the LIVE states of the redesigned extended view —
// producible only through the fake ACP's two new knobs (fake-acp-server.ts FlowControl):
//   `replay` (H2) streams a REAL session record by record while the turn stays open and
//            mirrors its background launches / completions into the task registry, so the
//            app's live agent facts (W1) reach the cards and the context bar;
//   `approval` (H3) parks a `session/request_permission` behind a RUNNING call / agent.
// Every case switches to the extended view first and asserts it is mounted (H1).
//
//   L1  running agents: cards say «работает», the context bar counts them and JUMPS
//   L2  status flips from the LIVE registry (5eeb: cancel → «отменён», completion →
//       «завершён») + S3 follow (pinned at the end through streaming, flips, bar) +
//       S5 settle (blocks collapse, no blank tail rows, still pinned)
//   L3  approval parked on a TOOL call: the call is OPEN, highlighted, box visible, bar chip
//   L4  approval parked on a SUBAGENT: the agent CARD carries the box (concept §9 A1)
//   L5  S2: a send with the redesigned rows present is one smooth upward motion
import {
  analyzeTrace,
  expect,
  installScrollInstrumentation,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "./fixtures.ts";
import { SESSION_5EEB, SESSION_6C09 } from "../harness/realSessions.ts";
import {
  CONTEXT_BAR,
  INSPECTOR,
  closeExtendedViewPanel,
  OPEN_AGENT_IN_PANEL,
  TIMELINE,
  expectExtendedMounted,
  openFreshDraft,
  readDistanceFromEnd,
  readScrollTop,
  replaySession,
  scrollTo,
  scrollUntilVisible,
  scroller,
  startScrollRecorder,
  stopScrollRecorder,
  switchToExtended,
  waitForTimelineQuiet,
} from "./extendedView.ts";

const state = () => readHarnessState();

const consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines.length = 0;
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
});
test.afterEach(() => {
  expect(consoleLines.filter((line) => line.startsWith("[pageerror]"))).toEqual([]);
});

test("L1: running agents — cards say «работает», the context bar counts them and jumps", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 6c096be2 records 1–13: user, prose, the 3 background launches (L4) + their results
  // (L8–L10), the foreground launch (L12). Stop there and HOLD: three agents are running
  // in the registry, nothing has completed — the live fleet.
  await replaySession(page, SESSION_6C09, {
    pacing: { kind: "records", intervalMs: 80 },
    limit: 13,
    holdMs: 90_000,
  });
  const timeline = page.locator(TIMELINE);
  // The live turn is never collapsed (I13): the fleet is OPEN and its cards are rows.
  const cards = timeline.locator("[data-agent-card]");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  await expect(
    timeline.locator('[data-agent-card] [data-agent-status="running"]').first(),
  ).toBeVisible();
  // The bar counts ACTIVE entities: the 3 background launches say running from the LIVE
  // registry (priority 1) and the foreground launch (L12, no result yet) is `open` on a
  // live thread → «работает» too — 4, with one chip per agent (name · elapsed). R1-4: the
  // count word takes the Russian plural («4 работают»).
  const bar = page.locator(CONTEXT_BAR);
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(bar).toContainText(/4 работают|4 running/);
  await expect(bar.getByRole("button").filter({ hasText: /Explore|general-purpose/ })).toHaveCount(
    4,
  );
  // A bar chip jumps: opens the PANEL on that agent AND brings its card into view.
  const chip = bar
    .getByRole("button")
    .filter({ hasText: /Explore|general-purpose/ })
    .first();
  const chipName = (await chip.innerText()).split("\n")[0]?.trim() ?? "";
  await chip.click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-inspector-kind", "agent");
  // R4 — the panel's own header is the family's static title; the AGENT's identity is the
  // body's first block, so that is where the chip's name has to land.
  await expect(inspector.locator("[data-inspector-target-header]")).toContainText(
    chipName.split(" ")[0] ?? chipName,
  );
  await waitForTimelineQuiet(page);
  await expect(
    cards.filter({ hasText: chipName.split(" ")[0] ?? chipName }).first(),
  ).toBeInViewport();
  await closeExtendedViewPanel(page);
});

/** S3 verdict over a distance-from-end trace: the reader pinned at the end may lose the
 *  bottom for at most 3 frames after a row lands (the glue writes on the next commit), and
 *  ends pinned. Returns the violations (empty = followed). */
function followViolations(
  trace: ReadonlyArray<{ t: number; top: number; height: number }>,
  clientHeight: number,
): string[] {
  const failures: string[] = [];
  const distance = (sample: { top: number; height: number }) =>
    sample.height - clientHeight - sample.top;
  for (let index = 0; index < trace.length; index += 1) {
    const away = distance(trace[index]!);
    if (away <= 8) continue;
    const recovered = trace.slice(index + 1, index + 5).some((sample) => distance(sample) <= 8);
    if (!recovered) {
      failures.push(
        `frame ${index} (t=${Math.round(trace[index]!.t)}): ${Math.round(away)}px from the end, not recovered within 4 frames`,
      );
      if (failures.length >= 5) break;
    }
  }
  const last = trace.at(-1);
  if (last !== undefined && distance(last) > 2) {
    failures.push(`ended ${Math.round(distance(last))}px from the end`);
  }
  return failures;
}

test("L2: live status flips + S3 follow through streaming/flips/bar + S5 settle collapse", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  // 5eeb: 154 records; the fleet launches at L8–L13, fork-80c5da56 is CANCELLED by the
  // notification at L55, fork-fbb4c264 COMPLETES at L105. 90 ms/record ≈ 14 s of streaming.
  await replaySession(page, SESSION_5EEB, {
    pacing: { kind: "records", intervalMs: 90 },
    holdMs: 4_000,
  });
  const timeline = page.locator(TIMELINE);
  // Phase A — the send anchor holds turn 1's top in view (I48), so the fleet cards are ON
  // SCREEN while records stream below. Flip 1: the registry (mirrored notification L55)
  // says fork-80c5da56 was cancelled → amber «отменён» on the CARD while the turn is live.
  const analysisCards = timeline
    .locator("[data-agent-card]")
    .filter({ hasText: "Create analysis scripts" });
  await expect(analysisCards.first()).toBeVisible({ timeout: 20_000 });
  await expect(analysisCards.locator('[data-agent-status="running"]').first()).toBeVisible();
  await expect(analysisCards.locator('[data-agent-status="cancelled"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(CONTEXT_BAR)).toBeVisible();
  // Phase B — the reader goes to the END and stays there: from here every landed record,
  // every status flip and the bar must keep the viewport pinned (S3). The PILL is the
  // user's way to release the anchor and follow (`scrollToEndAndFollow`); plain scroll
  // when the pill is not showing (already at the end).
  const pill = page.getByRole("button", { name: /Прокрутить вниз|Scroll to end/ });
  if (await pill.isVisible().catch(() => false)) {
    await pill.click();
    await waitForTimelineQuiet(page);
  } else {
    await scrollTo(page, "end");
  }
  const clientHeight = await scroller(page).evaluate((el) => el.clientHeight);
  await startScrollRecorder(page);
  // The turn SETTLES after the last record + hold: the working row goes, blocks collapse
  // (S5), and the reader is still at the end.
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toBeVisible({ timeout: 10_000 });
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 60_000 });
  await waitForTimelineQuiet(page);
  const trace = await stopScrollRecorder(page);
  const violations = followViolations(trace, clientHeight);
  expect(trace.length, "the recorder must have sampled the stream").toBeGreaterThan(200);
  expect(violations, violations.join("\n")).toEqual([]);
  // S5 — no blank (unmounted) tail rows after the shrink: every positioned row container
  // that has a height carries content.
  const rows = await scroller(page).evaluate((el) => {
    const containers = [
      ...el.querySelectorAll<HTMLElement>('[style*="position: absolute"]'),
    ].filter((node) => node.getBoundingClientRect().height > 0);
    return {
      total: containers.length,
      blank: containers
        .filter((node) => node.textContent!.trim() === "" && node.querySelector("svg") === null)
        .map((node) => node.style.transform || node.style.top || "?"),
    };
  });
  expect(rows.total, "the virtualized list must expose its row containers").toBeGreaterThan(3);
  expect(rows.blank, `blank row containers after settle: ${rows.blank.join(", ")}`).toEqual([]);
  // Settled: the fleet closed to its one-liner (default `?? unsettled`) and the relaunch
  // (fork-fbb4c264, a standalone card later in turn 1) reads «завершён» — flip 2 came from
  // the registry (notification L105) and survived the settle.
  await scrollTo(page, 0);
  await expect(timeline.locator('[data-agent-fleet][aria-expanded="false"]').first()).toBeVisible();
  const relaunch = timeline
    .locator("[data-agent-card]")
    .filter({ hasText: "Create analysis scripts" })
    .filter({ has: page.locator('[data-agent-status="completed"]') });
  expect(await scrollUntilVisible(page, relaunch), "the completed relaunch card").toBe(true);
  await expect(relaunch.first().getByText(/повтор|retry/)).toBeVisible();
  expect(await readDistanceFromEnd(page)).toBeGreaterThanOrEqual(0);
});

test("L6 (FIX-1 F3): the settle collapse leaves a reader ABOVE the live turn exactly where they are", async ({
  page,
}) => {
  // The position ADV-E5 states it does NOT prove (R1-1b's): the reader scrolled UP, above the
  // streaming turn, while its blocks and fleets are open BELOW them. When the turn settles
  // those default back to closed (P9/S5) and the content shrinks — under the reader, so
  // nothing they are looking at may move. Guarded by the list's data compensation
  // (`maintainVisibleContentPosition={{ data: true }}`, ExtendedMessagesTimeline.tsx) plus the
  // absence of any end-glue write while the reader is away from the end.
  // Does NOT prove: the reader pinned AT the end (that is S3/L2: they follow the end by
  // design, so rows DO move past them), nor a shrink ABOVE the viewport. Unforceable by
  // mutation on this tree — three mutations left it green (MVCP `data: false`;
  // `onUserNavigation` no longer cancelling the follow; that plus the scroll signal's
  // not-at-end guard removed), because for THIS reader the settle writes no scroll at all.
  // The zero-writer assertion below is what the case really pins.
  test.setTimeout(240_000);
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  await replaySession(page, SESSION_5EEB, {
    pacing: { kind: "records", intervalMs: 90 },
    holdMs: 4_000,
  });
  const timeline = page.locator(TIMELINE);
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toBeVisible({ timeout: 30_000 });
  // Enough of the turn has landed to scroll inside (the list is ≥ 2 viewports tall).
  await expect
    .poll(async () => scroller(page).evaluate((el) => el.scrollHeight - 2 * el.clientHeight), {
      timeout: 30_000,
    })
    .toBeGreaterThan(200);
  // The reader leaves the end for the TOP — a real gesture, not a programmatic write.
  const box = (await scroller(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -900);
  await waitForTimelineQuiet(page);
  const topBefore = await readScrollTop(page);
  expect(await readDistanceFromEnd(page), "the reader must be away from the end").toBeGreaterThan(
    200,
  );
  const writersBefore = await page.evaluate(() => window.__scrollWriters?.length ?? 0);
  // An open fleet/block BELOW the viewport is what the settle will shrink.
  const openBelow = await scroller(page).evaluate((el) => {
    const host = el.getBoundingClientRect();
    return [
      ...el.querySelectorAll<HTMLElement>(
        '[data-work-block] button[aria-expanded="true"], [data-agent-fleet][aria-expanded="true"]',
      ),
    ].filter((node) => node.getBoundingClientRect().top > host.bottom).length;
  });
  const reference = await scroller(page).evaluate((el) => {
    const host = el.getBoundingClientRect();
    for (const node of el.querySelectorAll<HTMLElement>(
      "[data-agent-card],[data-agent-fleet],[data-work-block],[data-run-summary],[data-call-row]",
    )) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.top - host.top > 24 && rect.bottom < host.bottom) {
        const attr = [...node.attributes].find((a) => a.name.startsWith("data-"))!;
        return { selector: `[${attr.name}="${attr.value}"]`, top: Math.round(rect.top - host.top) };
      }
    }
    return null;
  });
  expect(reference, "a reference row inside the viewport").not.toBeNull();
  // The turn settles: the working row goes and the live-turn rows close (S5).
  await expect(timeline.getByText(/^Работаю|^Working/).first()).toHaveCount(0, { timeout: 60_000 });
  await waitForTimelineQuiet(page);
  // The collapse really ran (otherwise this case guards nothing).
  await expect(
    timeline.locator('[data-agent-fleet][aria-expanded="false"]').first(),
  ).toBeAttached();
  const topAfter = await readScrollTop(page);
  const referenceAfter = await scroller(page).evaluate((el, selector) => {
    const node = el.querySelector<HTMLElement>(selector);
    return node === null
      ? null
      : Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top);
  }, reference!.selector);
  const message = `reader above the live turn moved at settle: ${reference!.selector} top ${reference!.top} → ${referenceAfter ?? "UNMOUNTED"}; scrollTop ${topBefore} → ${topAfter}; open below before settle: ${openBelow}`;
  expect(referenceAfter, message).not.toBeNull();
  expect(Math.abs((referenceAfter as number) - reference!.top), message).toBeLessThanOrEqual(2);
  expect(Math.abs(topAfter - topBefore), message).toBeLessThanOrEqual(2);
  // Nothing wrote the scroll position at all — no end-glue, no follow, no list compensation.
  const writers = await page.evaluate(
    (from) =>
      (window.__scrollWriters ?? [])
        .slice(from)
        .map((entry) => `${entry.kind}${Math.round(entry.value)}`),
    writersBefore,
  );
  expect(writers, `scroll writers across the settle: ${writers.join(", ")}`).toEqual([]);
});

test("L3: approval parked on a TOOL call — the call is OPEN + highlighted with the request box", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  writeFakeControl(state(), {
    delayMs: 0,
    responseText: "Команда выполнена.",
    approval: { kind: "command", via: "tool", command: "sudo ls -la /var/root" },
  });
  await sendPrompt(page, "покажи корень");
  await expectExtendedMounted(page);
  // The composer parks the decision…
  const approveOnce = page.getByRole("button", { name: /Разрешить один раз|Approve once/ });
  await expect(approveOnce).toBeVisible({ timeout: 20_000 });
  // …and the extended view shows the SAME request on the running call: OPEN, highlighted
  // (amber ring), «ожидает подтверждения», with the exact command on screen (I44/I45 — the
  // owner's guard). I45 detail: the row's OWN command block already shows the command, so
  // the approval box suppresses its duplicate (CallRows.tsx `suppressCommand`) — the
  // payload is on screen exactly once; the agent case (L4) renders the box itself.
  const timeline = page.locator(TIMELINE);
  const call = timeline
    .locator("[data-call-row]")
    .filter({ hasText: "sudo ls -la /var/root" })
    .first();
  await expect(call).toBeVisible();
  await expect(call.locator('[data-status="awaiting"]')).toBeVisible();
  await expect(call.locator('button[aria-expanded="true"]').first()).toBeVisible();
  await expect(call).toHaveClass(/ring-warning/);
  await expect(
    call.locator("code, pre").filter({ hasText: "sudo ls -la /var/root" }).first(),
  ).toBeVisible();
  // The context bar carries the approval chip and it jumps to the parked call.
  const bar = page.locator(CONTEXT_BAR);
  await expect(bar).toContainText(/ожидает подтверждения|awaiting approval/);
  await bar.getByRole("button", { name: /ожидает подтверждения|awaiting approval/ }).click();
  await waitForTimelineQuiet(page);
  await expect(call).toBeInViewport();
  // Approve → the call settles (chip gone), the turn ends with the response.
  await approveOnce.click();
  await expect(timeline.getByText("Команда выполнена.").last()).toBeVisible({ timeout: 20_000 });
  await expect(timeline.locator('[data-status="awaiting"]')).toHaveCount(0);
  await expect(page.locator(CONTEXT_BAR)).toHaveCount(0);
});

test("L4: approval raised by a SUBAGENT — the agent CARD carries the request box (§9 A1)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  writeFakeControl(state(), {
    delayMs: 0,
    responseText: "Ревью готово.",
    approval: {
      kind: "file-change",
      via: "agent",
      filePath: "/proj/permission-test.txt",
      content: "hello from subagent\n",
    },
  });
  await sendPrompt(page, "проверь диф");
  await expectExtendedMounted(page);
  const approveOnce = page.getByRole("button", { name: /Разрешить один раз|Approve once/ });
  await expect(approveOnce).toBeVisible({ timeout: 20_000 });
  const timeline = page.locator(TIMELINE);
  // The running `agent` launch is the only awaiting candidate: the CARD is highlighted,
  // says «ожидает подтверждения» and renders the request (the proposed file) inline.
  const card = timeline.locator("[data-agent-card]").first();
  await expect(card).toBeVisible();
  await expect(card.locator('[data-status="awaiting"]')).toBeVisible();
  await expect(card.getByText(/Запрошено подтверждение|Approval requested/)).toBeVisible();
  await expect(card.getByText("permission-test.txt").first()).toBeVisible();
  // The PANEL shows the held request at the inner step too (§9 A1, shape «panel» — R8).
  await card.locator(OPEN_AGENT_IN_PANEL).click();
  const inspector = page.locator(INSPECTOR);
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText(/Запрошено подтверждение|Approval requested/)).toBeVisible();
  await closeExtendedViewPanel(page);
  // Decline → the launch settles as cancelled, the turn ends.
  await page.getByRole("button", { name: /Отклонить|Decline/ }).click();
  await expect(timeline.getByText("Ревью готово.").last()).toBeVisible({ timeout: 20_000 });
  await expect(timeline.locator('[data-status="awaiting"]')).toHaveCount(0);
});

test("L5 (S2): a send with the redesigned rows present is ONE smooth upward motion", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await installScrollInstrumentation(page);
  await openFreshDraft(page);
  await switchToExtended(page);
  // History = a real settled session (cards, blocks, summaries, markers all present).
  await replaySession(page, SESSION_6C09, { pacing: { kind: "instant" }, mirrorRegistry: false });
  await expect(page).not.toHaveURL(/\/draft\//, { timeout: 15_000 });
  await scrollTo(page, "end");
  writeFakeControl(state(), {
    delayMs: 1_200,
    responseText: "Ответ после реальной сессии —\nнесколько строк,\nчтобы было куда скроллить.",
  });
  const text = "вопрос после реальной сессии — один плавный ход вверх";
  await page.evaluate((selector) => window.__startScrollRecorder?.(selector), TIMELINE);
  await sendPrompt(page, text);
  const bubble = page.locator(TIMELINE).getByText(text);
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  // Settle by convergence (messageFlow case-4 pattern): 6 unmoved samples after motion.
  await page.waitForFunction(
    () => {
      const trace = window.__scrollTrace;
      if (!trace || trace.length < 8) return false;
      const tail = trace.slice(-6);
      const stable = tail.every((sample) => sample.top === tail[0]!.top);
      const moved = trace.some((sample) => sample.top !== trace[0]!.top);
      return stable && (moved || trace.length >= 90);
    },
    undefined,
    { timeout: 30_000 },
  );
  const verdict = analyzeTrace(await page.evaluate(() => window.__scrollTrace ?? []));
  const bubbleBox = await bubble.boundingBox();
  const hostBox = await page.locator(TIMELINE).boundingBox();
  const offset = bubbleBox && hostBox ? bubbleBox.y - hostBox.y : null;
  const failures: string[] = [];
  if (Math.abs(verdict.totalDelta) < 20)
    failures.push(`did not scroll (totalDelta=${verdict.totalDelta})`);
  if (verdict.reversalPx >= 8)
    failures.push(`moved down-then-up (reversalPx=${verdict.reversalPx})`);
  if (Math.abs(verdict.totalDelta) >= 100 && verdict.movingFrames < 6) {
    failures.push(`pushed, not animated (movingFrames=${verdict.movingFrames})`);
  }
  // R16 — the anchored bubble lands below the list's constant top inset, which is now main's
  // own 48px header spacer (was 36). The bound moved with it, keeping the same 54px of slack.
  if (offset === null || offset >= 102)
    failures.push(`bubble not pinned to the top (offset=${offset})`);
  expect(failures, failures.join("\n")).toEqual([]);
});
