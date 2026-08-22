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
} from "./pinHarness.ts";

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

test("A1b: ticket path — expired ROW must fail CONSISTENTLY across HTTP and WS", async ({
  page,
}) => {
  // A1 exercised the COOKIE upgrade path, which turned out symmetric (neither side checks row
  // expiry) — it passed, but it is not the field shape. Bearer/catalog connections (the field
  // incident's «Zach [Mac Studio]» entry) dial with a TICKET, and the ticket verifier is the one
  // place that DOES check the row (SessionStore.verifyWebSocketToken). This pin asserts the
  // DESIRED contract at the protocol level: the two layers must agree about a dead session.
  const app = await bootPin({ name: "a1b-ticket-asymmetry", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  // Age the ROW while the browser's signed cookie keeps its own valid exp claim.
  const past = new Date(Date.now() - 60_000).toISOString();
  runSql(app, (db) => db.prepare("UPDATE auth_sessions SET expires_at = ?").run(past));

  // HTTP layer's verdict on the same session: ticket issuance.
  const issuance = await page.evaluate(async () => {
    const response = await fetch("/api/auth/websocket-ticket", { method: "POST" });
    const body = response.ok ? ((await response.json()) as { ticket?: string }) : null;
    return { status: response.status, ticket: body?.ticket ?? null };
  });

  if (issuance.ticket === null) {
    // Consistent refusal at the HTTP layer — the desired post-fix behavior. Contract satisfied.
    expect(issuance.status, "consistent refusal must be an auth status").toBeGreaterThanOrEqual(
      400,
    );
    return;
  }

  // HTTP said yes. Then the WS layer must also say yes — anything else is the field asymmetry:
  // every HTTP call green while every socket dial dies, which the client can only render as an
  // endless «не удалось установить WebSocket-соединение» loop.
  const dial = await upgradeAnswerMs(app.port, {
    path: `/ws?wsTicket=${encodeURIComponent(issuance.ticket)}`,
    timeoutMs: 10_000,
  });
  saveEvidence("A1b-evidence.json", JSON.stringify({ issuance, dial }, null, 2));
  expect(
    dial.kind,
    `A1b: HTTP issued a ticket for the session (status ${issuance.status}) but the WS layer ` +
      `verdict was ${dial.kind}${dial.status !== undefined ? ` ${dial.status}` : ""} — ` +
      `the layers disagree about the same session`,
  ).toBe("upgrade");
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

test("A3: a presented ticket must be honored even when the Host header defeats URL parsing", async ({
  page,
}) => {
  const app = await bootPin({ name: "a3-bad-host", env: { RU_CODE_WARM_ENGINE: "0" } });
  await awaitStable(page, app);

  // A REAL ticket, issued by the session the page owns.
  const ticket = await page.evaluate(async () => {
    const response = await fetch("/api/auth/websocket-ticket", { method: "POST" });
    if (!response.ok) return null;
    const body = (await response.json()) as { ticket?: string };
    return body.ticket ?? null;
  });
  expect(ticket, "ticket issuance over the paired session").not.toBeNull();

  // Control: the same dial with a normal Host must be accepted.
  const control = await upgradeAnswerMs(app.port, {
    path: `/ws?wsTicket=${encodeURIComponent(ticket as string)}`,
    timeoutMs: 10_000,
  });
  expect(control.kind, "control dial (valid ticket, normal Host) must upgrade").toBe("upgrade");

  // The pin: identical dial, Host header that `new URL()` cannot parse. The ticket is still
  // present in the request line — ignoring it because an unrelated header failed to parse is the
  // trap under test.
  const freshTicket = await page.evaluate(async () => {
    const response = await fetch("/api/auth/websocket-ticket", { method: "POST" });
    const body = (await response.json()) as { ticket?: string };
    return body.ticket ?? null;
  });
  const hostile = await upgradeAnswerMs(app.port, {
    path: `/ws?wsTicket=${encodeURIComponent(freshTicket as string)}`,
    host: "pin host with spaces:99999",
    timeoutMs: 10_000,
  });
  saveEvidence("A3-evidence.json", JSON.stringify({ control, hostile }, null, 2));
  expect(hostile.kind, "ticket must be honored regardless of Host parseability").toBe("upgrade");
});
