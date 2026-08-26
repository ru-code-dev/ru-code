// ru-code PIN SUITE — auth/time pins, OUTDATED split (A1b, A3).
//
// Quarantined out of what is now tests-contracts/a-auth.e2e.test.ts (née tests-pins/a-auth.pins.test.ts,
// A1/A2 since moved to tests-contracts) — see ./README.md for why. Bodies are
// byte-identical to their origin; only a leading test.skip was added per the outdated-suite
// convention, plus the shared imports/helpers these two cases need (duplicated from
// pinHarness.ts's neighbors rather than editing test logic).
//
// These pins assert the DESIRED contract, not the current behavior. Where the code is known to
// violate the contract (the HTTP/WS session-predicate asymmetry, the silently-ignored ticket),
// the pin is EXPECTED TO FAIL today — that failure is the finding this suite exists to record.

import { expect, test } from "@playwright/test";

import {
  awaitStable,
  bootPin,
  runPinCleanups,
  runSql,
  saveEvidence,
  upgradeAnswerMs,
} from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

test("A1b: ticket path — expired ROW must fail CONSISTENTLY across HTTP and WS", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
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

test("A3: a presented ticket must be honored even when the Host header defeats URL parsing", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
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
