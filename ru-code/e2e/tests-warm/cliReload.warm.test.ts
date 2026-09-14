// ru-code (cli-reload): the warm-pool variant. Same press, same oracle, one difference that
// is the whole point — the ACP warm pool is ON, so the server also holds PARKED SPARES with
// no thread attached. `stopAll` drains them and the reload must leave zero of those alive
// too; and nothing may re-arm a refill behind the drain (research C-G1), which here is
// observable as "no CLI child reappears while the app sits idle".
import type { Page } from "@playwright/test";

import { liveReloadOwnedCliProcesses } from "../harness/primitives.ts";
import {
  expect,
  readHarnessState,
  sendPrompt,
  test,
  writeFakeControl,
} from "../tests-core/fixtures.ts";

const COMPOSER = 'div[contenteditable="true"]';
const state = () => readHarnessState();

async function openFreshThread(page: Page): Promise<void> {
  await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  const pencil = page.getByRole("button", { name: /New thread|Новый диалог/ }).first();
  await pencil.dispatchEvent("click");
  await expect(page).toHaveURL(/\/draft\//, { timeout: 20_000 });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 20_000 });
}

test("reload drains the warm pool too, and nothing refills behind it", async ({ page }) => {
  test.setTimeout(300_000);

  writeFakeControl(state(), { delayMs: 0, responseText: "Готово." });
  await openFreshThread(page);
  await sendPrompt(page, "прогрев пула");
  await expect(page.getByText("Готово.").last()).toBeVisible({ timeout: 60_000 });

  // A successful bind arms the chain: session child + at least one parked spare.
  await expect
    .poll(() => liveReloadOwnedCliProcesses().length, {
      timeout: 60_000,
      message: "the warm pool never parked a spare beside the session child",
    })
    .toBeGreaterThan(1);

  await page
    .getByRole("button", { name: /Reload CLI|Перезагрузить CLI/ })
    .first()
    .click();
  const confirm = page.getByTestId("cli-reload-confirm");
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await confirm.click();
  await expect(page.getByTestId("cli-reload-error")).toHaveCount(0);
  await expect(confirm).toHaveCount(0, { timeout: 120_000 });

  await expect
    .poll(() => liveReloadOwnedCliProcesses().map((child) => child.args), {
      timeout: 30_000,
      message: "a session child or a warm spare survived the reload",
    })
    .toEqual([]);

  // The C-G1 window: a refill armed behind the drain would fire within PREWARM_DELAY_MS.
  await page.waitForTimeout(8_000);
  expect(
    liveReloadOwnedCliProcesses().map((child) => child.args),
    "a spare respawned behind the drain",
  ).toEqual([]);

  writeFakeControl(state(), { delayMs: 0, responseText: "Снова на связи." });
  await sendPrompt(page, "после перезагрузки");
  await expect(page.getByText("Снова на связи.").last()).toBeVisible({ timeout: 60_000 });
});
