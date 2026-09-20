// ru-code S10 — spec 13: OPENING the analytics page refreshes it, every time, while a thread runs.
//
// `analytics.e2e.test.ts` next door pins that the page EXISTS, renders the seeded board at full
// width and goes away with its folder. This one pins the behaviour the owner lost when the page
// became a plugin, and it is deliberately about the SECOND open and every one after it:
//
//   1. every open issues exactly one `analytics.refresh` over `plugin.invoke` — no open is silent,
//      and no open fires two scans at a board that is already showing the answer to the first;
//   2. no open ever paints a failure. «Не удалось обновить статистику» is the dashboard's copy for
//      "the disk scan failed"; the owner met it on a page whose server trace said
//      `plugin.invoke outcome: success`, i.e. for scans that had succeeded;
//   3. a scan that FINISHES WHILE THE USER IS AWAY is on screen the moment they come back.
//
// (3) is the one that failed, and it is why the board "stopped refreshing on open". The dashboard's
// store is a module singleton that outlives the page on purpose (`store.ts` closePanel: sessions
// and filters are KEPT so a re-open is instant), but the fetch hook guarded the SNAPSHOT write on
// "is this panel still mounted". On a real transcript corpus a scan takes longer than a glance, so
// open → glance → leave threw the finished scan away; the next open started another one and was
// glanced away from too, and the board sat on numbers that were scans old until the user pressed ⟳
// and waited for it. Measured before the fix on a 15 000-session corpus driven by this harness:
// 7 of 12 opens showed a scan-old board (`WORKFLOW/logs/S10-evidence/repro-stale-board.json`).
//
// HOW (3) IS PINNED WITHOUT A RACE. Asserting "the board is right eventually" would pass on the
// broken build too — the next scan lands sooner or later either way. So the cycle is built on one
// fact the socket can prove: every cycle REWRITES the whole corpus, so every scan re-parses every
// file and takes far longer than the glance. The spec then asserts, in order, that the glance's
// refresh was still UNANSWERED when the user left, that it answered while they were away, and that
// the board already shows its numbers on return while the return's OWN refresh is still unanswered.
// Each of those three is read off the `plugin.invoke` frames, so a machine fast enough to break the
// margin fails the spec loudly instead of passing it vacuously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { restartPluginsApp, stopPluginsApp } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import { expect, openAppWithDemo, state, test, type Page } from "./fixtures.ts";

const PAGE = '[data-testid="analytics-page"]';
const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const SESSIONS_LABEL = /^(Сессий|Sessions)$/i;
/** Every failure sentence the dashboard can paint — none of them may appear on a healthy open. */
const ANY_FAILURE =
  /Не удалось обновить статистику|Could not refresh the analytics|Не удалось прочитать сохранённую статистику|Could not read the saved analytics|Служба статистики недоступна|The analytics service is unavailable|Нет прав на чтение статистики|No permission to read the analytics/;

/** Big enough that a full re-parse outlasts a glance, small enough to write in a few seconds. */
const BASE_SESSIONS = 1_500;
/** New transcripts between opens — the disk change an open is supposed to pick up. */
const BATCH = 40;

// ── the corpus ───────────────────────────────────────────────────────────────────────────────

const isoAt = (daysAgo: number, hour: number): string => {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

const uiLine = (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly event: Readonly<Record<string, unknown>>;
}): string =>
  JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    cwd: input.cwd,
    gitBranch: "main",
    sessionId: input.sessionId,
    timestamp: input.ts,
    systemPayload: { uiEvent: { "event.timestamp": input.ts, ...input.event } },
  });

const sessionIdFor = (index: number): string =>
  `5a000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/** One transcript the scanner accepts, at `<cliConfigDir>/projects/<slug>/chats/<hex>.jsonl`. */
function writeTranscript(cliConfigDir: string, index: number): void {
  const sessionId = sessionIdFor(index);
  const cwd = `/s10/open-refresh/p${String(index % 8)}`;
  const promptId = `${sessionId}########0`;
  const lines = [
    JSON.stringify({
      type: "user",
      cwd,
      sessionId,
      timestamp: isoAt(index % 20, 9),
      message: { role: "user", content: [{ type: "text", text: "open-refresh fixture" }] },
    }),
    uiLine({
      cwd,
      sessionId,
      ts: isoAt(index % 20, 9),
      event: {
        "event.name": "qwen-code.api_response",
        model: "qwen/qwen3.6-35b-a3b",
        input_token_count: 800 + index,
        output_token_count: 120,
        cached_content_token_count: 0,
        thoughts_token_count: 0,
        duration_ms: 2_000,
        ttft_ms: 400,
        prompt_id: promptId,
      },
    }),
    uiLine({
      cwd,
      sessionId,
      ts: isoAt(index % 20, 10),
      event: {
        "event.name": "qwen-code.tool_call",
        function_name: "read_file",
        success: true,
        decision: "auto_accept",
        duration_ms: 90,
        tool_type: "native",
        prompt_id: promptId,
      },
    }),
  ];
  const chats = NodePath.join(cliConfigDir, "projects", `-s10-or-p${String(index % 8)}`, "chats");
  NodeFS.mkdirSync(chats, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(chats, `${sessionId.replaceAll("-", "")}.jsonl`),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

const seedRange = (cliConfigDir: string, from: number, to: number): void => {
  for (let index = from; index < to; index += 1) writeTranscript(cliConfigDir, index);
};

// ── watching the wire ────────────────────────────────────────────────────────────────────────

/**
 * Record every `plugin.invoke` request and every answer, before any app code runs.
 *
 * The RPC id is the join: a request frame carries `"id"`, its answer carries `"requestId"`, so
 * "this open's refresh has been answered" is a fact about the socket rather than a sleep. The
 * host's own client log would not do — it says nothing about when an answer arrived.
 */
const WS_INIT = `
globalThis.__openRefresh = { requests: [], answers: [] };
const note = (dir, data) => {
  try {
    const text = typeof data === "string" ? data : "";
    if (text === "") return;
    if (dir === "out") {
      const method = /"method":"(analytics\\.[a-zA-Z]+)"/.exec(text);
      if (method === null) return;
      const id = /"id":(\\d+)/.exec(text);
      globalThis.__openRefresh.requests.push({
        at: Date.now(),
        id: id === null ? "" : id[1],
        method: method[1],
      });
      return;
    }
    const answered = /"requestId":"?(\\d+)/.exec(text);
    if (answered !== null) globalThis.__openRefresh.answers.push(answered[1]);
  } catch {}
};
const WS = globalThis.WebSocket;
const nativeSend = WS.prototype.send;
WS.prototype.send = function (data) {
  note("out", data);
  if (!this.__openRefreshHooked) {
    this.__openRefreshHooked = true;
    this.addEventListener("message", (event) => note("in", event.data), { capture: true });
  }
  return nativeSend.call(this, data);
};
`;

interface Wire {
  readonly requests: ReadonlyArray<{
    readonly at: number;
    readonly id: string;
    readonly method: string;
  }>;
  readonly answers: ReadonlyArray<string>;
}

const wire = (page: Page): Promise<Wire> =>
  page.evaluate(
    () =>
      ((globalThis as unknown as { __openRefresh?: Wire }).__openRefresh ?? {
        requests: [],
        answers: [],
      }) as Wire,
  );

// ── reading the board ────────────────────────────────────────────────────────────────────────

/** The «Сессий» tile and any failure sentence, in one read. */
const board = (page: Page) =>
  page.evaluate(
    ([selector, failure]: [string, string]) => {
      const root = document.querySelector(selector);
      if (root === null) return { mounted: false, sessions: -1, failure: "" };
      const text = root.textContent ?? "";
      const strip = root.querySelector('[class*="grid-cols-7"]');
      const tile =
        strip === null
          ? ""
          : (strip.children[3]?.querySelector('span[class*="font-mono"]')?.textContent ?? "");
      const match = new RegExp(failure).exec(text);
      return {
        mounted: true,
        sessions: Number.parseInt(tile.replace(/[^\d]/g, ""), 10),
        failure: match === null ? "" : match[0],
      };
    },
    [PAGE, ANY_FAILURE.source] as [string, string],
  );

async function openAnalytics(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  // A toast parked over the footer intercepts the pointer; the suite's own idiom for that.
  if (!clicked) await button.dispatchEvent("click");
  await expect(page.locator(PAGE)).toBeVisible({ timeout: 30_000 });
}

/**
 * Leave the board — one client-side navigation, never a reload.
 *
 * ru-code S22: through the sidebar footer's BACK button, which is what that footer collapses to on
 * any whole-area page (`ru-code/sidebar/footerPage.ts` recognises the host-owned
 * `/plugins/<id>/<page>` route). This used to click the demo plugin's own footer entry, and that
 * entry is not on screen while a plugin page is open any more — the icon row is replaced, not
 * augmented. What the spec needs is unchanged and is what Back gives: the user leaves the page
 * without a reload, so the module-global store survives and the next open is a RE-open.
 */
async function leaveAnalytics(page: Page): Promise<void> {
  const button = page
    .locator('[data-sidebar="footer"]')
    .getByRole("button", { name: /^(Назад|Back)$/ })
    .first();
  await expect(button, "the footer's Back button is the way off a plugin page").toBeVisible({
    timeout: 20_000,
  });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await button.dispatchEvent("click");
  await expect(page.locator(PAGE)).toHaveCount(0, { timeout: 20_000 });
}

// ── the spec ─────────────────────────────────────────────────────────────────────────────────

test.describe("plugins — opening the analytics page refreshes it", () => {
  test.setTimeout(300_000);

  test.beforeAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    seedRange(current.cliConfigDir, 0, BASE_SESSIONS);
    await restartPluginsApp(current);
  });

  test("every open scans, none of them fails, and a scan finished while away is on screen on return", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.addInitScript(WS_INIT);

    const current = state();
    // A turn that genuinely runs for the whole spec: the owner's report is specifically about
    // switching to Analytics while a thread is streaming.
    NodeFS.writeFileSync(
      current.controlFile,
      JSON.stringify({ delayMs: 0, stream: { chunks: 120, gapMs: 700 } }),
    );

    await openAppWithDemo(page);
    const composer = page.locator('div[contenteditable="true"]').first();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await page.keyboard.type("s10 open-refresh: keep this turn streaming");
    await expect(composer).toContainText("streaming", { timeout: 15_000 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.keyboard.press("Enter");
      const emptied = await composer
        .textContent()
        .then((value) => !(value ?? "").includes("streaming"))
        .catch(() => false);
      if (emptied) break;
      await page.waitForTimeout(250);
    }

    // ── the first open: warm the board, so every later open is the "re-open" path ─────────
    await openAnalytics(page);
    await expect(
      page.locator(PAGE).getByText(SESSIONS_LABEL).first(),
      "the KPI strip is on the board, i.e. the first snapshot arrived",
    ).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await board(page)).sessions, {
        timeout: 90_000,
        message: "the first scan reports the whole seeded corpus",
      })
      .toBeGreaterThanOrEqual(BASE_SESSIONS);
    expect((await board(page)).failure, "the first open does not fail").toBe("");
    await leaveAnalytics(page);

    const evidence: Array<Record<string, unknown>> = [];
    let expected = BASE_SESSIONS;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // The whole corpus is rewritten, not just appended to: the scanner re-parses a file whose
      // bytes changed, so this is what makes every scan long enough to be left in the middle of —
      // the condition a real transcript tree has by size and a synthetic one has to be given.
      expected += BATCH;
      seedRange(current.cliConfigDir, 0, expected);

      // ── the glance: open, and leave the moment the scan has been ASKED for ───────────────
      const before = await wire(page);
      await openAnalytics(page);
      await expect
        .poll(
          async () =>
            (await wire(page)).requests.filter((request) => request.method === "analytics.refresh")
              .length -
            before.requests.filter((request) => request.method === "analytics.refresh").length,
          { timeout: 60_000, intervals: [25], message: `open ${String(cycle)} issues a refresh` },
        )
        .toBe(1);
      const duringGlance = (await wire(page)).requests.slice(before.requests.length);
      const glanceRefreshes = duringGlance.filter(
        (request) => request.method === "analytics.refresh",
      );
      const glanceFailure = (await board(page)).failure;
      const answeredAtLeave = (await wire(page)).answers;
      await leaveAnalytics(page);

      expect(
        glanceRefreshes.length,
        `open ${String(cycle)} issues exactly one analytics.refresh`,
      ).toBe(1);
      expect(glanceFailure, `open ${String(cycle)} paints no failure`).toBe("");

      const glanceRequestId = glanceRefreshes[0]?.id ?? "";
      expect(
        answeredAtLeave.includes(glanceRequestId),
        `the scan of open ${String(cycle)} is still running when the user leaves ` +
          "(if this fails the corpus is too small to leave a scan in the middle of)",
      ).toBe(false);

      // ── the scan finishes while the user is somewhere else ──────────────────────────────
      await expect
        .poll(async () => (await wire(page)).answers.includes(glanceRequestId), {
          timeout: 120_000,
          message: `the scan started by open ${String(cycle)} answers while the user is away`,
        })
        .toBe(true);
      const answeredAway = (await wire(page)).answers.length;

      // ── the return ─────────────────────────────────────────────────────────────────────
      await openAnalytics(page);
      const onReturn = await board(page);
      const afterReturn = await wire(page);
      const returnRefresh = afterReturn.requests.findLast(
        (request) => request.method === "analytics.refresh",
      );

      evidence.push({ cycle, expected, onReturn, glanceRequestId, answeredAway });

      expect(onReturn.failure, `the return after open ${String(cycle)} paints no failure`).toBe("");
      expect(
        afterReturn.answers.length,
        `the return's own refresh has not answered yet, so the board can only be showing the ` +
          `scan that finished while the user was away (open ${String(cycle)})`,
      ).toBe(answeredAway);
      expect(
        returnRefresh?.id !== glanceRequestId,
        `the return issued a refresh of its own (open ${String(cycle)})`,
      ).toBe(true);
      expect(
        onReturn.sessions,
        `the scan that finished while away is on screen on return (open ${String(cycle)}) — ` +
          "no ⟳ pressed, and the return's own refresh has not answered",
      ).toBeGreaterThanOrEqual(expected);

      await leaveAnalytics(page);
    }

    saveEvidenceJson("13-analytics-open-refresh", { evidence, pageErrors });
    expect(pageErrors, "no page errors across the open/away cycles").toEqual([]);
  });
});
