// ru-code PIN SUITE — auth/time pins (A1–A3).
//
// These pins assert the DESIRED contract, not the current behavior. Where the code is known to
// violate the contract (the HTTP/WS session-predicate asymmetry, the silently-ignored ticket),
// the pin is EXPECTED TO FAIL today — that failure is the finding this suite exists to record.

import { expect, test } from "@playwright/test";

import {
  awaitStable,
  bootPin,
  countConnectionErrors,
  readDaemonLog,
  runPinCleanups,
  runSql,
  saveEvidence,
  upgradeAnswerMs,
} from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

test("A1: session ROW expired while its token is valid → clean re-auth, never a WS loop", async ({
  page,
}) => {
  const app = await bootPin({ name: "a1-row-expiry", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  // Reproduce the >30-day state TODAY: age only the ROW's expiry. The signed session cookie in the
  // browser keeps its own (valid) exp claim — exactly the asymmetric state the analysis predicts.
  const aged = runSql(app, (db) => {
    const rows = db.prepare("SELECT session_id, expires_at FROM auth_sessions").all() as Array<{
      session_id: string;
      expires_at: string;
    }>;
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE auth_sessions SET expires_at = ?").run(past);
    return rows.length;
  });
  expect(aged, "at least one session row to age").toBeGreaterThan(0);

  await page.reload({ waitUntil: "domcontentloaded" });

  // DESIRED: the app must resolve this state — either a working connection (row check passes
  // consistently) or an explicit re-auth surface (pairing/login). FORBIDDEN: the field failure —
  // HTTP green while the WS dial fails over and over.
  const sightings = await countConnectionErrors(page, 40_000);
  const url = page.url();
  const onAuthSurface = /\/pair|\/login|auth/.test(url);
  saveEvidence(
    "A1-evidence.json",
    JSON.stringify(
      { sightings, url, onAuthSurface, daemonLogTail: readDaemonLog(app).slice(-4_000) },
      null,
      2,
    ),
  );
  expect(
    sightings,
    `A1: expired-row session must not produce a reconnect loop (saw ${sightings} sightings; url=${url})`,
  ).toBeLessThan(3);
});

test("A2: invalid wsTicket → refused fast AND named in the server log", async ({ page }) => {
  const app = await bootPin({ name: "a2-bad-ticket", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  const answer = await upgradeAnswerMs(app.port, {
    path: "/ws?wsTicket=pin-invalid-ticket",
    timeoutMs: 10_000,
  });
  // Refusal must be prompt and explicit.
  expect(answer.kind, "invalid ticket must not be upgraded").toBe("response");
  expect(answer.ms, "refusal latency").toBeLessThan(2_000);
  expect(answer.status ?? 0, "refusal status").toBeGreaterThanOrEqual(400);

  // …and OBSERVABLE: the server log must name the rejection. (The silent-reject gap is the
  // reason the field incident took an investigation instead of a grep.)
  const logText = readDaemonLog(app);
  const named = /WebSocketToken|websocket.*(reject|invalid|denied)|wsTicket/i.test(logText);
  saveEvidence("A2-log-tail.txt", logText.slice(-6_000));
  expect(named, "upgrade rejection must be logged with a reason").toBe(true);
});
