// ru-code: the web channel over a real in-process node:http server — manifest fetch/parse (with
// optional basic auth), the best-effort changelog (absence is null, not an error), evidence-based
// failure classification (transport vs answered), the block-page guard (2xx html → transport
// blocked-shape), and the GET-based reachability probe (GET, NOT HEAD — static hosts 405 HEAD).
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import {
  fetchWebRelease,
  probeWeb,
  WebSourceFailure,
} from "../../auto-update/channels/webChannel.ts";

const VALID_MANIFEST =
  '{"version":"1.2.3","sha256":"deadbeef","tarballUrl":"ru-code-1.2.3.tgz","minNode":">=20","sizeBytes":123,"releasedAt":"2026-01-01T00:00:00Z"}';
const CHANGELOG = '{"1.2.3":["first note","second note"]}';
const BLOCK_PAGE_HTML = "<!doctype html><html><body>Access blocked by your network</body></html>";

// The Authorization header the /auth route observed (basic-auth presence assertion). Read through a
// getter so control-flow narrowing across the async request boundary can't collapse its type.
let observedAuthHeader: string | null = null;
const readObservedAuthHeader = (): string | null => observedAuthHeader;

// Routes:
//   /good        manifest + changelog (json)
//   /nochangelog manifest, changelog 404
//   /notfound    manifest 404
//   /garbage     manifest 200 but not json
//   /blocked     manifest 200 but text/html (a middlebox block page)
//   /auth        manifest ONLY with a valid Authorization header, else 401
//   /gethead     manifest for GET, 405 for HEAD (proves the probe uses GET)
const handler: NodeHttp.RequestListener = (req, res) => {
  const url = req.url ?? "";
  const sendJson = (status: number, body: string) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  };
  const sendHtml = (status: number, body: string) => {
    res.statusCode = status;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  };

  if (url === "/good/manifest.json") return sendJson(200, VALID_MANIFEST);
  if (url === "/good/changelog.json") return sendJson(200, CHANGELOG);
  if (url === "/nochangelog/manifest.json") return sendJson(200, VALID_MANIFEST);
  if (url === "/nochangelog/changelog.json") return sendJson(404, "not found");
  if (url === "/notfound/manifest.json") return sendJson(404, "not found");
  if (url === "/garbage/manifest.json") return sendJson(200, "this is <<not>> json {{{");
  if (url === "/blocked/manifest.json") return sendHtml(200, BLOCK_PAGE_HTML);
  if (url === "/auth/manifest.json") {
    observedAuthHeader = req.headers["authorization"] ?? null;
    if (observedAuthHeader === null) return sendJson(401, "unauthorized");
    return sendJson(200, VALID_MANIFEST);
  }
  if (url === "/auth/changelog.json") return sendJson(404, "no changelog");
  // A 200 with a content-length the server never satisfies: headers go out, one chunk follows, then
  // the socket is destroyed. This is a stream failure MID-BODY — the request did not complete — and
  // it used to be reported as `answered`/`invalid-manifest`, i.e. «your update source needs setup»,
  // with the cause discarded.
  if (url === "/mid-body/manifest.json") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", String(VALID_MANIFEST.length));
    res.write(VALID_MANIFEST.slice(0, 10));
    res.socket?.destroy();
    return;
  }
  // CHUNKED (no content-length): headers + one chunk go out, then the socket dies. undici resolves
  // the response as soon as the headers arrive here, so the failure lands on the BODY STREAM.
  if (url === "/chunked-die/manifest.json") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    // Destroy in the WRITE CALLBACK, not on a timer: the callback fires once the chunk has been
    // flushed to the socket, so the client is guaranteed to have seen the headers and a partial
    // body before the connection dies. A timer would only make that likely.
    res.write(VALID_MANIFEST.slice(0, 10), () => res.socket?.destroy());
    return;
  }
  if (url === "/gethead/manifest.json") {
    if (req.method === "HEAD") {
      res.statusCode = 405;
      res.end();
      return;
    }
    return sendJson(200, VALID_MANIFEST);
  }
  return sendJson(404, "not found");
};

const withServer = <A, E>(
  use: (baseUrl: string) => Effect.Effect<A, E, HttpClient.HttpClient>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly baseUrl: string; readonly server: NodeHttp.Server }>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
          });
        }),
    ),
    ({ baseUrl }) => use(baseUrl).pipe(Effect.provide(FetchHttpClient.layer)),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

// A base URL whose port is bound then immediately released → connections are refused (fast,
// stands in for the timeout/unreachable branch without waiting out the 10s budget).
const closedBaseUrl = Effect.promise(
  () =>
    new Promise<string>((resolve) => {
      const server = NodeHttp.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(`http://127.0.0.1:${port}`));
      });
    }),
);

describe("a body that dies mid-stream is TRANSPORT, not a bad manifest", () => {
  // The zone's core rule (classification.ts): a request that did not complete is indistinguishable
  // from having no internet, and is therefore SILENT. Calling it `answered` sent the user to fix a
  // source that was fine — and `heroStatus` turns any answered failure into «нужна настройка».
  it.effect("classifies a truncated manifest body as transport", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const probe = yield* probeWeb(`${baseUrl}/mid-body`, null, client);
        expect(probe.ok).toBe(false);
        if (!probe.ok) {
          expect(probe.failure.class).toBe("transport");
          expect(probe.failure.code).not.toBe("invalid-manifest");
          // The cause survives instead of being collapsed into a bare null.
          expect(probe.failure.raw).not.toBe("");
        }
      }),
    ),
  );

  // The other half of the same branch: a body that is simply too large IS an answer — the server
  // completed the response and it is not a manifest we will read.
  it.effect("classifies a chunked body that dies after the headers as transport", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const probe = yield* probeWeb(`${baseUrl}/chunked-die`, null, client);
        expect(probe.ok).toBe(false);
        if (!probe.ok) {
          expect(probe.failure.class).toBe("transport");
          // status 200 proves this went through the BODY STREAM, not the request: the headers
          // arrived and were accepted, and the failure happened afterwards. That is the branch a
          // typed `Effect.catch` could not see — undici raises it as a `TypeError: terminated`,
          // i.e. a DEFECT, which walked past the handler and killed the fiber running the round.
          // Nothing then applied the results or cleared the in-flight marks: the check just
          // stopped, mid-flight.
          expect(probe.failure.status).toBe(200);
          expect(probe.failure.raw).toContain("terminated");
        }
      }),
    ),
  );

  it.effect("still classifies a 2xx body that is not a manifest as answered", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const probe = yield* probeWeb(`${baseUrl}/garbage`, null, client);
        expect(probe.ok).toBe(false);
        if (!probe.ok) {
          expect(probe.failure.class).toBe("answered");
          expect(probe.failure.code).toBe("invalid-manifest");
        }
      }),
    ),
  );
});

describe("fetchWebRelease", () => {
  it.effect("parses a 200 manifest and reads the sibling changelog", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const release = yield* fetchWebRelease(`${baseUrl}/good`, null, client);
        expect(release.manifest.version).toBe("1.2.3");
        expect(release.manifest.sha256).toBe("deadbeef");
        expect(release.manifest.minNode).toBe(">=20");
        expect(release.changelog).toBe(CHANGELOG);
        expect(typeof release.latencyMs).toBe("number");
        expect(release.latencyMs).toBeGreaterThanOrEqual(0);
        expect(release.bytes).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("returns changelog=null when changelog.json is absent (not an error)", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const release = yield* fetchWebRelease(`${baseUrl}/nochangelog`, null, client);
        expect(release.manifest.version).toBe("1.2.3");
        expect(release.changelog).toBeNull();
      }),
    ),
  );

  it.effect("fails answered http-404 on a non-2xx manifest", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const error = yield* fetchWebRelease(`${baseUrl}/notfound`, null, client).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WebSourceFailure);
        expect(error.failure.class).toBe("answered");
        expect(error.failure.code).toBe("http-404");
        expect(error.failure.status).toBe(404);
      }),
    ),
  );

  it.effect("fails transport (captured raw) when the host is unreachable", () =>
    Effect.gen(function* () {
      const baseUrl = yield* closedBaseUrl;
      const client = yield* HttpClient.HttpClient;
      const error = yield* fetchWebRelease(`${baseUrl}/good`, null, client).pipe(Effect.flip);
      expect(error).toBeInstanceOf(WebSourceFailure);
      expect(error.failure.class).toBe("transport");
      expect(error.failure.status).toBeNull();
      expect(error.failure.raw).not.toBeNull();
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("fails answered invalid-manifest on a garbage manifest", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const error = yield* fetchWebRelease(`${baseUrl}/garbage`, null, client).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WebSourceFailure);
        expect(error.failure.class).toBe("answered");
        expect(error.failure.code).toBe("invalid-manifest");
      }),
    ),
  );

  it.effect("reclassifies a 2xx html block page as transport blocked-shape", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const error = yield* fetchWebRelease(`${baseUrl}/blocked`, null, client).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WebSourceFailure);
        expect(error.failure.class).toBe("transport");
        expect(error.failure.code).toBe("blocked-shape");
      }),
    ),
  );

  it.effect("sends an Authorization: Basic header when credentials are present", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        observedAuthHeader = null;
        const client = yield* HttpClient.HttpClient;
        const release = yield* fetchWebRelease(
          `${baseUrl}/auth`,
          { username: "u", password: "p" },
          client,
        );
        expect(release.manifest.version).toBe("1.2.3");
        const header = readObservedAuthHeader();
        expect(header).not.toBeNull();
        expect(header?.startsWith("Basic ")).toBe(true);
        // "u:p" base64-encoded
        expect(header).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
      }),
    ),
  );

  it.effect("fails answered http-401 when credentials are absent on a protected source", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        observedAuthHeader = null;
        const client = yield* HttpClient.HttpClient;
        const error = yield* fetchWebRelease(`${baseUrl}/auth`, null, client).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WebSourceFailure);
        expect(error.failure.class).toBe("answered");
        expect(error.failure.code).toBe("http-401");
      }),
    ),
  );
});

describe("probeWeb", () => {
  it.effect("reports ok with latency for a reachable manifest via GET", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = yield* probeWeb(`${baseUrl}/good`, null, client);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(typeof result.latencyMs).toBe("number");
          expect(result.latencyMs).toBeGreaterThanOrEqual(0);
          expect(result.raw).toContain("200");
        }
      }),
    ),
  );

  it.effect("uses GET not HEAD (a HEAD-405 host still probes ok)", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = yield* probeWeb(`${baseUrl}/gethead`, null, client);
        expect(result.ok).toBe(true);
      }),
    ),
  );

  it.effect("reports an answered failure on a non-2xx manifest", () =>
    withServer((baseUrl) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = yield* probeWeb(`${baseUrl}/notfound`, null, client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.class).toBe("answered");
          expect(result.failure.code).toBe("http-404");
        }
      }),
    ),
  );

  it.effect("reports a transport failure when the host is unreachable", () =>
    Effect.gen(function* () {
      const baseUrl = yield* closedBaseUrl;
      const client = yield* HttpClient.HttpClient;
      const result = yield* probeWeb(`${baseUrl}/good`, null, client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.class).toBe("transport");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
