// ru-code: LOOPBACK AUTO-AUTH — the local-bootstrap credential endpoint.
//
// In web mode bound to a loopback host, opening http://127.0.0.1:<port> must
// always reach the app with zero pairing token: the startup pairing token is
// one-time with a 5-minute TTL, so after cleared browser data / a second
// browser / an expired 30-day session the only recovery used to be restarting
// the server. This module gives loopback pages a same-origin way to obtain a
// bootstrap credential and exchange it through the EXISTING browser-session
// flow (auth.browserSession) — no new auth mechanism, no contract change.
//
// Trust envelope (identical to the desktop-bootstrap seed, see
// PairingGrantStore.ts): any local OS process can fetch the credential. What
// the endpoint MUST resist is the browser being used as a springboard by a
// remote page. Three request gates, all required:
//   · socket peer is loopback — the request physically originated on this host;
//   · Host header is loopback — kills DNS-rebinding (evil.com resolving to
//     127.0.0.1 still sends `Host: evil.com`);
//   · Origin header is absent or loopback — a cross-site `cors` fetch sends the
//     remote Origin and is refused; a `no-cors` fetch gets an opaque response
//     the page cannot read. Source-IP alone would NOT be enough — a malicious
//     page's requests to 127.0.0.1 arrive from loopback.
// Every refusal is a plain 404 (the endpoint stays dark to probes).
//
// The grant is minted lazily per request window: 24h TTL (mirrors the desktop
// bootstrap TTL rationale), unbounded uses, rotated when the remaining TTL
// drops under the margin — so a server running for weeks keeps working, unlike
// a single boot-time seed. Credential generation and grant seeding are the
// store's own internals, handed over by a marked seam in PairingGrantStore.make
// (`installLocalBootstrapMinting`); this module never prints or logs the
// credential and it never appears in any URL.
//
// Scopes: AuthAdministrativeScopes — the SAME grant the startup pairing token
// carries (EnvironmentAuth.issueStartupPairingCredential), so auto-auth is
// byte-equivalent to pasting the startup token, never a downgrade.
//
// Off-switch: RU_CODE_LOCAL_AUTO_AUTH=0 (for shared machines where local
// processes of other users must not reach the app). Default ON.
//
// Loopback/wildcard host predicates are mirrored from startupAccess.ts on
// purpose: importing them would close a runtime module cycle
// (startupAccess → EnvironmentAuth → PairingGrantStore → this file).

import { AuthAdministrativeScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type {
  BootstrapGrant,
  PairingCredentialRandomGenerationError,
} from "../../auth/PairingGrantStore.ts";

export const LOCAL_BOOTSTRAP_ROUTE_PATH = "/api/auth/local-bootstrap";
export const LOCAL_LOOPBACK_BOOTSTRAP_SUBJECT = "local-loopback-bootstrap";

// Mirrors the desktop-bootstrap TTL (PairingGrantStore.DESKTOP_BOOTSTRAP_TTL_HOURS):
// long enough that a page reload always recovers, short enough that a credential
// is never valid "forever". Rotation below keeps long-uptime servers working.
const LOCAL_BOOTSTRAP_TTL = Duration.hours(24);
// Rotate while the credential still has comfortably enough life left for the
// client to exchange it (the exchange happens within milliseconds of the fetch).
const LOCAL_BOOTSTRAP_ROTATE_MARGIN = Duration.hours(1);

/** `RU_CODE_LOCAL_AUTO_AUTH=0` (or `false`) disables the feature; default ON. */
export const isLocalAutoAuthEnabled = (flagValue: string | undefined): boolean => {
  const normalized = flagValue?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
};

/** Mirror of startupAccess.isLoopbackHost (see header for why it is mirrored). */
const isLoopbackHostValue = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

/** Mirror of startupAccess.isWildcardHost (see header for why it is mirrored). */
const isWildcardHostValue = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export interface LocalAutoAuthServerConfig {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
}

/**
 * Web mode on a loopback bind — exactly the `loopback-browser` policy of
 * EnvironmentAuthPolicy. Desktop has its own bootstrap channel; remote and
 * wildcard binds must keep requiring a pairing token.
 */
export const isLocalAutoAuthEligible = (config: LocalAutoAuthServerConfig): boolean =>
  config.mode === "web" && !isWildcardHostValue(config.host) && isLoopbackHostValue(config.host);

/** The grant shape this module seeds (the store's remainingUses stays internal). */
type SeededLocalBootstrapGrant = BootstrapGrant & { readonly remainingUses: "unbounded" };

export interface InstallLocalBootstrapMintingInput {
  readonly config: LocalAutoAuthServerConfig;
  readonly generateCredential: Effect.Effect<string, PairingCredentialRandomGenerationError>;
  readonly seedGrant: (credential: string, grant: SeededLocalBootstrapGrant) => Effect.Effect<void>;
}

interface MintedCredential {
  readonly credential: string;
  readonly expiresAtMillis: number;
}

interface LocalBootstrapState {
  readonly generateCredential: InstallLocalBootstrapMintingInput["generateCredential"];
  readonly seedGrant: InstallLocalBootstrapMintingInput["seedGrant"];
  minted: MintedCredential | null;
}

// Module-level box, same pattern as auto-update/healthz.ts: PairingGrantStore's
// construction fills it, the route layer reads it — no layer-graph plumbing and
// the route can never fail to register. One store per process in production;
// tests reset via __resetLocalAutoAuthForTests.
const stateBox: { value: LocalBootstrapState | null } = { value: null };

export const __resetLocalAutoAuthForTests = (): void => {
  stateBox.value = null;
};

/**
 * Called from the marked seam in PairingGrantStore.make. Installs the minting
 * capability when the server is eligible (web + loopback + flag on); otherwise
 * clears it. Never fails — ineligible configs make the endpoint a plain 404.
 */
export const installLocalBootstrapMinting = (
  input: InstallLocalBootstrapMintingInput,
): Effect.Effect<void> =>
  Effect.sync(() => {
    stateBox.value =
      isLocalAutoAuthEligible(input.config) &&
      isLocalAutoAuthEnabled(process.env["RU_CODE_LOCAL_AUTO_AUTH"])
        ? {
            generateCredential: input.generateCredential,
            seedGrant: input.seedGrant,
            minted: null,
          }
        : null;
  });

export const shouldRotateLocalBootstrapCredential = (
  nowMillis: number,
  expiresAtMillis: number,
): boolean => expiresAtMillis - nowMillis <= Duration.toMillis(LOCAL_BOOTSTRAP_ROTATE_MARGIN);

/**
 * Get-or-rotate the current credential. Two concurrent mints may both seed a
 * grant — harmless: both credentials are valid until their expiry and the box
 * simply keeps the last one; the seeded map drops the loser on its expiry.
 */
const mintLocalBootstrapCredential = (
  state: LocalBootstrapState,
): Effect.Effect<string, PairingCredentialRandomGenerationError> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const current = state.minted;
    if (
      current !== null &&
      !shouldRotateLocalBootstrapCredential(now.epochMilliseconds, current.expiresAtMillis)
    ) {
      return current.credential;
    }
    const credential = yield* state.generateCredential;
    const expiresAt = DateTime.add(now, {
      milliseconds: Duration.toMillis(LOCAL_BOOTSTRAP_TTL),
    });
    yield* state.seedGrant(credential, {
      method: "desktop-bootstrap",
      scopes: AuthAdministrativeScopes,
      subject: LOCAL_LOOPBACK_BOOTSTRAP_SUBJECT,
      expiresAt,
      remainingUses: "unbounded",
    });
    state.minted = { credential, expiresAtMillis: expiresAt.epochMilliseconds };
    return credential;
  });

export type LocalBootstrapGateVerdict =
  | "grant"
  | "not-installed"
  | "peer-not-loopback"
  | "host-not-loopback"
  | "origin-not-loopback";

/** Peer addresses are raw socket IPs; IPv4-mapped IPv6 (`::ffff:127.0.0.1`) included. */
const isLoopbackPeerAddress = (address: string | undefined): boolean => {
  if (!address) {
    return false;
  }
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || normalized.startsWith("127.");
};

/** Extract the hostname of a Host header value (`[::1]:3773` → `::1`). */
const parseHostHeaderHostname = (hostHeader: string): string | null => {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  } catch {
    return null;
  }
};

const isLoopbackHostHeader = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) {
    return false;
  }
  const hostname = parseHostHeaderHostname(hostHeader);
  return hostname !== null && isLoopbackHostValue(hostname);
};

/**
 * Absent Origin = same-origin GET navigation/fetch — allowed. A present Origin
 * must parse and be loopback ("null" — sandboxed/opaque provenance — is not).
 */
const isAllowedOriginHeader = (originHeader: string | undefined): boolean => {
  if (originHeader === undefined) {
    return true;
  }
  try {
    const hostname = new URL(originHeader).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return isLoopbackHostValue(hostname);
  } catch {
    return false;
  }
};

/** The pure request gate — every rejection renders as the same 404. */
export const evaluateLocalBootstrapGate = (input: {
  readonly installed: boolean;
  readonly peerAddress: string | undefined;
  readonly hostHeader: string | undefined;
  readonly originHeader: string | undefined;
}): LocalBootstrapGateVerdict => {
  if (!input.installed) {
    return "not-installed";
  }
  if (!isLoopbackPeerAddress(input.peerAddress)) {
    return "peer-not-loopback";
  }
  if (!isLoopbackHostHeader(input.hostHeader)) {
    return "host-not-loopback";
  }
  if (!isAllowedOriginHeader(input.originHeader)) {
    return "origin-not-loopback";
  }
  return "grant";
};

/** Same source shape auth/utils.ts readRemoteAddressFromSource reads. */
const readPeerAddress = (source: unknown): string | undefined => {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  return candidate.socket?.remoteAddress ?? candidate.remoteAddress ?? undefined;
};

const notFoundResponse = HttpServerResponse.empty({ status: 404 });

/**
 * Registered in server.ts `makeRoutesLayer` (marked seam) before the GET *
 * catch-all — under /api so the dev vite proxy forwards it, exact path so it
 * can never shadow a declared EnvironmentHttpApi endpoint.
 */
export const localBootstrapRouteLayer = HttpRouter.add(
  "GET",
  LOCAL_BOOTSTRAP_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const state = stateBox.value;
    const verdict = evaluateLocalBootstrapGate({
      installed: state !== null,
      peerAddress: readPeerAddress(request.source),
      hostHeader: request.headers["host"],
      originHeader: request.headers["origin"],
    });
    if (verdict !== "grant" || state === null) {
      return notFoundResponse;
    }
    const credential = yield* mintLocalBootstrapCredential(state).pipe(
      Effect.catch((cause) =>
        Effect.logError("local bootstrap credential mint failed", { cause }).pipe(Effect.as(null)),
      ),
    );
    if (credential === null) {
      return notFoundResponse;
    }
    return HttpServerResponse.jsonUnsafe(
      { credential },
      { headers: { "Cache-Control": "no-store" } },
    );
  }),
);
