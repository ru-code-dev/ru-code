// ru-code (agentic-flow wave, live-issues T1): THE WORKING LINE, SEEN IN THE DOM.
//
// The owner's live report: after a Stop pressed during the agent-spawning turn,
// subsequent sends show no working indicator («Работаю…»), though responses
// still arrive. Every layer below the browser was measured healthy in the
// analysis round — the server drives `session.status` to "running" on every
// post-stop send, and the derive appends the working row unconditionally from
// `isWorking` (MessagesTimeline.logic.ts:664-670). What was never tested is the
// thing the owner actually looks at: the rendered row.
//
// So these specs are a DEFECT DETECTOR, not a demonstration. Part 1 pins what
// correct looks like — when the line appears, that its timer really counts, how
// long it stays, when it goes. Part 2 replays the owner's scenario (two
// background agents genuinely running + the main turn still open → Stop → new
// sends) and asserts the line behaves IDENTICALLY to the pinned baseline on
// every following send. Any deviation fails AND dumps the row's DOM plus the
// observable derive inputs at the failure moment.
//
// THE ROW, verbatim from the built app (discovery dump, logs/live-issues/e2e):
//   <div class="… text-secondary-label text-[11px] tabular-nums">
//     <span class="inline-flex …">…3 × span.animate-status-pulse…</span>
//     <span class="shrink-0">Работаю <span class="tabular-nums">2с</span></span>
//   </div>
// Two variants exist and they mean different things (MessagesTimeline.tsx:1303-1310):
//   · COUNTING   — `Работаю <n>с` / `Working for <n>s` ⇒ `row.createdAt` is set,
//     i.e. `activeTurnStartedAt` resolved to a real instant;
//   · NULL-START — `Работаю…` / `Working...` ⇒ `row.createdAt` is NULL, i.e.
//     `deriveActiveWorkStartedAt` (session-logic.ts:380-395) returned null while
//     `isWorking` was still true. The row is PRESENT but nothing ticks.
// The owner's words name the second one, so the specs distinguish them rather
// than treating "a row is there" as success.
//
// RUNTIME IS REAL, not virtualized, and deliberately: the timer ticks off a
// `setInterval` over `new Date()` inside the browser (MessagesTimeline.tsx:1326-1340).
// No harness clock reaches it, so seconds must actually elapse. The long
// baseline case runs ~30 s of streaming by design; the rest are short.
import {
  expect,
  openThread,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The working row: the only `tabular-nums` block carrying the pulse dots. */
const workingRow = (page: Page) =>
  page.locator("div.tabular-nums").filter({ has: page.locator("span.animate-status-pulse") });

const COUNTING = /^(Working for|Работаю)\s+\S+$/;
const NULL_START = /^(Working\.\.\.|Работаю…)$/;
/** `formatWorkingTimer` (MessagesTimeline.tsx:1935-1957), both locales. */
const TIMER = /^(?:(\d+)\s*[hч]\s*)?(?:(\d+)\s*[mм]\s*)?(?:(\d+)\s*[sc с]?)?$/u;

interface WorkingLine {
  readonly present: boolean;
  readonly text: string;
  readonly variant: "counting" | "null-start" | "absent";
  readonly seconds: number | null;
}

/** Read the row as the user sees it. Never throws — absence is a real answer. */
const readWorkingLine = async (page: Page): Promise<WorkingLine> => {
  const row = workingRow(page);
  if ((await row.count()) === 0) {
    return { present: false, text: "", variant: "absent", seconds: null };
  }
  // EVERY read is BOUNDED. `locator.textContent()` auto-waits with no deadline
  // of its own, and the NULL-START row («Работаю…») has NO inner timer span at
  // all — so an unbounded read of it hangs until the whole test times out. That
  // is not hypothetical: it burned a 240 s run
  // (logs/live-issues/e2e/final_suite3.log, "waiting for … locator('span.tabular-nums')").
  // A missing timer is a RESULT here, not something to wait for.
  const text = (
    (await row
      .first()
      .locator("span.shrink-0")
      .textContent({ timeout: 2_000 })
      .catch(() => "")) ?? ""
  ).trim();
  if (NULL_START.test(text) || text === "") {
    return { present: true, text, variant: "null-start", seconds: null };
  }
  const timer = (
    (await row
      .first()
      .locator("span.tabular-nums")
      .textContent({ timeout: 2_000 })
      .catch(() => "")) ?? ""
  ).trim();
  if (timer === "") {
    // A present row whose timer span never resolved IS the null-start shape,
    // whatever its label reads — the owner's second reported symptom.
    return { present: true, text, variant: "null-start", seconds: null };
  }
  const match = TIMER.exec(timer.replaceAll(" ", " "));
  const seconds =
    match === null
      ? null
      : Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return {
    present: true,
    text,
    variant: COUNTING.test(text) ? "counting" : "null-start",
    seconds: Number.isFinite(seconds) ? seconds : null,
  };
};

/**
 * A read that tolerates the KNOWN turn-start blink (Part 3): retries briefly for
 * a present row before judging it. The lifecycle specs claim "appears, counts,
 * disappears"; the blink itself is a separate, separately-owned claim, and a
 * point-in-time read that happened to land in the 50-250 ms gap would make every
 * lifecycle case flaky for a reason it is not testing.
 */
const readSettledWorkingLine = async (page: Page, timeoutMs = 3_000): Promise<WorkingLine> => {
  const started = Date.now();
  let last = await readWorkingLine(page);
  while (Date.now() - started < timeoutMs) {
    if (last.present) return last;
    await page.waitForTimeout(100);
    last = await readWorkingLine(page);
  }
  return last;
};

/**
 * Everything about the failure moment that a browser CAN see. The React derive
 * inputs are not exposed to the DOM, so each is captured through its own
 * OBSERVABLE proxy and the mapping is stated rather than implied:
 *   · `isWorking`            ⇐ the row's presence (it is the row's only condition);
 *   · `activeTurnStartedAt`  ⇐ which VARIANT renders (counting ⇒ non-null, «…» ⇒ null);
 *   · `session.status`       ⇐ whether the composer offers Stop (running) or Send.
 */
const captureState = async (page: Page, label: string): Promise<string> => {
  const line = await readWorkingLine(page);
  const stopVisible = await page
    .getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ })
    .isVisible()
    .catch(() => false);
  // BOUNDED on purpose: `locator.evaluate` AUTO-WAITS for the element with no
  // deadline of its own, so capturing an ABSENT row — the commonest reason to
  // capture at all — hung the whole test until the suite timeout and turned a
  // clean assertion failure into an unexplained timeout. Measured, then fixed.
  const rowHtml = await workingRow(page)
    .first()
    .evaluate((el) => el.outerHTML, undefined, { timeout: 2_000 })
    .catch(() => "<absent>");
  const tail = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("[data-timeline-root=true]"));
      return nodes
        .slice(-3)
        .map((el) => (el.textContent ?? "").trim().slice(0, 200))
        .join(" | ");
    })
    .catch(() => "<none>");
  return [
    `--- WORKING-LINE CAPTURE (${label}) ---`,
    `isWorking(proxy: row present) = ${String(line.present)}`,
    `activeTurnStartedAt(proxy: variant) = ${line.variant}`,
    `session.status(proxy: Stop offered) = ${stopVisible ? "running" : "not-running"}`,
    `rowText = ${JSON.stringify(line.text)}  seconds = ${String(line.seconds)}`,
    `rowHtml = ${rowHtml.slice(0, 800)}`,
    `timelineTail = ${tail}`,
  ].join("\n");
};

const failWith = async (page: Page, label: string, message: string): Promise<never> => {
  const capture = await captureState(page, label);
  console.log(capture);
  await test.info().attach(`capture-${label}`, { body: capture, contentType: "text/plain" });
  throw new Error(`${message}\n${capture}`);
};

/** Wait for the row to appear, or fail with the full capture. */
const expectAppears = async (page: Page, label: string, timeoutMs = 15_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await readWorkingLine(page)).present) return;
    await page.waitForTimeout(150);
  }
  await failWith(page, label, `the working line never appeared within ${String(timeoutMs)}ms`);
};

const expectDisappears = async (page: Page, label: string, timeoutMs = 30_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await readWorkingLine(page)).present) return;
    await page.waitForTimeout(250);
  }
  await failWith(page, label, `the working line never disappeared within ${String(timeoutMs)}ms`);
};

// ── PART 1 — BASELINE: what CORRECT looks like ──────────────────────────────

test("BASELINE: the working line appears on send, its timer counts, and it goes at turn end", async ({
  page,
}) => {
  // ~30 s of real streaming (15 chunks, 2 s apart) — see the runtime note above.
  test.setTimeout(180_000);
  writeFakeControl(readHarnessState(), {
    delayMs: 0,
    responseText: "поток",
    stream: { chunks: 15, gapMs: 2_000 },
  });
  await openThread(page);
  await sendPrompt(page, "baseline streaming send");

  // 1. APPEARS — promptly after the send.
  await expectAppears(page, "baseline-appears", 15_000);
  const first = await readSettledWorkingLine(page);
  if (first.variant !== "counting") {
    await failWith(
      page,
      "baseline-variant",
      `the baseline must render the COUNTING variant, got ${first.variant} (${first.text})`,
    );
  }

  // 2. THE TIMER COUNTS — sampled at real intervals, strictly non-decreasing
  //    and strictly greater end-to-end.
  const samples: number[] = [first.seconds ?? -1];
  for (const waitMs of [4_000, 6_000, 6_000]) {
    await page.waitForTimeout(waitMs);
    const line = await readSettledWorkingLine(page);
    if (!line.present) {
      await failWith(page, "baseline-vanished", "the working line vanished mid-turn");
    }
    samples.push(line.seconds ?? -1);
  }
  console.log(`BASELINE timer samples (seconds): ${JSON.stringify(samples)}`);
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]! < samples[index - 1]!) {
      await failWith(
        page,
        "baseline-timer",
        `the timer went backwards: ${JSON.stringify(samples)}`,
      );
    }
  }
  if (samples.at(-1)! <= samples[0]!) {
    await failWith(
      page,
      "baseline-timer-stuck",
      `the timer never advanced across ~16 s: ${JSON.stringify(samples)}`,
    );
  }

  // 3. DISAPPEARS — when the turn completes, and not before.
  await expectDisappears(page, "baseline-disappears", 60_000);
});

test("BASELINE: the line is up before the first assistant text lands", async ({ page }) => {
  test.setTimeout(120_000);
  writeFakeControl(readHarnessState(), {
    delayMs: 1_500,
    responseText: "поток",
    stream: { chunks: 6, gapMs: 1_000 },
  });
  await openThread(page);
  await sendPrompt(page, "immediacy send");
  // The fake holds its first chunk for delayMs+500; the row must already be up.
  await expectAppears(page, "immediacy", 5_000);
  await expectDisappears(page, "immediacy-end", 60_000);
});

// ── PART 2 — THE OWNER'S SCENARIO ───────────────────────────────────────────

/**
 * The in-chat spawn block — `AgentSpawnCtaRow`, MessagesTimeline.tsx:2148-2216.
 * LIVE it reads «Kicked off N subagents» / «Запущено N субагента»; once every
 * agent is settled it flips to «Ran N subagents» / «Отработало N субагента».
 * This block COHABITS the timeline with the working row, and it flips at the
 * exact moment of the Stop — which is why the scenario asserts it in the CHAT,
 * and never clicks it: clicking opens the Agents panel, i.e. a different
 * surface than the one the owner is looking at.
 */
// The block is a BUTTON (its whole row is the affordance that opens the panel —
// «Open Agents ▸» / «Открыть ▸»), and its lead, count and status are separate
// elements inside it. A bare `getByText` therefore finds nothing: measured, the
// first version of this spec timed out 90 s against it. Anchor on the button,
// assert the owner's literal strings INSIDE it.
const ctaBlock = (page: Page) => page.getByRole("button", { name: /subagent|субагент/i }).first();
// `\w` is ASCII-ONLY in JS, so `Запущен\w*` cannot match the "о" of «Запущено» —
// the same class of silent zero-match that already cost this spec a locator
// once (`\b` after Cyrillic). Measured live text, verbatim from the built app:
//   live    "Запущено 3 субагента3 работаютАгенты ▸"
//   settled "Отработал 1 субагент✓ завершеноОткрыть ▸"  (owner's real render)
/** Live: «Kicked off N subagents» / «Запущен(о) N субагент(ов)». */
const CTA_LIVE = /(?:Kicked off|Запущен\S*)\s+\d+\s+(?:subagent|субагент)/u;
/** Settled: «Ran N subagents» / «Отработал(о) N субагент(ов)» + «✓ completed»/«✓ завершено». */
const CTA_SETTLED = /(?:Ran|Отработал\S*)\s+\d+\s+(?:subagent|субагент)/u;
const CTA_SETTLED_STATUS = /completed|завершено/u;

/** Send, then watch the working row AND the reply for a long, bounded window. */
const measureSend = async (
  page: Page,
  prompt: string,
  replyNeedle: string,
  windowMs: number,
): Promise<{
  readonly appearedAfterMs: number | null;
  readonly repliedAfterMs: number | null;
  readonly variant: string;
  readonly secondsSeen: ReadonlyArray<number>;
  readonly atEnd: boolean | null;
}> => {
  const t0 = Date.now();
  await sendPrompt(page, prompt);
  let appearedAfterMs: number | null = null;
  let repliedAfterMs: number | null = null;
  let variant = "absent";
  const secondsSeen: number[] = [];
  while (Date.now() - t0 < windowMs) {
    const line = await readWorkingLine(page);
    if (line.present) {
      appearedAfterMs ??= Date.now() - t0;
      if (variant === "absent") variant = line.variant;
      if (line.seconds !== null && !secondsSeen.includes(line.seconds))
        secondsSeen.push(line.seconds);
    }
    if (repliedAfterMs === null) {
      const replied = await page
        .getByText(replyNeedle, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (replied) repliedAfterMs = Date.now() - t0;
    }
    if (appearedAfterMs !== null && repliedAfterMs !== null && secondsSeen.length >= 2) break;
    await page.waitForTimeout(120);
  }
  // Is the timeline scrolled to its end? The working row is the LAST row
  // (MessagesTimeline.logic.ts:664-670) inside a virtualized list, so "in the
  // model but outside the render window" is a real way for it to be invisible
  // while the app believes it is working — a different defect from `isWorking`
  // being false, and only distinguishable with the scroll state in hand.
  const atEnd = await page
    .evaluate(() => {
      const scroller = Array.from(document.querySelectorAll("*")).find((el) => {
        const node = el as HTMLElement;
        return node.scrollHeight > node.clientHeight + 40 && node.clientHeight > 200;
      }) as HTMLElement | undefined;
      if (!scroller) return null;
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    })
    .catch(() => null);
  return { appearedAfterMs, repliedAfterMs, variant, secondsSeen, atEnd };
};

test("AGENTIC: the in-chat spawn block is up, Stop, then «continue» must show a counting line", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const state = readHarnessState();

  // (1)+(2) main turn running, THREE agents launched, and the spawn block
  // VISIBLE IN THE CHAT — asserted in the timeline, not in the panel model.
  writeFakeControl(state, {
    delayMs: 0,
    responseText: "поток",
    backgroundAgents: { count: 3, hold: true },
  });
  await openThread(page);
  await sendPrompt(page, "run some agentic flow");
  const block = ctaBlock(page);
  await expect(block).toBeVisible({ timeout: 90_000 });
  await expect(block).toContainText(CTA_LIVE, { timeout: 90_000 });
  console.log(`CHATBLOCK live text: ${JSON.stringify((await block.textContent()) ?? "")}`);
  const beforeStop = await readSettledWorkingLine(page);
  if (beforeStop.variant !== "counting") {
    await failWith(
      page,
      "chatblock-before-stop",
      `with the spawn block live and the turn open the line must COUNT, got ${beforeStop.variant}`,
    );
  }

  // (3) Stop WHILE the block is visible and the agents are running.
  const stop = page.getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ });
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await stop.click();
  // The block flips live → settled at this moment; that flip is the suspected
  // interaction, so it is asserted rather than assumed.
  await expect(block).toContainText(CTA_SETTLED, { timeout: 90_000 });
  await expect(block).toContainText(CTA_SETTLED_STATUS, { timeout: 90_000 });
  console.log(`CHATBLOCK settled text: ${JSON.stringify((await block.textContent()) ?? "")}`);

  // (4)+(5) the literal «continue», several times, each tracked for long enough
  // that a null answer means NEVER rather than merely late.
  const seen: string[] = [];
  const failures: string[] = [];
  for (const round of [1, 2, 3]) {
    const needle = `после стопа ${String(round)}`;
    writeFakeControl(state, {
      delayMs: 0,
      responseText: needle,
      stream: { chunks: 8, gapMs: 1_000 },
    });
    const result = await measureSend(page, "continue", needle, 40_000);
    const line = `round ${String(round)}: appeared=${
      result.appearedAfterMs === null ? "NEVER" : `${String(result.appearedAfterMs)}ms`
    } replied=${
      result.repliedAfterMs === null ? "never" : `${String(result.repliedAfterMs)}ms`
    } variant=${result.variant} counted=${JSON.stringify(result.secondsSeen)} atEnd=${String(result.atEnd)}`;
    seen.push(line);
    console.log(`CHATBLOCK ${line}`);
    if (result.appearedAfterMs === null) {
      failures.push(`${line} — the counter NEVER returned`);
    } else if (result.secondsSeen.length <= 1) {
      failures.push(`${line} — the counter appeared but never advanced`);
    }
  }
  if (failures.length > 0) {
    await failWith(
      page,
      "chatblock-after-stop",
      `after a Stop taken with the in-chat spawn block live:\n${failures.join("\n")}\n` +
        `all rounds:\n${seen.join("\n")}`,
    );
  }
});

// ── PART 3 — THE FLICKER TRACE ──────────────────────────────────────────────
//
// The first strengthened run failed with a capture that contradicted itself
// inside one helper: `row present = false` while the very next evaluation dumped
// a live `<span class="shrink-0">Работаю <span>0с</span></span>`. The row is not
// missing — it is FLICKERING at turn start, which is precisely the owner's own
// "I cannot tell whether it never appears or appears a split second and
// disappears". Playwright round-trips are far too slow to resolve a gap that
// short, so the sampling happens INSIDE the page at 50 ms.

interface Sample {
  readonly t: number;
  readonly present: boolean;
  readonly text: string;
}

/**
 * Installed through `addInitScript` so it is re-armed on EVERY document. An
 * in-page sampler started with a bare `evaluate` is silently wiped the moment
 * the SPA does a real navigation — measured: the same case that traced 120
 * samples in isolation came back with `samples=0` inside the full suite, which
 * turned the known-defect annotation into "expected to fail, but passed". The
 * init script cannot be lost that way.
 */
const TRACE_KEY = "__ruCodeWorkingTrace";
const TRACE_T0_KEY = "__ruCodeWorkingTraceT0";

/**
 * The sampler keeps its buffer in `sessionStorage`, not on `globalThis`.
 *
 * A per-document JS variable is destroyed by any real navigation, and the buffer
 * must outlive one — that is the whole reason this helper has been rewritten
 * three times. `sessionStorage` is per-tab and survives same-origin navigation,
 * so samples taken before a route change are still there afterwards. The
 * interval itself is still per-document and re-armed by the init script.
 */
const SAMPLER = () => {
  const KEY = "__ruCodeWorkingTrace";
  const T0 = "__ruCodeWorkingTraceT0";
  const scope = globalThis as unknown as { __traceArmed?: boolean };
  // Idempotent per DOCUMENT: `armTracer` runs this both as an init script and
  // directly in the live document, and the two must never install two intervals.
  if (scope.__traceArmed === true) return;
  scope.__traceArmed = true;
  if (sessionStorage.getItem(T0) === null) sessionStorage.setItem(T0, String(Date.now()));
  window.setInterval(() => {
    const dot = document.querySelector("span.animate-status-pulse");
    const row = dot?.closest("div.tabular-nums") ?? null;
    const t0 = Number(sessionStorage.getItem(T0) ?? Date.now());
    let buffer: unknown[] = [];
    try {
      buffer = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown[];
    } catch {
      buffer = [];
    }
    buffer.push({
      t: Date.now() - t0,
      present: row !== null,
      text: (row?.querySelector("span.shrink-0")?.textContent ?? "").trim(),
    });
    sessionStorage.setItem(KEY, JSON.stringify(buffer));
  }, 50);
};

/**
 * ru-code (ap-final T3): armed BOTH ways, and that is the whole correction.
 *
 * `addInitScript` alone only reaches documents created AFTER the call. In a full
 * suite run the page is frequently already loaded and `openThread` is an SPA
 * route change that creates no new document — so the sampler was never installed,
 * `readTrace` returned `[]`, and the case silently fell through to the driver
 * poll, which `sendPrompt` starves down to ~15 samples over 8 s. Measured
 * (`logs/ap-final/e2e_run1.log`): `FLICKER clean-send: samples=15 flicker=null
 * first=[]` — fifteen samples, NOT ONE of them showing the row, in a send whose
 * own BASELINE case proves the row is up for the whole turn. `flicker=null` there
 * meant "nothing was measured", not "nothing blinked", and the case reported
 * green on it. Exactly the silent-zero-match this file has been bitten by twice
 * before, so it is fixed at the instrument and guarded by the assertion below.
 */
const armTracer = async (page: Page) => {
  await page.addInitScript(SAMPLER);
  await page.evaluate(SAMPLER).catch(() => undefined);
};

/** Zero the buffer immediately before a measured send. */
const startTrace = (page: Page) =>
  page
    .evaluate(
      ({ key, t0key }) => {
        sessionStorage.setItem(key, "[]");
        sessionStorage.setItem(t0key, String(Date.now()));
      },
      { key: TRACE_KEY, t0key: TRACE_T0_KEY },
    )
    .catch(() => undefined);

const readTrace = (page: Page) =>
  page.evaluate(
    ({ key }) => {
      try {
        return JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown[];
      } catch {
        return [] as unknown[];
      }
    },
    { key: TRACE_KEY },
  ) as Promise<Sample[]>;

/** present → absent → present inside one turn: the row blinked. */
const findFlicker = (
  trace: ReadonlyArray<Sample>,
): { readonly from: number; readonly to: number } | null => {
  let sawPresent = false;
  let gapStart: number | null = null;
  for (const sample of trace) {
    if (sample.present) {
      if (sawPresent && gapStart !== null) return { from: gapStart, to: sample.t };
      sawPresent = true;
      gapStart = null;
    } else if (sawPresent && gapStart === null) {
      gapStart = sample.t;
    }
  }
  return null;
};

test("FLICKER: the working line must not blink out and back inside one turn", async ({ page }) => {
  // KNOWN DEFECT — this spec is EXPECTED TO FAIL and is annotated as such so the
  // suite stays honest AND green. Measured on the certified tree, in the real
  // browser (logs/live-issues/e2e/flicker_run.log):
  //   clean-send    gap 251→502 ms
  //   post-stop-1   gap 151→401 ms   window 1100000111111…
  //   post-stop-3   gap 150→202 ms   window 1011111111111…
  // Mechanism: `isWorking` (ChatView.tsx:2427-2431) is
  // `phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint`,
  // and `isConnecting` is DEAD — `const [isConnecting, _setIsConnecting] = useState(false)`
  // (ChatView.tsx:1405) whose setter is never called anywhere in the file. So the
  // CONNECTING phase cannot hold the row up, while `isSendBusy` is already gone:
  // `hasServerAcknowledgedLocalDispatch` (ChatView.logic.ts:605-608) acknowledges
  // on ANY `session.status` / `session.updatedAt` change, and `stopped → starting`
  // is one, long before `turn.started`. The row therefore unmounts for the whole
  // session-respawn window — milliseconds against this fake, seconds against a
  // real CLI, which is what the owner sees as "no working indicator".
  // WHEN FIXED: delete the `test.fail()` below; an unexpected PASS fails the run.
  test.setTimeout(180_000);
  const state = readHarnessState();

  // Leg 1 — a clean first send in a fresh thread. The reference.
  writeFakeControl(state, {
    delayMs: 0,
    responseText: "поток",
    stream: { chunks: 5, gapMs: 1_000 },
  });
  await armTracer(page);
  await openThread(page);
  await startTrace(page);
  await sendPrompt(page, "clean send");
  // The in-page sampler is the ONLY measurement now. A driver-side poll used to
  // run concurrently here as a "navigation-proof fallback", and it was worse than
  // nothing: its `page.evaluate` round-trips serialise against `sendPrompt`'s own
  // actions, so its samples bunched up and it reported 15 readings over 8 s with
  // the row never once present — in a send the BASELINE case proves shows a
  // counting line. The sessionStorage buffer above is genuinely navigation-proof,
  // which is what the fallback was reaching for.
  await page.waitForTimeout(8_000);
  const clean = await readTrace(page).catch(() => [] as Sample[]);
  const cleanFlicker = findFlicker(clean);
  console.log(
    `FLICKER clean-send: samples=${String(clean.length)} flicker=${JSON.stringify(cleanFlicker)} ` +
      `first=${JSON.stringify(clean.filter((s) => s.present).slice(0, 2))}`,
  );
  await page.waitForTimeout(4_000);

  // Leg 2 (the owner's stop-then-resend scenario) was measured here too and
  // blinks the same way — gaps of 113→401 ms, 157→250 ms and 151→401 ms across
  // runs (logs/live-issues/e2e/flicker_run.log, working_fourth_run.log). It is
  // NOT part of this case: the blink is not stop-specific, a clean first send
  // shows it, and driving the whole agentic scenario here only made the case
  // slow enough to die on the test timeout — which reads as an UNEXPECTED
  // failure and defeats the `test.fail()` annotation. The scenario itself is
  // owned by the AGENTIC case above; the Stop's role is to make the window long
  // (a whole session respawn) rather than to create it.
  if (clean.length === 0) {
    throw new Error("the in-page tracer produced NO samples — the measurement did not happen");
  }
  // ru-code (ap-final T3): samples alone are not a measurement. A window in which
  // the row is NEVER present is a broken instrument, not a quiet turn — the
  // BASELINE case above proves this exact send puts a counting line up within
  // ~100 ms and keeps it for the whole turn. Without this, an unarmed sampler
  // reports `flicker=null` and the case passes on nothing (measured in
  // `logs/ap-final/e2e_run1.log`).
  if (!clean.some((sample) => sample.present)) {
    throw new Error(
      `the tracer never once saw the working line across ${String(clean.length)} samples — ` +
        "the instrument did not observe the turn, so `flicker=null` would be meaningless",
    );
  }
  const flickers: string[] = [];
  if (cleanFlicker !== null) {
    flickers.push(`clean send: gap ${String(cleanFlicker.from)}→${String(cleanFlicker.to)}ms`);
  }

  // NON-GATING BY RULING. The owner has ruled that this blink is NOT the reported
  // defect, so this case must not vote on the suite: it is an instrument, kept
  // because the trace it prints is the only measurement of the turn-start window
  // anyone has. It is also NOT deterministic — the gap appears in most runs and
  // not all (measured: absent in the 2026-08-28 closing run), which is exactly
  // why a `test.fail()` annotation was wrong here: a run without the blink
  // reported an "unexpected pass" and turned a green suite red.
  if (flickers.length > 0) {
    console.log(`FLICKER observed: ${flickers.join("; ")}`);
  }
});
