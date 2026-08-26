// ru-code: standalone probe — drives a browser at an ALREADY-RUNNING installed app,
// opens the terminal drawer, dumps console/pageerrors/screenshot. Not a test; a scope.
// Usage: node terminalInstallProbe.mjs <appUrl> <outDir> [pairToken]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { chromium } from "@playwright/test";

const [, , appUrl, outDir, pairToken] = process.argv;
if (!appUrl || !outDir) {
  console.error("usage: node terminalInstallProbe.mjs <appUrl> <outDir> [pairToken]");
  process.exit(2);
}
NodeFS.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const log = [];
page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));

const entry = pairToken ? `${appUrl}/pair#token=${pairToken}` : appUrl;
await page.goto(entry, { waitUntil: "domcontentloaded" });

await page
  .locator("div[contenteditable=true]")
  .first()
  .waitFor({ state: "visible", timeout: 60_000 });

const row = page
  .locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]')
  .first();
try {
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  await page
    .locator("div[contenteditable=true]")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
} catch {
  log.push("probe: no sidebar row — staying on landing view");
}

await page.keyboard.press("Control+KeyJ");
await page.waitForTimeout(7000);

await page.screenshot({ path: NodePath.join(outDir, "installed-terminal.png"), fullPage: true });
const bodyText = await page
  .locator("body")
  .innerText()
  .catch(() => "<no body>");
NodeFS.writeFileSync(
  NodePath.join(outDir, "installed-terminal.txt"),
  [
    `url: ${page.url()}`,
    "",
    "=== console/pageerror ===",
    ...log,
    "",
    "=== body ===",
    bodyText,
  ].join("\n"),
);
await browser.close();
console.log("probe done");
