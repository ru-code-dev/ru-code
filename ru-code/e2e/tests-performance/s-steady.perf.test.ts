// ru-code PIN SUITE — steady-state pins (S1–S4).
//
// The app is booted healthy first; the fault hits a RUNNING system. What is asserted is recovery:
// the client must come back on its own (resubscribed, functional) and must never be left in a
// permanent reconnect loop or a silent hang.

import { expect, test } from "@playwright/test";

import {
  assertQuietFor,
  awaitStable,
  bootPin,
  countConnectionErrors,
  freeze,
  runPinCleanups,
  runSql,
  saveEvidence,
  thaw,
  upgradeAnswerMs,
} from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app is genuinely alive from the page's point of view: its own fetch to /healthz answers. */
async function assertFunctional(page: import("@playwright/test").Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const response = await fetch("/healthz");
    return response.status;
  });
  expect(status, "in-page /healthz").toBe(200);
}

test("S1: SIGSTOP 30s mid-session → visible degradation allowed, full self-recovery required", async ({
  page,
}) => {
  const app = await bootPin({ name: "s1-freeze-mid", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  freeze(app.pid);
  // While frozen the client MAY (should) show a connection problem — record, don't assert.
  const sightingsWhileFrozen = await countConnectionErrors(page, 30_000);
  thaw(app.pid);

  // Recovery: banner clears, app functional, and the connection stays quiet afterwards.
  await expect
    .poll(
      async () => {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
        return /не удалось|переподключение/i.test(bodyText);
      },
      { timeout: 90_000, message: "connection banner never cleared after SIGCONT" },
    )
    .toBe(false);
  await assertFunctional(page);
  await assertQuietFor(page, 30_000, "S1-post-recovery");
  saveEvidence("S1-evidence.json", JSON.stringify({ sightingsWhileFrozen }, null, 2));
});

test("S2: SIGSTOP during establishment → must connect after SIGCONT, then stay quiet", async ({
  page,
}) => {
  const app = await bootPin({ name: "s2-freeze-establish", env: { RU_CODE_WARM_ENGINE: "0" } });
  freeze(app.pid);
  const navigation = page
    .goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 120_000 })
    .catch(() => null);
  await sleep(20_000);
  thaw(app.pid);
  await navigation;
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 90_000 });
  await assertQuietFor(page, 30_000, "S2-post-thaw");
  await assertFunctional(page);
});

test("S3: server restart under an open client → client reconnects and stays quiet", async ({
  page,
}) => {
  const app = await bootPin({ name: "s3-restart", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  // Real restart on the SAME port: stop via the wrapper, then start again with identical args.
  const NodeChildProcess = await import("node:child_process");
  const NodePath = await import("node:path");
  const cliJs = NodePath.join(app.layout.appRoot, "cli.js");
  const run = (args: string[]) =>
    NodeChildProcess.spawnSync(process.execPath, [cliJs, ...args], {
      env: app.env,
      encoding: "utf8",
      timeout: 60_000,
    });
  expect(run(["stop", "--base-dir", app.baseDir, "--force"]).status, "stop").toBe(0);
  const restart = run([
    "start",
    "--port",
    String(app.port),
    "--no-browser",
    "--base-dir",
    app.baseDir,
  ]);
  expect(restart.status, `restart: ${restart.stderr}`).toBe(0);

  // The page was open across the outage: it must come back on its own — no reload issued here.
  await expect
    .poll(
      async () => {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
        return /не удалось|переподключение/i.test(bodyText);
      },
      { timeout: 120_000, message: "client never recovered after server restart" },
    )
    .toBe(false);
  await assertFunctional(page);
  await assertQuietFor(page, 30_000, "S3-post-restart");
});

test("S5: pulsed freezes (7s stop / 3s cont ×10) — the ping-timeout reproduction", async ({
  page,
}) => {
  // A SIGSTOPped process still has its kernel TCP stack ACKing, so the socket looks open while
  // pongs stop — exactly the state the RpcClient pinger (5s ticks) punishes by killing the
  // ESTABLISHED socket with "ping timeout". Ten pulses emulate a server whose event loop
  // repeatedly stalls past the pong window (big sync SQLite work on a heavy database).
  //
  // During pulses, cycling is EXPECTED — recorded as cadence evidence, not asserted against.
  // The contract under test is the aftermath: once stalls stop, the client must converge to a
  // stable connection and stay quiet — a bounded incident, never a permanent loop.
  const app = await bootPin({ name: "s5-pulsed-freeze", env: { RU_CODE_WARM_ENGINE: "0" } });

  // Crash forensics: the first S5 run died with "Target crashed" (the RENDERER, not the app
  // logic) — so the page itself is instrumented. A reproducible renderer death under reconnect
  // cycling would be a client-side finding in its own right, and must be reported as an explicit
  // outcome instead of a broken test.
  let pageCrashed = false;
  const consoleLines: string[] = [];
  page.on("crash", () => {
    pageCrashed = true;
  });
  page.on("console", (message) => {
    if (consoleLines.length < 500) consoleLines.push(`[${message.type()}] ${message.text()}`);
  });

  await awaitStable(page, app);

  const sightingTimestamps: number[] = [];
  const memorySamples: Array<{ atMs: number; usedJsHeapMb: number }> = [];
  const startedAt = Date.now();
  const sampler = (async () => {
    for (;;) {
      if (pageCrashed) return;
      const sample = await page
        .evaluate(() => ({
          text: document.body.innerText,
          heap:
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0,
        }))
        .catch(() => null);
      if (sample !== null) {
        if (/не удалось|переподключение/i.test(sample.text)) {
          sightingTimestamps.push(Date.now() - startedAt);
        }
        memorySamples.push({
          atMs: Date.now() - startedAt,
          usedJsHeapMb: Math.round(sample.heap / 1_048_576),
        });
      }
      await sleep(400);
      if (Date.now() - startedAt > 10 * (7_000 + 3_000) + 2_000) return;
    }
  })();
  for (let pulse = 0; pulse < 10; pulse += 1) {
    freeze(app.pid);
    await sleep(7_000);
    thaw(app.pid);
    await sleep(3_000);
  }
  await sampler;

  saveEvidence(
    "S5-evidence.json",
    JSON.stringify(
      {
        pageCrashed,
        sightingsDuringPulses: sightingTimestamps.length,
        sightingTimestampsMs: sightingTimestamps,
        memorySamples: memorySamples.filter((_, index) => index % 5 === 0),
        consoleTail: consoleLines.slice(-60),
      },
      null,
      2,
    ),
  );
  expect(
    pageCrashed,
    "S5 FINDING: the RENDERER crashed during pulsed server freezes — client-side death under reconnect cycling",
  ).toBe(false);

  // Aftermath: converge and stay quiet.
  await expect
    .poll(
      async () => {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
        return /не удалось|переподключение/i.test(bodyText);
      },
      { timeout: 90_000, message: "client never converged after the pulses ended" },
    )
    .toBe(false);
  await assertFunctional(page);
  await assertQuietFor(page, 30_000, "S5-aftermath");
});

test("S4: sustained SQLite write pressure on the live DB → app stays stable", async ({ page }) => {
  const app = await bootPin({ name: "s4-db-pressure", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  // Real WAL contention on the server's own database: a scratch table hammered from this process
  // while the app serves the page. (Deviation from the original "big event store" design, which
  // would have required fabricating domain rows — recorded in the report.)
  runSql(app, (db) => db.exec("CREATE TABLE IF NOT EXISTS pin_pressure (id INTEGER, blob TEXT)"));
  const payload = "x".repeat(4_096);
  const stopAt = Date.now() + 30_000;
  const pressure = (async () => {
    while (Date.now() < stopAt) {
      runSql(app, (db) => {
        const insert = db.prepare("INSERT INTO pin_pressure (id, blob) VALUES (?, ?)");
        for (let i = 0; i < 50; i += 1) insert.run(i, payload);
        db.exec("DELETE FROM pin_pressure");
      });
      await sleep(20);
    }
  })();

  const answer = await upgradeAnswerMs(app.port, { timeoutMs: 15_000 });
  await assertQuietFor(page, 30_000, "S4-under-pressure");
  await pressure;
  expect(answer.ms, "upgrade answer under DB pressure").toBeLessThan(5_000);
  await assertFunctional(page);
});
