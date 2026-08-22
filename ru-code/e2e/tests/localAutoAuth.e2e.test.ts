// ru-code: LOOPBACK AUTO-AUTH acceptance — a loopback web server must serve the
// app with ZERO pairing token in every fresh-browser shape, and the credential
// endpoint must refuse every non-loopback request shape.
//
// The harness (bootApp.ts) pairs its own context with the startup token and
// saves auth.json; THESE specs deliberately run with an EMPTY storage state —
// no cookie, no localStorage, no IndexedDB registration — which is exactly the
// "cleared browser data / second browser / next day" field case that used to
// dead-end on the /pair page (one-time startup token already consumed).
import * as NodeHttp from "node:http";

import { expect, readHarnessState, test } from "./fixtures.ts";

const LOCAL_BOOTSTRAP_PATH = "/api/auth/local-bootstrap";
const PAIRING_TOKEN_FORMAT = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

// A fresh browser with NOTHING persisted — the auto-auth flow must carry it.
test.use({ storageState: { cookies: [], origins: [] } });

test("a token-free fresh browser reaches the app, and survives a cookie wipe", async ({
  page,
  context,
}) => {
  const state = readHarnessState();
  // The AUTH-proving surface, deliberately NOT the composer: the sidebar shell
  // renders only once the auth gate resolved authenticated, and its project
  // list is served over the authenticated env connection. The composer depends
  // on the draft wizard's project-selection state (a fresh profile can land on
  // «Выберите проект» with no contenteditable) — UI state, not auth state; the
  // smoke spec covers the composer with the paired profile.
  // ru-code: re-anchored off the default sidebar's "New project" affordance —
  // `sidebar-add-project-trigger` only exists on LegacySidebar (A31/A37 drift,
  // not S; see WORKFLOW/briefs/12-porter.md dispatch, 2026-08-16).
  const appShell = page.getByRole("button", { name: "New project" }).first();

  // 1. Plain URL, no token fragment, empty storage: the app must come up
  //    authenticated — never the /pair screen — and the silent exchange must
  //    have set a session cookie.
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(appShell).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).pathname.startsWith("/pair")).toBe(false);
  expect((await context.cookies()).length).toBeGreaterThan(0);

  // 2. The field regression case: the browser wipes its cookies (session gone,
  //    exactly like the 30-day expiry) — a reload must recover, silently, and
  //    re-issue a fresh session cookie.
  await context.clearCookies();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(appShell).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).pathname.startsWith("/pair")).toBe(false);
  expect((await context.cookies()).length).toBeGreaterThan(0);
});

interface ProbeResponse {
  readonly status: number;
  readonly body: string;
}

/** Raw node:http so the Host header can be forged (fetch refuses to). */
function probeEndpoint(input: {
  readonly serverUrl: string;
  readonly hostHeader?: string;
  readonly originHeader?: string;
}): Promise<ProbeResponse> {
  const target = new URL(input.serverUrl);
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: target.hostname,
        port: target.port,
        path: LOCAL_BOOTSTRAP_PATH,
        method: "GET",
        headers: {
          ...(input.hostHeader !== undefined ? { host: input.hostHeader } : {}),
          ...(input.originHeader !== undefined ? { origin: input.originHeader } : {}),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("the credential endpoint grants loopback and refuses everything else", async () => {
  const state = readHarnessState();

  // Loopback, no Origin (same-origin fetch / local process): granted, no-store,
  // and the credential is a real pairing-token-format value that stays STABLE
  // across requests (rotation only near expiry).
  const granted = await probeEndpoint({ serverUrl: state.serverUrl });
  expect(granted.status).toBe(200);
  const credential = (JSON.parse(granted.body) as { credential: string }).credential;
  expect(credential).toMatch(PAIRING_TOKEN_FORMAT);

  const again = await probeEndpoint({ serverUrl: state.serverUrl });
  expect((JSON.parse(again.body) as { credential: string }).credential).toBe(credential);

  // Cross-site Origin (a remote page fetching 127.0.0.1): dark.
  const crossSite = await probeEndpoint({
    serverUrl: state.serverUrl,
    originHeader: "https://evil.example",
  });
  expect(crossSite.status).toBe(404);
  expect(crossSite.body).not.toContain(credential);

  // DNS-rebinding shape (loopback socket, foreign Host header): dark.
  const rebound = await probeEndpoint({
    serverUrl: state.serverUrl,
    hostHeader: "evil.example:80",
  });
  expect(rebound.status).toBe(404);
  expect(rebound.body).not.toContain(credential);

  // Loopback Origin (the dev vite page): granted.
  const devOrigin = await probeEndpoint({
    serverUrl: state.serverUrl,
    originHeader: new URL(state.webUrl).origin,
  });
  expect(devOrigin.status).toBe(200);
});
