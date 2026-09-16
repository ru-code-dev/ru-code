// ru-code (qwen-compression wave): THE CONTEXT RING AND THE COMPACTION ROW, SEEN
// IN THE DOM, against qwen 0.21.1's REAL compression wire.
//
// The in-memory suite next door (apps/server/.../qwen021Compression.e2e.test.ts)
// proves what the adapter emits; this spec proves what the OWNER sees: the ring
// drops to the post-compaction fill, the compaction row reports success, and
// qwen's raw English never reaches a bubble. Before the ingress moved onto qwen
// 0.21.1's real channels every case here failed — the ring stayed at the
// pre-compaction fill and the row closed «Провайдер не подтвердил сжатие
// контекста».
//
// WHY THE WIRE MOVED. At 0.13.1 the CLI reported `/compress` as a vendor
// extension notification (`_qwencode/slash_command` `{message, messageType}`),
// the only channel `QwenAdapter.handleUnknownExtNotification` listens on
// (QwenAdapter.ts:2741-2749). At 0.21.1 `Session.ts` emits exactly ONE
// extNotification in the whole file — `_qwencode/end_turn` (Session.ts:6078) —
// and slash-command output rides an ordinary `session/update`
// `agent_message_chunk` stamped `_meta.source:"slash_command"`
// (MessageEmitter.ts:152-165). qwen's own comment says why
// (Session.ts:8446-8448): "extNotification only goes to the ACP debug log and is
// not rendered by Zed."
//
// THE SURFACES ASSERTED, all read the way a user reads them:
//   · the ring button's aria-label — `Context window <pct> used`
//     (ContextWindowMeter.tsx:63-69), and the in-ring numeral (:96-101);
//   · the compaction row's text in the timeline (one morphing row: spinner →
//     outcome, QwenAdapter.ts:5231-5317).
//
// These are the wave's acceptance criteria on the real DOM, and its regression guard.
import {
  expect,
  openThread,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

// 180 000 / 252 000 (CONTEXT_WINDOW_TOKENS) = 71.4 % — above the ring's DANGER
// band (70 %, tokens-usage/constants.ts:17) so the fill is unmistakably "nearly
// full", and DELIBERATELY BELOW `AUTO_COMPACT_USED_FRACTION` (0.75,
// ru-code/qwen/src/constants.ts:74). A 0.76 seed makes the app's OWN
// `maybeAutoCompactAfterTurn` (QwenAdapter.ts:5361-5395) fire at the end of the
// seeding turn, which puts its own failed compaction row on the timeline and
// makes "which compaction failed?" ambiguous. Below the threshold the button
// press is the only compaction in the run.
const PRE_TOKENS = 180_000;
const POST_TOKENS = 12_345;
// 12 345 / 252 000 = 4.9 % — one decimal place, because `formatPercentage`
// keeps a decimal below 10 % (ContextWindowMeter.tsx:13-21).
const POST_PERCENT_MAX = 10;
const PRE_PERCENT_MIN = 60;

/** The ring trigger — the only button whose label is the context readout. */
const ringButton = (page: Page) => page.getByRole("button", { name: /Context window/ }).first();

/**
 * The percentage the ring currently advertises, read off its aria-label. Returns
 * null when the label carries a raw token count instead (unknown window).
 */
const readRingPercent = async (page: Page): Promise<number | null> => {
  const label = await ringButton(page).getAttribute("aria-label", { timeout: 20_000 });
  const match = /Context window\s+([\d.]+)%\s+used/.exec(label ?? "");
  return match ? Number(match[1]) : null;
};

/** Everything the timeline currently says, as one string (both locales). */
const timelineText = async (page: Page): Promise<string> =>
  (await page.locator("main, [role=main], body").first().innerText()).replace(/\s+/g, " ");

/** The MANUAL compaction row's success text (both locales). */
const COMPACTION_SUCCESS = /(Сжатие выполнено успешно|Compaction succeeded)/;
/**
 * The AUTO compaction row's text (both locales). qwen's own compaction gets the
 * SAME row kind as a manual one and its own wording, so it needs its own
 * pattern — dictionary entry `Qwen compacted the context automatically ({0} -> {1}).`
 */
const AUTO_COMPACTION_ROW =
  /(Qwen сжал контекст автоматически|Qwen compacted the context automatically)/;
/**
 * The failure text this spec exists to see the back of — kept as a NEGATIVE
 * assertion after the fix. Both the old wording and the current one (the
 * misleading `(stopReason: …)` suffix is gone) are matched, so neither can come
 * back unnoticed.
 */
const NOT_CONFIRMED =
  /(Провайдер не подтвердил сжатие|Провайдер не прислал подтверждение|provider did not confirm context compaction|provider sent no compaction confirmation)/i;
/** qwen's own raw English, which must never reach a bubble. */
const RAW_ENGLISH_RESULT = `Context compressed (${String(PRE_TOKENS)} -> ${String(POST_TOKENS)})`;

/** Hover the ring, then press its "Compact context" button. */
const pressCompactContext = async (page: Page): Promise<void> => {
  await ringButton(page).hover();
  const compact = page.getByRole("button", { name: /Compact context|Сжать контекст/ }).first();
  await compact.waitFor({ state: "visible", timeout: 20_000 });
  await expect(compact).toBeEnabled({ timeout: 20_000 });
  await compact.click();
};

/**
 * Drive one turn that leaves the ring at `tokens`, by stamping qwen's dedicated
 * empty-text usage frame on the turn (MessageEmitter.ts:170-237).
 */
const seedRingAt = async (page: Page, tokens: number, prompt: string): Promise<void> => {
  writeFakeControl(readHarnessState(), { usageTokens: tokens, responseText: "Готово." });
  await sendPrompt(page, prompt);
  await expect
    .poll(async () => await readRingPercent(page), {
      timeout: 45_000,
      message: `the ring never reached the seeded usage (${String(tokens)} tokens)`,
    })
    .toBeGreaterThan(PRE_PERCENT_MIN);
};

test.describe("qwen 0.21.1 compression — the ring and the compaction row", () => {
  test("manual compaction: the ring drops to the post-compaction fill", async ({ page }) => {
    await openThread(page);
    await seedRingAt(page, PRE_TOKENS, "наполни контекст");
    const before = await readRingPercent(page);
    expect(before, "precondition: the ring must start nearly full").toBeGreaterThan(
      PRE_PERCENT_MIN,
    );

    // Now answer the hidden "/compress" on qwen 0.21.1's REAL channel.
    writeFakeControl(readHarnessState(), {
      compress021: { preTokens: PRE_TOKENS, postTokens: POST_TOKENS },
    });
    await pressCompactContext(page);

    // THE BREAK: the compaction happened in the CLI, the ring never learns it.
    await expect
      .poll(async () => await readRingPercent(page), {
        timeout: 45_000,
        message:
          `THE BREAK: after a 0.21.1 compaction (${String(PRE_TOKENS)} -> ` +
          `${String(POST_TOKENS)}) the ring still advertises the PRE-compaction fill. ` +
          `The result arrived as an agent_message_chunk with _meta.source="slash_command" ` +
          `(MessageEmitter.ts:152-165) and QwenAdapter.ts:2749 only reads methods ending ` +
          `in "/slash_command", so no thread.token-usage.updated is ever emitted.`,
      })
      .toBeLessThan(POST_PERCENT_MAX);
  });

  test("manual compaction: the row succeeds, «не подтвердил» is never shown", async ({ page }) => {
    await openThread(page);
    await seedRingAt(page, PRE_TOKENS, "наполни контекст ещё раз");

    writeFakeControl(readHarnessState(), {
      compress021: { preTokens: PRE_TOKENS, postTokens: POST_TOKENS },
    });
    await pressCompactContext(page);

    // Wait for the row to reach a TERMINAL state either way, then judge it.
    await expect
      .poll(
        async () =>
          COMPACTION_SUCCESS.test(await timelineText(page)) ||
          NOT_CONFIRMED.test(await timelineText(page)),
        {
          timeout: 45_000,
          message: "the compaction row never reached a terminal state",
        },
      )
      .toBe(true);

    const text = await timelineText(page);
    expect(
      NOT_CONFIRMED.test(text),
      `THE BREAK: the compaction row closed with «Провайдер не подтвердил сжатие контекста» ` +
        `even though qwen 0.21.1 DID compress and reported it on its real channel ` +
        `(QwenAdapter.ts:5276-5282 — ctx.hiddenCompressOutcome is only ever written by the ` +
        `ext-notification handler). Timeline text: ${text.slice(0, 1200)}`,
    ).toBe(false);
    expect(
      COMPACTION_SUCCESS.test(text),
      `the compaction row must report success. Timeline text: ${text.slice(0, 1200)}`,
    ).toBe(true);
  });

  test("auto compaction mid-turn: qwen's raw English notice never reaches the chat", async ({
    page,
  }) => {
    await openThread(page);
    await seedRingAt(page, PRE_TOKENS, "наполни контекст для авто");

    // qwen's OWN mid-turn auto-compaction: the bare, `_meta`-less diagnostic
    // chunk (Session.ts:4668-4673), then the answer, then the post-compaction
    // usage frame. NOTE: the RING does follow here, but only via that closing
    // usage frame — the notice itself is unread. The server-level spec
    // (qwen021Compression.e2e.test.ts) pins that ordering deterministically; in
    // the browser the stable, user-visible fact is the LEAK.
    writeFakeControl(readHarnessState(), {
      compress021: { preTokens: PRE_TOKENS, postTokens: POST_TOKENS, mode: "auto" },
      usageTokens: POST_TOKENS,
      responseText: "Готово после авто-сжатия.",
    });
    await sendPrompt(page, "продолжай");
    await expect
      .poll(async () => (await timelineText(page)).includes("Готово после авто-сжатия."), {
        timeout: 45_000,
        message: "the auto-compaction turn never rendered its answer",
      })
      .toBe(true);
    // The compaction row is its own activity, so give it its own settle rather
    // than assuming it landed with the answer.
    await expect
      .poll(async () => AUTO_COMPACTION_ROW.test(await timelineText(page)), {
        timeout: 45_000,
        message: "qwen's auto-compaction never produced a row",
      })
      .toBe(true);

    const text = await timelineText(page);
    expect(
      text.includes("IMPORTANT: This conversation"),
      `THE BREAK: qwen's raw English auto-compaction diagnostic leaked verbatim into the ` +
        `chat — no localization, no compaction row. Timeline text: ${text.slice(0, 1400)}`,
    ).toBe(false);
    expect(
      AUTO_COMPACTION_ROW.test(text),
      `THE BREAK: qwen compacted the context itself and the timeline carries NO compaction ` +
        `row at all, so the user sees the context drop with no explanation. ` +
        `Timeline text: ${text.slice(0, 1400)}`,
    ).toBe(true);
  });

  test("a following turn answers after the compaction", async ({ page }) => {
    await openThread(page);
    await seedRingAt(page, PRE_TOKENS, "наполни контекст перед следующим ходом");

    writeFakeControl(readHarnessState(), {
      compress021: { preTokens: PRE_TOKENS, postTokens: POST_TOKENS },
    });
    await pressCompactContext(page);
    await expect
      .poll(
        async () =>
          COMPACTION_SUCCESS.test(await timelineText(page)) ||
          NOT_CONFIRMED.test(await timelineText(page)),
        { timeout: 45_000 },
      )
      .toBe(true);

    // The turn AFTER a compaction must answer normally (the pipeline's
    // allowRecovery resume path — see compressThenTurnPipeline.e2e.test.ts).
    const reply = "Ответ после сжатия";
    writeFakeControl(readHarnessState(), { responseText: reply, usageTokens: POST_TOKENS });
    await sendPrompt(page, "что дальше");
    await expect
      .poll(async () => (await timelineText(page)).includes(reply), {
        timeout: 45_000,
        message: "the post-compaction turn's reply never rendered",
      })
      .toBe(true);

    const text = await timelineText(page);
    expect(
      text.includes(RAW_ENGLISH_RESULT),
      `THE BREAK: qwen's raw English compress result leaked verbatim into the chat. ` +
        `Timeline text: ${text.slice(0, 1200)}`,
    ).toBe(false);
  });

  test("two threads: compaction in one leaves the other's ring alone", async ({ page }) => {
    // Thread B first, seeded LOW, so a cross-talk write would be visible as a
    // jump rather than as its only value.
    await openThread(page);
    writeFakeControl(readHarnessState(), { usageTokens: POST_TOKENS, responseText: "B." });
    await sendPrompt(page, "поток B");
    // Wait for a NON-ZERO reading: a fresh thread's ring starts at 0 %, which
    // would satisfy a bare `< POST_PERCENT_MAX` before B's usage frame ever
    // landed and make the "unaffected" claim vacuous.
    await expect
      .poll(async () => await readRingPercent(page), {
        timeout: 45_000,
        message: "thread B's ring never took its own seeded usage",
      })
      .toBeGreaterThan(0);
    const bBefore = await readRingPercent(page);
    expect(bBefore, "precondition: B must sit at its own low fill").toBeLessThan(POST_PERCENT_MAX);
    const threadBUrl = page.url();

    // Thread A: seeded HIGH, then compacted on the 0.21.1 wire.
    await openThread(page);
    await seedRingAt(page, PRE_TOKENS, "поток A");
    writeFakeControl(readHarnessState(), {
      compress021: { preTokens: PRE_TOKENS, postTokens: POST_TOKENS },
    });
    await pressCompactContext(page);
    await expect
      .poll(
        async () =>
          COMPACTION_SUCCESS.test(await timelineText(page)) ||
          NOT_CONFIRMED.test(await timelineText(page)),
        { timeout: 45_000 },
      )
      .toBe(true);
    const aPercent = await readRingPercent(page);

    // B is unaffected — the invariant that must hold either way.
    await page.goto(threadBUrl, { waitUntil: "domcontentloaded" });
    await page.locator("div[contenteditable=true]").first().waitFor({ timeout: 30_000 });
    // B must be EXACTLY where it was — not merely "also low".
    await expect
      .poll(async () => await readRingPercent(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const bPercent = await readRingPercent(page);
    expect(
      bPercent,
      `thread B's ring must be UNCHANGED by A's compaction; was ${String(bBefore)}%, ` +
        `now ${String(bPercent)}%`,
    ).toBe(bBefore);

    // A dropped — THIS is the assertion that breaks.
    expect(
      aPercent,
      `THE BREAK: thread A's ring never dropped after its compaction. ` +
        `Observed A=${String(aPercent)}% B=${String(bPercent)}%`,
    ).toBeLessThan(POST_PERCENT_MAX);
  });
});
