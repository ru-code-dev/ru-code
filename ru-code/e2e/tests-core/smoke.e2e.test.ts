// ru-code: PHASE C probe — boots nothing itself (globalSetup did), opens the real
// app, and dumps what it sees (screenshot + visible text + console errors) into
// .artifacts/ so the harness build can discover the actual first-run state
// (auth? project list? thread view?) instead of guessing selectors.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, readHarnessState, test } from "./fixtures.ts";

const ARTIFACTS = NodePath.join(import.meta.dirname, "../.artifacts");

test("app boots and serves the web UI", async ({ page }) => {
  const state = readHarnessState();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // EXPECTED on boot: the root draft wizard pre-allocates a thread id and the
    // client optimistically fetches its detail snapshot over HTTP
    // (threadSnapshotHttp) — the thread does not exist until the first send, so
    // the browser logs the 404 as a resource error. Design, not breakage; the
    // corresponding request is asserted benign by the messageFlow suite.
    if (message.text().includes("the server responded with a status of 404")) {
      const requestUrl = message.location().url;
      if (requestUrl.includes("/api/orchestration/threads/")) return;
    }
    consoleErrors.push(message.text());
  });
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  // Predicate, not a sleep: the SPA has genuinely booted once the composer
  // (contenteditable) is on screen — the environment connection came up.
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: NodePath.join(ARTIFACTS, "boot.png"), fullPage: true });
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "<no body text>");
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, "boot-state.txt"),
    [
      `url: ${page.url()}`,
      `title: ${await page.title()}`,
      "",
      "=== console errors ===",
      ...consoleErrors,
      "",
      "=== body text ===",
      bodyText,
    ].join("\n"),
  );
  expect((await page.title()).length).toBeGreaterThan(0);
  // Real boot assertions: the composer rendered and the boot produced zero
  // console errors — a broken env connection or a crashed SPA fails here.
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible();
  expect(consoleErrors, "the app must boot without console errors").toEqual([]);
});
