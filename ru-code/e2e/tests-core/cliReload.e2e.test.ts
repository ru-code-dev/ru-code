// ru-code (cli-reload): the whole flow in a real Chrome against the real built app and REAL
// fake-CLI child processes — the only place the OS-level claim can be made at all (the server
// vitest suite's spawner is in-memory, research F.1).
//
// The scenario the owner described, end to end:
//   thread A parked on an approval, thread B idle with a live session
//     → press «Перезагрузить CLI» and confirm
//     → the modal closes only when the server is really done (owner ruling R2)
//     → ZERO fake-CLI processes are left alive (the pgrep primitive, research F-G1)
//     → A's parked panel is gone and its composer is unblocked (the reload sweep closed the
//       request with the RELOAD wording — B-G1/B-G4)
//     → nothing restarts on its own while the app sits idle (research C5/C6/C7)
//     → a send in A gets a live session again, and so does a brand-new thread.
//
// The profile dir is asserted UNTOUCHED, deliberately: `DELETE_ON_CLI_RESTART` SHIPS EMPTY
// (owner ruling R10), so "the reload deletes nothing" is the shipped contract, and a build
// that starts deleting — a non-empty list, or a delete that ignores the list — turns this
// red. The delete mechanics themselves are proven where a non-empty list can exist:
// apps/server/src/ru-code/tests/cli-reload/deletePaths.test.ts and
// apps/server/src/ru-code/tests/qwen/fake-acp/cliReloadIdleDelete.e2e.test.ts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Page } from "@playwright/test";

import { liveReloadOwnedCliProcesses } from "../harness/primitives.ts";
import { expect, readHarnessState, sendPrompt, test, writeFakeControl } from "./fixtures.ts";

const COMPOSER = 'div[contenteditable="true"]';
const state = () => readHarnessState();

const RELOAD_BUTTON = /Reload CLI|Перезагрузить CLI/;
const APP_BOOT_LOG = NodePath.join(import.meta.dirname, "../.artifacts/app-boot.log");
const APPROVE_ONCE = /Approve once|Разрешить один раз/;

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

/** Every entry of the harness's CLI profile dir, sorted — the "untouched" oracle. */
function profileDirEntries(): ReadonlyArray<string> {
  return NodeFS.readdirSync(state().cliConfigDir).sort();
}

test("reload: every CLI child dies, parked work is released, and work resumes", async ({
  page,
}) => {
  test.setTimeout(300_000);

  // ── thread B: a plain, finished turn. Its session stays live and idle. ─────
  writeFakeControl(state(), { delayMs: 0, responseText: "Готово." });
  await openFreshThread(page);
  await sendPrompt(page, "первый поток");
  await expect(page.getByText("Готово.").last()).toBeVisible({ timeout: 60_000 });
  const threadBUrl = page.url();

  // ── OWNER PRIORITY RULING, end to end ─────────────────────────────────────
  // This is the FIRST send of this boot, so the server's auth flag is still false and both
  // contenders are live: the reactor forks the first-turn title generation BEFORE it ensures
  // the session (ProviderCommandReactor), and the CLI spawn scheduler must still let the
  // SESSION child exist first. The two markers are the ACP handshake's `initialize` and the
  // `-p` child's own spawn line — the order of CHILDREN, not of decisions.
  const bootLog = NodeFS.readFileSync(APP_BOOT_LOG, "utf8").split("\n");
  const firstAcpChild = bootLog.findIndex((line) => line.includes("tag: 'initialize'"));
  const firstTextgenChild = bootLog.findIndex((line) =>
    line.includes("[cli-textgen] child spawned"),
  );
  expect(
    firstAcpChild,
    "no ACP handshake in the server log — the oracle is not wired",
  ).toBeGreaterThan(-1);
  expect(
    firstTextgenChild,
    "no text-generation child in the server log — the first turn never generated a title",
  ).toBeGreaterThan(-1);
  expect(
    firstAcpChild,
    `the title-generation child was spawned BEFORE the session child (acp line ${firstAcpChild}, textgen line ${firstTextgenChild})`,
  ).toBeLessThan(firstTextgenChild);

  // ── thread A: parked on an approval, so the composer is gated. ─────────────
  writeFakeControl(state(), {
    delayMs: 0,
    responseText: "Команда выполнена.",
    approval: { kind: "command", via: "tool", command: "sudo ls -la /var/root" },
  });
  await openFreshThread(page);
  await sendPrompt(page, "покажи корень");
  const approveOnce = page.getByRole("button", { name: APPROVE_ONCE });
  await expect(approveOnce).toBeVisible({ timeout: 60_000 });
  const threadAUrl = page.url();

  // Two live sessions ⇒ real CLI children exist right now. Without this the "0 left"
  // assertion below could pass against a server that never spawned anything.
  const before = liveReloadOwnedCliProcesses();
  expect(
    before.length,
    `live fake-CLI children before the reload: ${before.map((p) => p.args).join(" | ")}`,
  ).toBeGreaterThan(0);
  const entriesBefore = profileDirEntries();
  expect(entriesBefore.length).toBeGreaterThan(0);

  // ── press Reload and confirm ───────────────────────────────────────────────
  await page.getByRole("button", { name: RELOAD_BUTTON }).first().click();
  const confirm = page.getByTestId("cli-reload-confirm");
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await confirm.click();
  // The RPC is awaited to completion, so the dialog closing IS "the server finished"
  // (owner ruling R2) — and the failure line must never have appeared.
  await expect(page.getByTestId("cli-reload-error")).toHaveCount(0);
  await expect(confirm).toHaveCount(0, { timeout: 120_000 });

  // ── the OS-level claim ─────────────────────────────────────────────────────
  await expect
    .poll(() => liveReloadOwnedCliProcesses().map((child) => child.args), {
      timeout: 30_000,
      message: "an ACP session / warm spare / one-shot child survived the reload",
    })
    .toEqual([]);

  // ── the profile dir is untouched (owner ruling R10: the list ships empty) ──
  expect(profileDirEntries()).toEqual(entriesBefore);

  // ── A's parked work was released ───────────────────────────────────────────
  await expect(approveOnce).toHaveCount(0, { timeout: 60_000 });

  // ── nothing restarts on its own ────────────────────────────────────────────
  await page.waitForTimeout(3_000);
  expect(
    liveReloadOwnedCliProcesses().map((child) => child.args),
    "a CLI child appeared with no user message behind it",
  ).toEqual([]);

  // ── work resumes: a send in A gets a live session again ───────────────────
  writeFakeControl(state(), { delayMs: 0, responseText: "Снова на связи." });
  await page.goto(threadAUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 30_000 });
  await sendPrompt(page, "ещё раз");
  await expect(page.getByText("Снова на связи.").last()).toBeVisible({ timeout: 60_000 });
  expect(
    liveReloadOwnedCliProcesses().length,
    "the resumed send spawned no CLI child",
  ).toBeGreaterThan(0);

  // ── and so does a brand-new thread ────────────────────────────────────────
  writeFakeControl(state(), { delayMs: 0, responseText: "Новый поток жив." });
  await openFreshThread(page);
  await sendPrompt(page, "совсем новый");
  await expect(page.getByText("Новый поток жив.").last()).toBeVisible({ timeout: 60_000 });

  // Thread B is reachable and usable too — the reload did not strand it.
  writeFakeControl(state(), { delayMs: 0, responseText: "B тоже жив." });
  await page.goto(threadBUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 30_000 });
  await sendPrompt(page, "продолжаем");
  await expect(page.getByText("B тоже жив.").last()).toBeVisible({ timeout: 60_000 });
});
