// ru-code: LOOPBACK AUTO-AUTH — client half of the local-bootstrap flow.
//
// When the auth gate finds no desktop credential and no live session, this
// module asks the server's loopback-gated endpoint
// (`GET /api/auth/local-bootstrap`, apps/server/src/ru-code/auth/localAutoAuth.ts)
// for a bootstrap credential and exchanges it through the EXISTING
// browser-session path — identical to the desktop bootstrap flow, so cleared
// browser data / a second browser / an expired 30-day session recover on a
// loopback server with zero pairing token. Any refusal (remote bind, desktop
// mode, feature off, endpoint absent) returns false and the caller falls
// through to the /pair flow exactly as before.
//
// The exchange/wait functions are injected by the caller (they are private to
// environments/primary/auth.ts); the IO seam below is injected so the unit
// tests exercise the full decision flow without a window or network.

import {
  isLoopbackHostname,
  resolvePrimaryEnvironmentHttpUrl,
} from "../../environments/primary/target";

export const LOCAL_BOOTSTRAP_ENDPOINT_PATH = "/api/auth/local-bootstrap";

export interface LocalLoopbackBootstrapIo {
  /** Absolute URL of the local-bootstrap endpoint on the primary target. */
  readonly resolveEndpointUrl: () => string;
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly exchangeBootstrapCredential: (credential: string) => Promise<unknown>;
  readonly waitForAuthenticatedSession: () => Promise<unknown>;
}

/** Full flow with injected IO — returns true iff the session is now authenticated. */
export async function tryLocalLoopbackBootstrapWith(
  io: LocalLoopbackBootstrapIo,
): Promise<boolean> {
  try {
    const endpointUrl = io.resolveEndpointUrl();
    // Only ever talk to a loopback target — a configured remote target must
    // keep its normal pairing flow (the server would refuse anyway; this keeps
    // the client from even probing).
    if (!isLoopbackHostname(new URL(endpointUrl).hostname)) {
      return false;
    }
    const response = await io.fetchImpl(endpointUrl, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return false;
    }
    const payload: unknown = await response.json();
    const credential =
      typeof payload === "object" && payload !== null
        ? (payload as { readonly credential?: unknown }).credential
        : undefined;
    if (typeof credential !== "string" || credential.length === 0) {
      return false;
    }
    await io.exchangeBootstrapCredential(credential);
    await io.waitForAuthenticatedSession();
    return true;
  } catch {
    // Silent by design: the fallback UX (the /pair page) is the pre-existing
    // behaviour, and a refusal here is an expected state, not an error.
    return false;
  }
}

/** Production wiring — called from the marked seam in environments/primary/auth.ts. */
export function tryLocalLoopbackBootstrap(deps: {
  readonly exchangeBootstrapCredential: (credential: string) => Promise<unknown>;
  readonly waitForAuthenticatedSession: () => Promise<unknown>;
}): Promise<boolean> {
  return tryLocalLoopbackBootstrapWith({
    resolveEndpointUrl: () => resolvePrimaryEnvironmentHttpUrl(LOCAL_BOOTSTRAP_ENDPOINT_PATH),
    // Bounded probe: the gate must never hang the app shell on this request —
    // an abort lands in the catch and falls through to /pair like any refusal.
    fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }),
    exchangeBootstrapCredential: deps.exchangeBootstrapCredential,
    waitForAuthenticatedSession: deps.waitForAuthenticatedSession,
  });
}
