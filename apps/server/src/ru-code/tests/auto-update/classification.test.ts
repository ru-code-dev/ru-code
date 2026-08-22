// ru-code: exhaustive table-driven tests for the evidence-based failure classifier
// (engine/classification.ts). PURE functions, no Effect. Every pattern branch of every classifier is
// a table row, plus the real caught-error / stderr / content-type shapes that actually reach these
// functions from the web and git channels (fault-injection completeness) and the unknown fallbacks.

import { describe, expect, it } from "@effect/vitest";

import {
  classifyContentShape,
  classifyGitStderr,
  classifyHttpStatus,
  classifyTransportRaw,
} from "../../auto-update/engine/classification.ts";
import type { UpdateFailureCode } from "@t3tools/contracts";

describe("classifyTransportRaw", () => {
  // Every branch + realistic node/undici error text that the web channel captures verbatim.
  const cases: ReadonlyArray<readonly [string, UpdateFailureCode]> = [
    // dns
    ["getaddrinfo ENOTFOUND updates.example.com", "dns"],
    ["getaddrinfo EAI_AGAIN updates.example.com", "dns"],
    ["ENOTFOUND", "dns"],
    // timeout
    ["connect ETIMEDOUT 10.0.0.1:443", "timeout"],
    ["request timed out", "timeout"],
    ["fetch failed: timeout", "timeout"],
    ["ETIMEDOUT", "timeout"],
    // refused
    ["connect ECONNREFUSED 127.0.0.1:443", "refused"],
    ["ECONNREFUSED", "refused"],
    // reset
    ["read ECONNRESET", "reset"],
    ["socket hang up", "reset"],
    // no-route
    ["connect EHOSTUNREACH 10.1.2.3:443", "no-route"],
    ["connect ENETUNREACH 10.1.2.3:443", "no-route"],
    // tls
    ["write EPROTO ... TLS alert", "tls"],
    ["unable to get local issuer certificate", "tls"],
    ["SSL handshake failed", "tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    // fallback
    ["something entirely unexpected", "transport-other"],
    ["", "transport-other"],
  ];

  it.each(cases)("classifies %j as %s", (raw, expected) => {
    expect(classifyTransportRaw(raw)).toBe(expected);
  });

  it("precedence: DNS is matched before any weaker signal in a compound message", () => {
    // A message that contains both a DNS errno and the word 'timeout' resolves to dns (checked first).
    expect(classifyTransportRaw("getaddrinfo ENOTFOUND host (later: timeout)")).toBe("dns");
  });
});

describe("classifyHttpStatus", () => {
  const cases: ReadonlyArray<readonly [number, UpdateFailureCode]> = [
    [401, "http-401"],
    [403, "http-403"],
    [404, "http-404"],
    [400, "http-status"],
    [429, "http-status"],
    [500, "http-status"],
    [503, "http-status"],
    [418, "http-status"],
  ];

  it.each(cases)("classifies status %i as %s (answered)", (status, expected) => {
    const result = classifyHttpStatus(status);
    expect(result.class).toBe("answered");
    expect(result.code).toBe(expected);
  });
});

describe("classifyContentShape", () => {
  const cases: ReadonlyArray<readonly [string | null, "blocked-shape" | null]> = [
    ["text/html", "blocked-shape"],
    ["text/html; charset=utf-8", "blocked-shape"],
    ["TEXT/HTML", "blocked-shape"],
    ["application/json", null],
    ["application/json; charset=utf-8", null],
    ["text/plain", null],
    [null, null],
    ["", null],
  ];

  it.each(cases)("content-type %j → %j", (contentType, expected) => {
    expect(classifyContentShape(contentType)).toBe(expected);
  });
});

describe("classifyGitStderr", () => {
  // Every branch + real git/ssh stderr lines the git channel feeds in.
  const cases: ReadonlyArray<
    readonly [
      string,
      { readonly class: "answered" | "transport"; readonly code: UpdateFailureCode },
    ]
  > = [
    // answered — access denied
    ["Permission denied (publickey).", { class: "answered", code: "git-access-denied" }],
    [
      "fatal: Authentication failed for 'https://host/x.git'",
      { class: "answered", code: "git-access-denied" },
    ],
    ["remote: HTTP Basic: Access denied", { class: "answered", code: "git-access-denied" }],
    [
      "error: The requested URL returned error: 403 Forbidden",
      { class: "answered", code: "git-access-denied" },
    ],
    // answered — the credential never got sent (no creds stored, or a git too old to read the
    // config we pass through the environment). The server answered 401; git then had no way to ask.
    [
      "fatal: could not read Username for 'https://host': terminal prompts disabled",
      { class: "answered", code: "git-access-denied" },
    ],
    [
      "fatal: could not read Password for 'https://u@host': terminal prompts disabled",
      { class: "answered", code: "git-access-denied" },
    ],
    // The shape a REAL rejected credential produces here, confirmed against a live authenticating
    // git server: our own GIT_ASKPASS floor is what git ends up complaining about. It used to fall
    // through to `transport-other`, whose contract is silence.
    [
      "error: unable to read askpass response from 'false'",
      { class: "answered", code: "git-access-denied" },
    ],
    // answered — not found
    [
      "fatal: repository 'https://host/x.git' not found",
      { class: "answered", code: "git-not-found" },
    ],
    ["fatal: repository does not exist", { class: "answered", code: "git-not-found" }],
    ["ERROR: Repository not found.", { class: "answered", code: "git-not-found" }],
    // transport — dns
    ["ssh: Could not resolve host: example.com", { class: "transport", code: "dns" }],
    // transport — timeout
    [
      "ssh: connect to host example.com port 22: Connection timed out",
      { class: "transport", code: "timeout" },
    ],
    [
      "fatal: unable to access: Operation timed out after 15000 ms",
      { class: "transport", code: "timeout" },
    ],
    // transport — refused
    [
      "ssh: connect to host example.com port 22: Connection refused",
      { class: "transport", code: "refused" },
    ],
    // transport — reset
    ["fatal: unable to access: Connection reset by peer", { class: "transport", code: "reset" }],
    // transport — no route
    [
      "ssh: connect to host example.com port 22: No route to host",
      { class: "transport", code: "no-route" },
    ],
    // transport — fallback
    ["git could not be started", { class: "transport", code: "transport-other" }],
    ["something else entirely", { class: "transport", code: "transport-other" }],
    ["", { class: "transport", code: "transport-other" }],
  ];

  it.each(cases)("stderr %j → %o", (stderr, expected) => {
    expect(classifyGitStderr(stderr)).toEqual(expected);
  });

  it("precedence: access-denied is matched before the not-found / transport patterns", () => {
    // A message carrying a real 403 AND 'not found' resolves to access-denied (checked first).
    expect(
      classifyGitStderr("error: The requested URL returned error: 403 — repository not found"),
    ).toEqual({ class: "answered", code: "git-access-denied" });
  });

  // The 403 alternative is ANCHORED to git's phrasing: bare `403` matched those three digits
  // anywhere in the captured stderr, and for a clone that includes the remote's sideband counters
  // ("remote: Enumerating objects: 403, done.") — which would have been read as an auth denial,
  // the one class that PAUSES a source after two of them while wiping the transport streak that
  // held the real evidence.
  it("does not read a sideband object count as an access denial", () => {
    expect(
      classifyGitStderr(
        "remote: Enumerating objects: 403, done.\nfatal: unable to access: Connection timed out",
      ),
    ).toEqual({ class: "transport", code: "timeout" });
  });
});
