// ru-code (agentic-flow wave, live-issues T1): THE WARM-POOL PATH.
//
// Owner correction, and it invalidates the substrate of the pool-off specs: the
// reported defect is NOT the ~250 ms blink those specs pin. It is that after a
// Stop the working counter **never comes back**. The sequence the owner
// describes is a POOL sequence — the Stop kills the bound child, the ACP warm
// pool hands over the next warmed-up session, and the following sends ride a
// session whose IDENTITY is not the one the thread started on. `bootApp.ts`
// pins `RU_CODE_WARM_ENGINE: "0"` by default, so the pool-off suite never
// exercises that handoff at all; this suite opts in
// (`playwright.warm.config.ts` sets `RU_CODE_E2E_WARM_ENGINE=1`).
//
// The measurement that matters here is TIME-TO-APPEAR, not presence at some
// instant. "Seconds late" and "never" look identical to a point-in-time check
// and are completely different defects, so every send is polled for a long,
// BOUNDED window and the latency is recorded — and, critically, the reply is
// tracked alongside it, because the owner's report is precisely "the answer
// arrives, the counter does not".
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Page } from "@playwright/test";

import {
  expect,
  openThread,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "../tests-core/fixtures.ts";

/** The working row: the only `tabular-nums` block carrying the pulse dots. */
const workingRow = (page: Page) =>
  page.locator("div.tabular-nums").filter({ has: page.locator("span.animate-status-pulse") });

const NULL_START = /^(Working\.\.\.|Работаю…)$/;

interface Line {
  readonly present: boolean;
  readonly text: string;
  readonly variant: "counting" | "null-start" | "absent";
  readonly seconds: number | null;
}

/** Every read BOUNDED: a present row with no timer span must never be waited on. */
const readLine = async (page: Page): Promise<Line> => {
  const row = workingRow(page);
  if ((await row.count().catch(() => 0)) === 0) {
    return { present: false, text: "", variant: "absent", seconds: null };
  }
  const text = (
    (await row
      .first()
      .locator("span.shrink-0")
      .textContent({ timeout: 2_000 })
      .catch(() => "")) ?? ""
  ).trim();
  const timer = (
    (await row
      .first()
      .locator("span.tabular-nums")
      .textContent({ timeout: 2_000 })
      .catch(() => "")) ?? ""
  ).trim();
  if (timer === "" || NULL_START.test(text)) {
    return { present: true, text, variant: "null-start", seconds: null };
  }
  const match = /^(?:(\d+)\s*[hч]\s*)?(?:(\d+)\s*[mм]\s*)?(?:(\d+)\s*[sсc]?)?$/u.exec(timer);
  const seconds =
    match === null
      ? null
      : Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return { present: true, text, variant: "counting", seconds };
};

interface SendResult {
  readonly prompt: string;
  /** ms from send to the row first being seen, or null if it NEVER appeared. */
  readonly appearedAfterMs: number | null;
  /** ms from send to the reply text landing, or null. */
  readonly repliedAfterMs: number | null;
  readonly variantWhenSeen: string;
  /** Distinct timer readings while it was up — proof it counted. */
  readonly secondsSeen: ReadonlyArray<number>;
}

/**
 * Send, then watch BOTH the working row and the reply for `windowMs`. Polling
 * from the driver rather than in-page: an in-page sampler is silently wiped by
 * the SPA's navigation (measured), and here reliability beats resolution — the
 * question is "did it EVER come back", not "was there a 250 ms hole".
 */
const measureSend = async (
  page: Page,
  prompt: string,
  replyNeedle: string,
  windowMs: number,
): Promise<SendResult> => {
  const t0 = Date.now();
  await sendPrompt(page, prompt);
  let appearedAfterMs: number | null = null;
  let repliedAfterMs: number | null = null;
  let variantWhenSeen = "absent";
  const secondsSeen: number[] = [];
  while (Date.now() - t0 < windowMs) {
    const line = await readLine(page);
    if (line.present) {
      appearedAfterMs ??= Date.now() - t0;
      if (variantWhenSeen === "absent") variantWhenSeen = line.variant;
      if (line.seconds !== null && !secondsSeen.includes(line.seconds)) {
        secondsSeen.push(line.seconds);
      }
    }
    if (repliedAfterMs === null) {
      const replied = await page
        .getByText(replyNeedle, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (replied) repliedAfterMs = Date.now() - t0;
    }
    // Stop early only once BOTH questions are answered.
    if (appearedAfterMs !== null && repliedAfterMs !== null && secondsSeen.length >= 2) break;
    await page.waitForTimeout(120);
  }
  return { prompt, appearedAfterMs, repliedAfterMs, variantWhenSeen, secondsSeen };
};

const describeSend = (result: SendResult): string =>
  `«${result.prompt}»: appeared=${
    result.appearedAfterMs === null ? "NEVER" : `${String(result.appearedAfterMs)}ms`
  } replied=${
    result.repliedAfterMs === null ? "never" : `${String(result.repliedAfterMs)}ms`
  } variant=${result.variantWhenSeen} counted=${JSON.stringify(result.secondsSeen)}`;

/** Did the pool actually hand over? The app's own boot log is the witness. */
const poolEvidence = (): string => {
  const logPath = NodePath.join(import.meta.dirname, "../.artifacts/app-boot.log");
  const text = NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : "";
  const lines = text
    .split("\n")
    .filter((line) => /warm|pool|prewarm|spare|slot/i.test(line))
    .slice(-12);
  return lines.length > 0 ? lines.join("\n") : "<no warm-pool lines in the boot log>";
};

test.describe.configure({ mode: "serial" });

test("WARM BASELINE: with the pool ON, an ordinary send shows a counting working line", async ({
  page,
}) => {
  const state = readHarnessState();
  writeFakeControl(state, {
    delayMs: 0,
    responseText: "тёплый базовый",
    stream: { chunks: 8, gapMs: 1_000 },
  });
  await openThread(page);
  const result = await measureSend(page, "warm baseline send", "тёплый базовый", 40_000);
  console.log(`WARM BASELINE ${describeSend(result)}`);
  expect(result.appearedAfterMs, `the line never appeared: ${describeSend(result)}`).not.toBeNull();
  expect(
    result.secondsSeen.length,
    `the timer never advanced: ${describeSend(result)}`,
  ).toBeGreaterThan(1);
});

test("WARM + STOP: after the pool hands over, EVERY following send must show the counter", async ({
  page,
}) => {
  const state = readHarnessState();

  // 3 background agents, genuinely running, main turn PARKED — the Stop lands
  // while the model is still announcing the batch.
  writeFakeControl(state, {
    delayMs: 0,
    responseText: "поток",
    backgroundAgents: { count: 3, hold: true },
  });
  await openThread(page);
  await sendPrompt(page, "run some agentic flow");
  const cta = page.getByRole("button", { name: /subagent|субагент/i }).first();
  await expect(cta).toBeVisible({ timeout: 90_000 });
  await cta.click();
  const liveRows = page.locator("span.sr-only").filter({ hasText: /^(Working|Работает)$/ });
  await expect(liveRows).toHaveCount(3, { timeout: 90_000 });

  // The turn is open, so the line must be up before the Stop.
  const beforeStop = await readLine(page);
  console.log(
    `WARM before-stop: present=${String(beforeStop.present)} variant=${beforeStop.variant}`,
  );

  // THE STOP — kills the bound child; the pool hands over the next warm session.
  const stop = page.getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ });
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await stop.click();

  // Every following send rides the NEW session. 40 s per send is far longer than
  // any legitimate spawn, so a null here means NEVER, not "late".
  const results: SendResult[] = [];
  for (const round of [1, 2, 3, 4]) {
    const needle = `после стопа ${String(round)}`;
    writeFakeControl(state, {
      delayMs: 0,
      responseText: needle,
      stream: { chunks: 8, gapMs: 1_000 },
    });
    const result = await measureSend(page, "continue", needle, 40_000);
    results.push(result);
    console.log(`WARM post-stop-${String(round)} ${describeSend(result)}`);
  }
  console.log(`WARM pool evidence:\n${poolEvidence()}`);

  const never = results.filter((r) => r.appearedAfterMs === null);
  const repliedAnyway = never.filter((r) => r.repliedAfterMs !== null);
  const notCounting = results.filter(
    (r) => r.appearedAfterMs !== null && r.secondsSeen.length <= 1,
  );

  expect(
    never,
    `the working counter NEVER came back on ${String(never.length)} of ${String(results.length)} ` +
      `post-Stop sends (${String(repliedAnyway.length)} of them ANSWERED anyway — the owner's exact ` +
      `report):\n${results.map(describeSend).join("\n")}\n\npool:\n${poolEvidence()}`,
  ).toHaveLength(0);
  expect(
    notCounting,
    `the line appeared but its timer never advanced:\n${results.map(describeSend).join("\n")}`,
  ).toHaveLength(0);
});
