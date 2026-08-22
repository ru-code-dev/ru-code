// ru-code: evidence-based failure classification for the auto-update check machine. PURE — no
// Effect, no I/O, trivially table-testable. The whole point is to NEVER guess why the network
// failed: we read the actual evidence (an errno / a TLS phrase / an HTTP status / a git stderr line /
// a response content-type) and map it to a stable machine code the wire carries. Two evidence
// classes exist (see model.ts):
//   · `transport` — the request never completed (DNS, timeout, refused/reset, no route, TLS drop) OR
//     the answer's SHAPE is wrong for the protocol (an HTML block page where JSON was expected — a
//     middlebox, not our server). Indistinguishable from "no internet", therefore silent.
//   · `answered`  — the real server replied and the reply is wrong (4xx, invalid manifest, git
//     access denial / repository-not-found). Actionable.
// Every branch here corresponds to a caught-error shape the channels can produce; the test table is
// exhaustive over them (fault-injection rule).

import type { UpdateFailureClass, UpdateFailureCode } from "@t3tools/contracts";

/**
 * A fully classified failure ready to become a `SourceCheckResultWire` fail / `CredentialTestResult`
 * / run error. `status` is present only for HTTP answers (null/absent otherwise); `raw` is the mono
 * technical fragment shown verbatim to the user (already redacted by the caller).
 */
export interface ClassifiedFailure {
  readonly class: UpdateFailureClass;
  readonly code: UpdateFailureCode;
  readonly raw: string | null;
  readonly latencyMs: number | null;
  readonly status?: number | null;
}

// ── transport (the request never completed) ─────────────────────────────────────

/**
 * Map a raw transport error fragment (an errno code, an ssl phrase, a node/undici message) to a
 * transport-class code. Order is precedence: DNS → timeout → refused → reset → no-route → TLS →
 * everything else. Case-insensitive so uppercase errno codes (`ECONNREFUSED`) and lowercase prose
 * ("connection refused") both match. Always a transport code — the caller supplies the class.
 */
export const classifyTransportRaw = (raw: string): UpdateFailureCode => {
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return "dns";
  if (/ETIMEDOUT|timed out|timeout/i.test(raw)) return "timeout";
  if (/ECONNREFUSED/i.test(raw)) return "refused";
  if (/ECONNRESET|socket hang up/i.test(raw)) return "reset";
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return "no-route";
  if (/TLS|certificate|handshake|UNABLE_TO_VERIFY/i.test(raw)) return "tls";
  return "transport-other";
};

// ── answered (the server replied and the reply is wrong) ─────────────────────────

/** Map a non-2xx HTTP status to an answered code. 401/403/404 get dedicated codes; the rest carry the raw status. */
export const classifyHttpStatus = (
  status: number,
): {
  readonly class: "answered";
  readonly code: "http-401" | "http-403" | "http-404" | "http-status";
} => {
  if (status === 401) return { class: "answered", code: "http-401" };
  if (status === 403) return { class: "answered", code: "http-403" };
  if (status === 404) return { class: "answered", code: "http-404" };
  return { class: "answered", code: "http-status" };
};

/**
 * A response whose content-type is HTML where JSON was expected is a middlebox block page, NOT our
 * server — reclassify to the transport `blocked-shape` code (silent). Anything else (JSON, missing
 * content-type, other types) is not a block page here → null (the caller keeps its own verdict).
 */
export const classifyContentShape = (contentType: string | null): "blocked-shape" | null =>
  contentType !== null && /text\/html/i.test(contentType) ? "blocked-shape" : null;

// ── git stderr ───────────────────────────────────────────────────────────────────

/**
 * Map a `git ls-remote` / clone stderr line to a class + code. Answered (actionable) is checked
 * first: access denials and repository-not-found are real server replies. Otherwise transport
 * patterns (DNS / timeout / refused / reset / no-route); anything unrecognized falls to the
 * transport `transport-other` code so an unknown message never masquerades as an actionable one.
 */
export const classifyGitStderr = (
  stderr: string,
): { readonly class: UpdateFailureClass; readonly code: UpdateFailureCode } => {
  // The 403 alternative is ANCHORED to git's own phrasing on purpose. Bare `403` matched those
  // three characters anywhere in the captured stderr — which for a clone includes the remote's
  // sideband counters ("remote: Enumerating objects: 403, done."), printed regardless of TTY. A
  // byte figure or an object count could therefore be read as an auth denial, and an answered auth
  // denial is the one class that PAUSES a source after two of them (transitions.ts) while wiping
  // the transport streak that held the real evidence.
  if (/permission denied|authentication failed|access denied|returned error:\s*403/i.test(stderr)) {
    return { class: "answered", code: "git-access-denied" };
  }
  // ru-code: the server asked for a credential and git could not supply one. The server DID answer
  // (with a 401), so this is answered/actionable, not transport — without this branch it fell to
  // `transport-other`, whose whole contract is "indistinguishable from no internet, therefore
  // silent", which made the single most fixable auth failure the one nobody was told about.
  //
  // Three shapes, all meaning the same thing — the server demanded a credential and
  // git could not supply one:
  //   · "could not read Username for '…': terminal prompts disabled"   (no askpass configured)
  //   · "unable to read askpass response from 'false'"                 (OUR floor: GIT_ASKPASS=false,
  //     which is what stops git popping a GUI helper — so this is the shape a real rejected or
  //     missing credential actually produces here, confirmed against a live authenticating server)
  //   · "Authentication failed" / 403                                  (matched above)
  if (
    /could not read (username|password)|terminal prompts disabled|unable to read askpass response/i.test(
      stderr,
    )
  ) {
    return { class: "answered", code: "git-access-denied" };
  }
  if (/repository (not found|does not exist)|not found/i.test(stderr)) {
    return { class: "answered", code: "git-not-found" };
  }
  // Transport patterns are checked AFTER the answered ones, so an answered reply is never masked
  // by a transport word appearing in the same buffer.
  if (/could not resolve host/i.test(stderr)) return { class: "transport", code: "dns" };
  if (/timed out/i.test(stderr)) return { class: "transport", code: "timeout" };
  if (/connection refused/i.test(stderr)) return { class: "transport", code: "refused" };
  if (/connection reset/i.test(stderr)) return { class: "transport", code: "reset" };
  if (/no route/i.test(stderr)) return { class: "transport", code: "no-route" };
  return { class: "transport", code: "transport-other" };
};
