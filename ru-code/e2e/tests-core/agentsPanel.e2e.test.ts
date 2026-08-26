// ru-code (agents wave, phase 1 baseline lock): the FIRST browser-driven proof
// of the qwen sub-agent surface. Everything about agents was pinned at the
// server-event layer (subAgentFlow.e2e.test.ts) and at the reducer/render layer
// (apps/web/src/ru-code/tests/agents/*) — both against synthetic fixtures, on
// opposite sides of a seam nothing crossed. This spec closes it: a REAL built
// app in real Chromium, driven by the REAL fake ACP agent over real pipes, with
// the assertions on what a user actually sees in the Agents panel.
//
// Two legs, the two endings a user can produce:
//   1. the run settles by itself  → the row reads "Completed", with its result
//   2. the user presses Stop mid-run → the row reads "Stopped"
// Leg 2 has no wire primitive behind it — qwen sends no settling frame for a
// killed run — so the row is closed by TWO independent mechanisms: the server's
// teardown settle (QwenAdapter.ts:929-954, a persisted terminal row) and the
// client's sessionLive=false sweep (subagentRuntime.ts:721-731, an overlay).
// Measured, not assumed: with the server settle skipped, "Stopped" still shows
// AND still survives a reload — the sweep covers both. Only the final step of
// leg 2 separates them. Anything short of it does not test the server at all.
import {
  expect,
  openThread,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "./fixtures.ts";

// The built bundle is LOCALIZED at build time: the panel's status labels are
// raw literals in source (AgentsPanel.tsx:42-52) that the localization build
// rewrites into `L(en, ru)` pairs, so the real app renders the RU side. The e2e
// drives that built bundle, so every status assertion matches both sides —
// pinning one locale would make this suite fail the moment the app is run in
// the other. Pairs from ru-code/localization/dict/apps/web/src/components/AgentsPanel.tsx.json.
const STATUS_WORKING = /^(Working|Работает)$/;
const STATUS_COMPLETED = /^(Completed|Завершён)$/;
const STATUS_STOPPED = /^(Stopped|Остановлен)$/;

/**
 * The sr-only status span (AgentsPanel.tsx:190) is the ONLY unconditional render
 * of the label. The VISIBLE activity line above it (`{activity ?? visuals.label}`,
 * :185) falls back to the same label when the row has no progress/result text, so
 * a bare page-wide text count returns 1 for a settled row and 2 for a live one —
 * a difference about narration, not about status. Counting the sr-only spans
 * counts ROWS in a state, which is what these cases actually claim.
 */
const rowsWithStatus = (page: import("@playwright/test").Page, status: RegExp) =>
  page.locator("span.sr-only").filter({ hasText: status });

const AGENT_TITLE = "Review the diff";
const AGENT_ROLE = "code-reviewer";
const AGENT_RESULT = "Found 2 issues.";

test.describe.configure({ mode: "serial" });

const openAgentsPanel = async (page: import("@playwright/test").Page) => {
  // The in-chat spawn CTA is the user's own route to the panel, so it doubles as
  // the "agents appeared" predicate — it only renders once a task.* activity for
  // a spawn batch reached the store (MessagesTimeline.tsx:2121-2237). Matched on
  // the noun rather than the link label: the label differs between the live and
  // settled branches AND between locales (MessagesTimeline.tsx:2179-2233), while
  // "subagent"/"субагент" is in the row's accessible name in every combination.
  const cta = page.getByRole("button", { name: /subagent|субагент/i }).first();
  await expect(cta).toBeVisible({ timeout: 30_000 });
  await cta.click();
};

test("qwen sub-agent: a settled run appears in the Agents panel as Completed", async ({ page }) => {
  test.setTimeout(120_000);
  writeFakeControl(readHarnessState(), {
    delayMs: 0,
    responseText: "Готово.",
    subAgent: {
      title: AGENT_TITLE,
      role: AGENT_ROLE,
      settle: { status: "completed", result: AGENT_RESULT },
    },
  });

  await openThread(page);
  await sendPrompt(page, "review the diff please");
  await openAgentsPanel(page);

  // The row exists, titled from the spawn's own rawInput.description, and
  // carries the sub-agent type as its role chip.
  await expect(page.getByText(AGENT_TITLE, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(AGENT_ROLE, { exact: true }).first()).toBeVisible();

  // THE assertion: the panel's own verdict for the run.
  await expect(rowsWithStatus(page, STATUS_COMPLETED)).toHaveCount(1, { timeout: 30_000 });
  await expect(rowsWithStatus(page, STATUS_STOPPED)).toHaveCount(0);

  // The result rode through to the row's visible line (the fold's `result`).
  await expect(page.getByText(AGENT_RESULT).first()).toBeVisible();
});

test("qwen sub-agent: Stop while a run is open shows the row as Stopped", async ({ page }) => {
  test.setTimeout(120_000);
  // No `settle` ⇒ the fake never sends a settling frame and never resolves the
  // prompt: exactly the shape where only a server-side teardown settle can
  // close the row.
  writeFakeControl(readHarnessState(), {
    delayMs: 0,
    responseText: "Готово.",
    subAgent: { title: AGENT_TITLE, role: AGENT_ROLE },
  });

  await openThread(page);
  await sendPrompt(page, "review the diff and hold");
  await openAgentsPanel(page);

  // Mid-flight the row is live — pinning this first is what makes the flip below
  // meaningful rather than a row that was never running.
  await expect(page.getByText(AGENT_TITLE, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(rowsWithStatus(page, STATUS_WORKING)).toHaveCount(1, { timeout: 30_000 });

  // Also a build-time localized aria-label (ComposerPrimaryActions.tsx:138).
  const stop = page.getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();

  // The flip the whole leg exists for.
  await expect(rowsWithStatus(page, STATUS_STOPPED)).toHaveCount(1, { timeout: 30_000 });
  await expect(rowsWithStatus(page, STATUS_WORKING)).toHaveCount(0);

  // It survives a reload — but note what that does and does NOT prove: the
  // session row is persisted as "stopped", so the client's own sessionLive=false
  // sweep (subagentRuntime.ts:721-731) re-derives "Stopped" on every load with
  // or without a server terminal. This step pins the reload, nothing more.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openAgentsPanel(page);
  await expect(rowsWithStatus(page, STATUS_STOPPED)).toHaveCount(1, { timeout: 30_000 });

  // THE discriminator. Everything above is satisfied by the client sweep alone —
  // proven: skipping the server's own settle (QwenAdapter.ts:1174) left every
  // assertion above green. The sweep is an OVERLAY on a live-looking row, not a
  // fact, so it evaporates the moment the session is live again. Sending a
  // second turn does exactly that, and the stopped row must NOT resurrect —
  // which it can only do if a real, persisted task.completed{status:"stopped"}
  // row is what the fold is reading. This is zombieAgentSettle.test.ts's
  // "NEGATIVE TWIN" scenario, driven end to end for the first time.
  writeFakeControl(readHarnessState(), { delayMs: 0, responseText: "Второй ответ." });
  await sendPrompt(page, "and now just answer");
  await expect(page.getByText("Второй ответ.").first()).toBeVisible({ timeout: 30_000 });
  await expect(rowsWithStatus(page, STATUS_STOPPED)).toHaveCount(1, { timeout: 30_000 });
  await expect(rowsWithStatus(page, STATUS_WORKING)).toHaveCount(0);
});
