// ru-fork: tests for the --base-url / base-path support.
//
// Four unit suites cover the pure helpers; one integration suite spins
// up a minimal HttpServer using `prefixedRouteLayer` to prove the
// route-mounting end-to-end. Together they pin both the "feature works
// when --base-url is set" and "no-op when it isn't" contracts.

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttp from "node:http";
import { HttpServer, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import {
  joinBasePath,
  normalizeBasePath,
  prefixedRouteLayer,
} from "../../src/ru-fork/basePath/basePath.ts";
import {
  rewriteIndexHtmlForBasePath,
  rewriteWebmanifestForBasePath,
} from "../../src/ru-fork/basePath/htmlRewrite.ts";
import { ServerConfig, type ServerConfigShape } from "../../src/config.ts";

// ───────────────────────────────────────────────── normalizeBasePath
describe("normalizeBasePath", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    ["   ", ""],
    ["/", ""],
    ["//", ""],
    ["/foo", "/foo"],
    ["/foo/", "/foo"],
    ["/foo/bar//", "/foo/bar"],
    ["foo/bar", "/foo/bar"],
    ["/services/user001/etc/my-app", "/services/user001/etc/my-app"],
    ["https://example.com/services/u001/my-app", "/services/u001/my-app"],
    ["https://example.com/services/u001/my-app/", "/services/u001/my-app"],
    ["http://example.com", ""],
    ["https://example.com/", ""],
    ["not::a::valid::url:/foo", "/not::a::valid::url:/foo"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

// ───────────────────────────────────────────────── joinBasePath
describe("joinBasePath", () => {
  it("identity when basePath is empty", () => {
    expect(joinBasePath("", "/health")).toBe("/health");
    expect(joinBasePath("", "*")).toBe("*");
    expect(joinBasePath("", "")).toBe("");
  });

  it("returns basePath when route is '/' or empty", () => {
    expect(joinBasePath("/foo", "/")).toBe("/foo");
    expect(joinBasePath("/foo", "")).toBe("/foo");
  });

  it("concatenates a leading-slash route", () => {
    expect(joinBasePath("/foo", "/health")).toBe("/foo/health");
    expect(joinBasePath("/foo/bar", "/api/auth/session")).toBe("/foo/bar/api/auth/session");
  });

  it("inserts a slash when route lacks a leading slash", () => {
    expect(joinBasePath("/foo", "health")).toBe("/foo/health");
    expect(joinBasePath("/foo", "*")).toBe("/foo/*");
  });
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

// ───────────────────────────────────────────────── rewriteIndexHtmlForBasePath
describe("rewriteIndexHtmlForBasePath", () => {
  it("injects the runtime script with empty basePath without touching attrs", () => {
    const html =
      '<!doctype html><html><head><title>x</title></head><body><img src="/foo.png"></body></html>';
    const out = decode(rewriteIndexHtmlForBasePath(encode(html), ""));
    expect(out).toContain('window.__RU_FORK_RUNTIME__=Object.freeze({basePath:""})');
    // absolute paths NOT prefixed when basePath is empty
    expect(out).toContain('src="/foo.png"');
  });

  it("rewrites absolute href/src/srcset and injects basePath", () => {
    const html =
      '<!doctype html><html><head><link href="/icons/x.png"><script src="/assets/a.js"></script></head><body><img srcset="/img.png"></body></html>';
    const out = decode(rewriteIndexHtmlForBasePath(encode(html), "/my-app"));
    expect(out).toContain('window.__RU_FORK_RUNTIME__=Object.freeze({basePath:"/my-app"})');
    expect(out).toContain('href="/my-app/icons/x.png"');
    expect(out).toContain('src="/my-app/assets/a.js"');
    expect(out).toContain('srcset="/my-app/img.png"');
  });

  it("never double-prefixes URLs already under basePath", () => {
    const html = '<head></head><img src="/my-app/already.png">';
    const out = decode(rewriteIndexHtmlForBasePath(encode(html), "/my-app"));
    expect(out).toContain('src="/my-app/already.png"');
    expect(out).not.toContain("/my-app/my-app/");
  });

  it("leaves protocol-relative URLs (//) and absolute URLs (http://) alone", () => {
    const html =
      '<head></head><link href="//cdn.example.com/x.css"><a href="https://example.com/y">y</a>';
    const out = decode(rewriteIndexHtmlForBasePath(encode(html), "/my-app"));
    expect(out).toContain('href="//cdn.example.com/x.css"');
    expect(out).toContain('href="https://example.com/y"');
  });

  it("injects the script tag immediately after <head>", () => {
    const html = "<head><title>t</title></head>";
    const out = decode(rewriteIndexHtmlForBasePath(encode(html), "/p"));
    expect(out.indexOf("<script>window.__RU_FORK_RUNTIME__")).toBe("<head>".length);
  });
});

// ───────────────────────────────────────────────── rewriteWebmanifestForBasePath
describe("rewriteWebmanifestForBasePath", () => {
  it("returns bytes untouched when basePath is empty", () => {
    const json = '{"id":"/","start_url":"/","scope":"/","icons":[{"src":"/x.png"}]}';
    const out = rewriteWebmanifestForBasePath(encode(json), "");
    expect(decode(out)).toBe(json);
  });

  it("rewrites id, start_url, scope, and icon src when basePath is set (preserving original whitespace)", () => {
    // No-space variant: regex preserves the (empty) gap between : and ".
    const noSpace = '{"id":"/","start_url":"/","scope":"/","icons":[{"src":"/x.png"}]}';
    const noSpaceOut = decode(rewriteWebmanifestForBasePath(encode(noSpace), "/my-app"));
    expect(noSpaceOut).toContain('"id":"/my-app/"');
    expect(noSpaceOut).toContain('"start_url":"/my-app/"');
    expect(noSpaceOut).toContain('"scope":"/my-app/"');
    expect(noSpaceOut).toContain('"src":"/my-app/x.png"');

    // Spaced variant: regex preserves the single space between : and ".
    const spaced = '{ "id": "/", "start_url": "/", "scope": "/" }';
    const spacedOut = decode(rewriteWebmanifestForBasePath(encode(spaced), "/my-app"));
    expect(spacedOut).toContain('"id": "/my-app/"');
    expect(spacedOut).toContain('"start_url": "/my-app/"');
    expect(spacedOut).toContain('"scope": "/my-app/"');
  });

  it("does not double-prefix values already under basePath", () => {
    const json = '{"id":"/my-app/","start_url":"/my-app/","scope":"/my-app/"}';
    const out = decode(rewriteWebmanifestForBasePath(encode(json), "/my-app"));
    expect(out).toBe(json);
  });
});

// ───────────────────────────────────────────────── prefixedRouteLayer (integration)
//
// Mounts a single `/ping` route via prefixedRouteLayer, spins up a real
// NodeHttpServer on an ephemeral port, and checks that the route is
// reachable under <basePath>/ping but NOT under /ping. Then repeats
// with basePath="" to prove the no-prefix path is unchanged.

const makeServerConfig = (basePath: string): ServerConfigShape =>
  ({
    basePath,
    // everything below is irrelevant to the prefixedRouteLayer test;
    // the cast keeps us free of the unrelated derived-paths fixture
    // bloat (this matches the `as never` pattern used elsewhere in
    // tests for ServerConfig that don't exercise the heavy fields).
  }) as never;

const PING_BODY = "pong";

const pingRoute = prefixedRouteLayer(
  "GET",
  "/ping",
  Effect.succeed(HttpServerResponse.text(PING_BODY, { status: 200 })),
);

const makeAppLayer = (basePath: string) =>
  HttpRouter.serve(pingRoute, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfig(basePath))),
  );

// Builds the app layer into a scoped Context, extracts the listening
// HttpServer, runs the body, then closes the scope (which tears the
// server down). Using `Layer.build` + `Effect.scoped` here because this
// Effect version doesn't export `Layer.scopedDiscard`.
const runWithServer = <A, E>(
  basePath: string,
  body: (origin: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(makeAppLayer(basePath));
      const server = Context.get(ctx, HttpServer.HttpServer);
      const address = server.address;
      const port =
        typeof address === "object" && address !== null && "port" in address
          ? (address.port as number)
          : 0;
      const origin = `http://127.0.0.1:${port}`;
      return yield* body(origin);
    }),
  ) as never;

describe("prefixedRouteLayer integration", () => {
  it.effect("with basePath set: route reachable under prefix, 404 outside", () =>
    Effect.gen(function* () {
      const responses = yield* runWithServer("/my-app", (origin) =>
        Effect.tryPromise(async () => {
          const inside = await fetch(`${origin}/my-app/ping`);
          const insideBody = await inside.text();
          const outside = await fetch(`${origin}/ping`);
          return {
            insideStatus: inside.status,
            insideBody,
            outsideStatus: outside.status,
          };
        }),
      );
      expect(responses.insideStatus).toBe(200);
      expect(responses.insideBody).toBe(PING_BODY);
      expect(responses.outsideStatus).toBe(404);
    }),
  );

  it.effect("with basePath empty: route reachable at root (no regression)", () =>
    Effect.gen(function* () {
      const responses = yield* runWithServer("", (origin) =>
        Effect.tryPromise(async () => {
          const res = await fetch(`${origin}/ping`);
          return { status: res.status, body: await res.text() };
        }),
      );
      expect(responses.status).toBe(200);
      expect(responses.body).toBe(PING_BODY);
    }),
  );
});
