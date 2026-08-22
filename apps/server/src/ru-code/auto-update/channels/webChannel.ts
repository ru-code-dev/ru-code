// ru-code: the web update source — an HTTP(S) GET of `manifest.json` (+ best-effort `changelog.json`)
// from a static host. The web channel CAN carry optional basic-auth credentials now (user/password);
// when present they ride an `Authorization: Basic …` header, so a 401/403 IS possible and is
// classified as an `answered` failure. Requests are time-boxed, the body is read through a hard size
// cap, and latency is measured for the journal. Every failure becomes ONE typed error
// (`WebSourceFailure`) carrying an evidence-based `ClassifiedFailure`: the underlying transport error
// text is CAPTURED (not collapsed) so `classifyTransportRaw` can read it. The URL helpers are pure and
// `redactUrl` hides any embedded credentials from logs/status.

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

// ru-code: the GET budget and the body cap are branding tunables — see
// ru-code/branding/src/auto-update.ts.
import {
  releaseTarballName,
  UPDATE_WEB_BODY_CAP_BYTES,
  UPDATE_WEB_TIMEOUT_MS,
} from "@ru-code/branding";

import {
  type ClassifiedFailure,
  classifyContentShape,
  classifyHttpStatus,
  classifyTransportRaw,
} from "../engine/classification.ts";
import { type Manifest, parseManifest } from "../manifest.ts";
import { redactUrl } from "../gitAuth/gitEnv.ts";

/** Optional basic-auth credentials for the web source (the password is a plaintext secret, never logged). */
export interface WebCredentials {
  readonly username: string;
  readonly password: string;
}

// ── URL helpers (pure) ───────────────────────────────────────────────────────────

/**
 * Does this URL already NAME a json file? Tested on the PATH, not on the whole string: with a
 * query attached (`…/manifest.json?token=x`) a whole-string test says "no", and the caller then
 * appends a second `/manifest.json` after the query — a corrupt address that the tarball and
 * changelog helpers inherit, since both re-run this. Unparseable input falls back to the
 * whole-string test, which is what a bare `host/path` shape needs.
 */
const namesJsonFile = (url: string): boolean => {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".json");
  } catch {
    return url.toLowerCase().endsWith(".json");
  }
};

/** Normalize a configured web URL into the manifest.json URL. */
export const resolveManifestUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return namesJsonFile(trimmed) ? trimmed : `${trimmed}/manifest.json`;
};

/**
 * The tarball URL of a release on the web source: the manifest's sibling, named by the ONE shared
 * convention (`releaseTarballName`) the producer also uses. Derived, never read from the manifest —
 * a release therefore cannot point somewhere else, and there is no address to get wrong.
 */
export const resolveTarballUrl = (manifestBaseUrl: string, version: string): string => {
  const manifest = resolveManifestUrl(manifestBaseUrl);
  const dir = manifest.replace(/\/[^/]*$/, "/");
  return `${dir}${releaseTarballName(version)}`;
};

/** The sibling URL of a file next to the manifest (e.g. changelog.json). */
const resolveSiblingUrl = (manifestUrl: string, filename: string): string => {
  const manifest = resolveManifestUrl(manifestUrl);
  const dir = manifest.replace(/\/[^/]*$/, "/");
  return `${dir}${filename}`;
};

// ── typed outcomes ─────────────────────────────────────────────────────────────

/** A parsed web release: the manifest, the raw changelog text (null when absent), and metrics. */
export interface WebRelease {
  readonly manifest: Manifest;
  readonly changelog: string | null;
  readonly latencyMs: number;
  readonly bytes: number;
}

/**
 * The single failure type for the web source. Carries an evidence-based `ClassifiedFailure`
 * (transport vs answered, a machine code, the raw fragment, latency, and an HTTP status when the
 * server answered). Replaces the old WebNetworkError / WebInvalidManifestError split — the class/code
 * inside now expresses that distinction with full evidence.
 */
export class WebSourceFailure extends Data.TaggedError("WebSourceFailure")<{
  readonly url: string;
  readonly failure: ClassifiedFailure;
}> {}

/** A lightweight reachability probe result over a manifest GET. */
export type WebProbeResult =
  | { readonly ok: true; readonly latencyMs: number; readonly raw: string }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

// ── request building ───────────────────────────────────────────────────────────

/** Build the manifest GET request, layering basic-auth when credentials are present. */
const buildManifestRequest = (
  url: string,
  creds: WebCredentials | null,
): HttpClientRequest.HttpClientRequest => {
  const base = HttpClientRequest.setHeader(
    HttpClientRequest.get(url),
    "accept",
    "application/json",
  );
  return creds === null ? base : HttpClientRequest.basicAuth(base, creds.username, creds.password);
};

// ── body reading (size-capped) ───────────────────────────────────────────────────

const decodeChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): string => {
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/** What a capped body read produced: the text, or WHY there is none. */
type CappedBody =
  | { readonly tag: "ok"; readonly text: string; readonly bytes: number }
  /** The body exceeded `UPDATE_WEB_BODY_CAP_BYTES` — the server answered, its answer is wrong. */
  | { readonly tag: "too-large" }
  /** The byte stream itself failed mid-read — a dropped connection, not a bad manifest. */
  | { readonly tag: "stream-error"; readonly raw: string };

/**
 * Read a response body into text without ever buffering more than `UPDATE_WEB_BODY_CAP_BYTES`. Folds
 * the byte stream and fails as soon as the cap is crossed, so a hostile/misconfigured host can't
 * make us allocate unbounded memory.
 *
 * The two failure modes are kept APART. They used to collapse into one `null`, which the caller
 * reported as `answered`/`invalid-manifest` — so a socket reset while the manifest body was being
 * read told the user their update source was misconfigured and needed setup, and discarded the
 * cause on the way. A dropped stream is a transport failure, which this zone's core rule
 * (classification.ts) says is indistinguishable from having no internet, and therefore silent.
 */
const readCappedText = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<CappedBody> =>
  response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
      (state, chunk: Uint8Array) => {
        const size = state.size + chunk.byteLength;
        if (size > UPDATE_WEB_BODY_CAP_BYTES) return Effect.fail("body-too-large" as const);
        state.chunks.push(chunk);
        return Effect.succeed({ chunks: state.chunks, size });
      },
    ),
    Effect.map(
      (state): CappedBody => ({
        tag: "ok",
        text: decodeChunks(state.chunks, state.size),
        bytes: state.size,
      }),
    ),
    // catchCause, not catch: a body that dies mid-stream does not always arrive as a TYPED failure.
    // undici surfaces a socket that closes after the headers as a `TypeError: terminated`, which is
    // a DEFECT — and a defect walks straight past `Effect.catch` (and past the `orElseSucceed` that
    // used to be here). It killed the fiber running the round, so nothing applied the results and
    // nothing cleared the in-flight marks: the check simply stopped, mid-flight, until the deadline
    // or a restart. Every way a body can fail to arrive ends up as one of these two tags now.
    Effect.catchCause((cause) => {
      // The only TYPED failure this fold raises is the cap sentinel, so squashing is enough to tell
      // the two apart — anything else squashes to the underlying stream error (or defect).
      const squashed: unknown = Cause.squash(cause);
      return Effect.succeed<CappedBody>(
        squashed === "body-too-large"
          ? { tag: "too-large" }
          : { tag: "stream-error", raw: describeRequestFailure(squashed) },
      );
    }),
  );

// ── error text capture ───────────────────────────────────────────────────────────

/**
 * Extract a meaningful raw fragment from a caught request error WITHOUT collapsing it. Walks the
 * error's cause chain collecting any `code` (errno like ECONNREFUSED), `reason`, and `message` so the
 * underlying transport signal survives for `classifyTransportRaw`. A timeout is normalized to a
 * stable phrase so it maps to the `timeout` code regardless of the runtime's exception shape.
 */
const describeRequestFailure = (error: unknown): string => {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { readonly _tag?: unknown })._tag === "TimeoutException"
  ) {
    return "request timed out";
  }
  const collected = collectCauseText(error, 0);
  return collected !== "" ? collected : String(error);
};

const collectCauseText = (error: unknown, depth: number): string => {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  const parts: Array<string> = [];
  if (typeof record["code"] === "string") parts.push(record["code"]);
  if (typeof record["reason"] === "string") parts.push(record["reason"]);
  if (typeof record["message"] === "string") parts.push(record["message"]);
  if ("cause" in record) parts.push(collectCauseText(record["cause"], depth + 1));
  return parts.filter((part) => part !== "").join(" ");
};

// ── fetch + classify ───────────────────────────────────────────────────────────

type ExecOutcome =
  | {
      readonly ok: true;
      readonly response: HttpClientResponse.HttpClientResponse;
      readonly latencyMs: number;
    }
  | { readonly ok: false; readonly raw: string; readonly latencyMs: number };

/**
 * Execute a request under the time budget, CAPTURING the underlying error text on any failure
 * (timeout or HttpClient error) instead of discarding it. Latency is always measured.
 */
const executeWithBudget = (
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<ExecOutcome> =>
  Effect.timed(
    httpClient.execute(request).pipe(
      Effect.timeout(Duration.millis(UPDATE_WEB_TIMEOUT_MS)),
      Effect.map((response) => ({ ok: true as const, response })),
      Effect.catch((error: unknown) =>
        Effect.succeed({ ok: false as const, raw: describeRequestFailure(error) }),
      ),
    ),
  ).pipe(
    Effect.map(([duration, outcome]) => {
      const latencyMs = Math.round(Duration.toMillis(duration));
      return outcome.ok
        ? { ok: true as const, response: outcome.response, latencyMs }
        : { ok: false as const, raw: outcome.raw, latencyMs };
    }),
  );

/** A fetched + read + parsed manifest, or a classified failure. Shared by fetch and probe. */
type ManifestOutcome =
  | {
      readonly ok: true;
      readonly manifest: Manifest;
      readonly body: { readonly text: string; readonly bytes: number };
      readonly latencyMs: number;
      readonly status: number;
    }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * GET manifest.json, apply the full evidence-based classification, and either hand back the parsed
 * manifest or a `ClassifiedFailure`. The classification order matters:
 *   1. request never completed        → transport, code from the captured raw
 *   2. non-2xx, HTML content-type      → transport `blocked-shape` (a middlebox block page)
 *   3. non-2xx otherwise               → answered http-4xx / http-status
 *   4. 2xx, body stream failed         → transport, code from the captured raw (the request did
 *                                        NOT complete — a 2xx header is not a completed answer)
 *   5. 2xx, body over the cap          → answered `invalid-manifest`
 *   6. 2xx, HTML content-type          → transport `blocked-shape`
 *   7. 2xx, parseManifest null         → answered `invalid-manifest`
 */
const fetchManifestClassified = (
  url: string,
  creds: WebCredentials | null,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<ManifestOutcome> =>
  Effect.gen(function* () {
    const redacted = redactUrl(url);
    const exec = yield* executeWithBudget(httpClient, buildManifestRequest(url, creds));

    if (!exec.ok) {
      return {
        ok: false,
        failure: {
          class: "transport",
          code: classifyTransportRaw(exec.raw),
          raw: exec.raw,
          latencyMs: exec.latencyMs,
          status: null,
        },
      };
    }

    const status = exec.response.status;
    const contentType = exec.response.headers["content-type"] ?? null;

    if (status < 200 || status >= 300) {
      if (classifyContentShape(contentType) === "blocked-shape") {
        return {
          ok: false,
          failure: {
            class: "transport",
            code: "blocked-shape",
            raw: `HTTP ${status} (html block page)`,
            latencyMs: exec.latencyMs,
            status,
          },
        };
      }
      const answered = classifyHttpStatus(status);
      return {
        ok: false,
        failure: {
          class: answered.class,
          code: answered.code,
          raw: `HTTP ${status}`,
          latencyMs: exec.latencyMs,
          status,
        },
      };
    }

    const body = yield* readCappedText(exec.response);
    // The stream died mid-body: the request never completed, so this is TRANSPORT — the same class
    // a reset during the headers would produce, with the errno preserved as evidence. Reporting it
    // as `invalid-manifest` told the user to go fix a source that is fine.
    if (body.tag === "stream-error") {
      return {
        ok: false,
        failure: {
          class: "transport",
          code: classifyTransportRaw(body.raw),
          raw: body.raw,
          latencyMs: exec.latencyMs,
          status,
        },
      };
    }
    // Over the cap: the server answered in full and the answer is not a manifest we will read.
    if (body.tag === "too-large") {
      return {
        ok: false,
        failure: {
          class: "answered",
          code: "invalid-manifest",
          raw: `manifest body over the ${String(UPDATE_WEB_BODY_CAP_BYTES)}-byte cap`,
          latencyMs: exec.latencyMs,
          status,
        },
      };
    }

    if (classifyContentShape(contentType) === "blocked-shape") {
      return {
        ok: false,
        failure: {
          class: "transport",
          code: "blocked-shape",
          raw: `2xx html content-type from ${redacted}`,
          latencyMs: exec.latencyMs,
          status,
        },
      };
    }

    const manifest = parseManifest(body.text);
    if (manifest === null) {
      return {
        ok: false,
        failure: {
          class: "answered",
          code: "invalid-manifest",
          raw: "manifest.json could not be parsed",
          latencyMs: exec.latencyMs,
          status,
        },
      };
    }

    return {
      ok: true,
      manifest,
      body: { text: body.text, bytes: body.bytes },
      latencyMs: exec.latencyMs,
      status,
    };
  });

/** GET a sibling file, returning its text or `null` when it is absent / unreachable (never fails). */
const fetchOptionalText = (
  httpClient: HttpClient.HttpClient,
  url: string,
  creds: WebCredentials | null,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const base = HttpClientRequest.get(url);
    const request =
      creds === null ? base : HttpClientRequest.basicAuth(base, creds.username, creds.password);
    const exec = yield* executeWithBudget(httpClient, request);
    if (!exec.ok) return null;
    const status = exec.response.status;
    if (status < 200 || status >= 300) return null;
    const body = yield* readCappedText(exec.response);
    // The changelog is best-effort by contract: any reason for having no text is the same `null`.
    return body.tag === "ok" ? body.text : null;
  });

// ── public API ───────────────────────────────────────────────────────────────────

/**
 * Fetch and parse a web release: GET manifest.json (required, with optional basic auth), then
 * best-effort GET changelog.json (its absence is `null`, not an error). Any failure is ONE
 * `WebSourceFailure` carrying the evidence-based `ClassifiedFailure`.
 */
export const fetchWebRelease = (
  baseUrl: string,
  creds: WebCredentials | null,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<WebRelease, WebSourceFailure> =>
  Effect.gen(function* () {
    const url = resolveManifestUrl(baseUrl);
    const outcome = yield* fetchManifestClassified(url, creds, httpClient);
    if (!outcome.ok) {
      return yield* new WebSourceFailure({ url: redactUrl(url), failure: outcome.failure });
    }

    const changelog = yield* fetchOptionalText(
      httpClient,
      resolveSiblingUrl(url, "changelog.json"),
      creds,
    );
    const bytes =
      outcome.body.bytes + (changelog === null ? 0 : new TextEncoder().encode(changelog).length);
    yield* Effect.logDebug("[auto-update] web release fetched", {
      url: redactUrl(url),
      version: outcome.manifest.version,
      bytes,
      latencyMs: outcome.latencyMs,
    });
    return { manifest: outcome.manifest, changelog, latencyMs: outcome.latencyMs, bytes };
  });

/**
 * Lightweight reachability probe: GET manifest.json (NOT HEAD — static hosts frequently 405 HEAD).
 * The manifest is tiny and the size cap still applies. Uses the same evidence-based classification
 * as the fetch; returns `{ok:true, latencyMs, raw}` on a valid manifest or `{ok:false, failure}`.
 */
export const probeWeb = (
  baseUrl: string,
  creds: WebCredentials | null,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<WebProbeResult> =>
  Effect.gen(function* () {
    const url = resolveManifestUrl(baseUrl);
    const outcome = yield* fetchManifestClassified(url, creds, httpClient);
    return outcome.ok
      ? { ok: true, latencyMs: outcome.latencyMs, raw: `GET ${outcome.status}` }
      : { ok: false, failure: outcome.failure };
  });
