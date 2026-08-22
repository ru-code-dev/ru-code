// ru-code: the WS transport's tolerance for a slow-serving server — the §5 kill mechanism.
//
// Field defect (production-error.md §5): when the server cannot deliver a thread
// snapshot quickly enough, the client's RPC pinger declares the socket dead: the pinger
// sends a Ping every 5 s and fails the socket with SocketError("ping timeout") if no
// Pong was processed by the next tick (effect RpcClient makePinger). WS frames are
// ordered, so a Pong queued behind a giant snapshot frame — or a server whose only
// event loop is busy inside a synchronous decode/stringify — misses the window. The
// client then reconnects (retry capped at 5 s) and repeats the identical subscribe:
// the permanent "no connection every 5-10 s" loop.
//
// This suite runs the REAL RpcServer websocket transport (with the production egress
// serialization) against the REAL RpcClient pinger over real sockets:
//
//   1. a size probe: a giant first stream frame served at full speed — measures how
//      big a frame this machine survives;
//   2. the mechanism pin: a proxy withholds server→client bytes for longer than the
//      pong window — byte-for-byte what a blocked server event loop looks like on the
//      wire. CONTRACT (Fix S4 was DROPPED by decision — boot-performance.md): a server
//      that emits NOTHING for a full pong window IS declared dead at ~4× the ping
//      interval (beta.103 pinger: 3 consecutive missed pongs, RpcClient.js makePinger
//      `missedPongs >= 3`). With S1+S2+S3 in place that kill is cheap and convergent
//      (the resubscribe carries the advanced cursor, backoff is capped, catch-up is
//      bounded), so the fast verdict is the desired behavior — this test ASSERTS the
//      kill and its timing. The giant-single-frame leg is phase-2 pagination (pin L1).
//      // ru-code: re-pinned for the beta.78→beta.103 pinger contract change — the
//      // effect upgrade our base absorbed independently of this patch series moved the
//      // silence-kill threshold from 1 missed pong (~2×) to 3 (~4×); see the dispatch
//      // in WORKFLOW/briefs/12-porter.md, 2026-08-16.
//
// Wall-clock time and raw timers are deliberate here (the pinger and the stall are
// real-time; TestClock.withLive keeps them real):
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalTimers:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { layerLocalizedJsonRpcSerialization } from "../../localization/wireEgress.ts";

// The window the effect RpcClient pinger allows between a Ping and its Pong before it
// fails the socket (hardcoded 5 s in makePinger; documented here, asserted by test 2).
const PONG_WINDOW_MS = 5_000;

const SnapshotLikeRpc = Rpc.make("test.subscribeSnapshotLike", {
  payload: Schema.Struct({ bodyBytes: Schema.Number }),
  success: Schema.Struct({ seq: Schema.Number, body: Schema.String }),
  stream: true,
});

const TestRpcGroup = RpcGroup.make(SnapshotLikeRpc);

// Mirrors the production shape: the subscription emits one big snapshot-like frame,
// then stays open like a live event stream.
const handlersLayer = TestRpcGroup.toLayer(
  Effect.succeed({
    "test.subscribeSnapshotLike": (input: { readonly bodyBytes: number }) =>
      Stream.concat(Stream.make({ seq: 0, body: "x".repeat(input.bodyBytes) }), Stream.never),
  }),
);

// Same per-request construction as ws.ts's websocketRpcRouteLayer, same egress
// serialization layer the production socket uses.
const wsRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const handler = yield* RpcServer.toHttpEffectWebsocket(TestRpcGroup, {
      disableTracing: true,
    }).pipe(
      Effect.provide(handlersLayer.pipe(Layer.provideMerge(layerLocalizedJsonRpcSerialization))),
    );
    return yield* handler;
  }),
);

const servedLayer = HttpRouter.serve(wsRouteLayer, {
  disableListenLog: true,
  disableLogger: true,
});

const getWsServerUrl = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;
  return `ws://127.0.0.1:${address.port}/ws`;
});

// Client protocol: the REAL RpcClient socket protocol — including its pinger.
const clientProtocolLayer = (wsUrl: string) => {
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, protocols) as unknown as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeTestClient = RpcClient.make(TestRpcGroup);

type TestClient =
  typeof makeTestClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withTestClient = <A, E, R>(
  wsUrl: string,
  f: (client: TestClient) => Effect.Effect<A, E, R>,
) => makeTestClient.pipe(Effect.flatMap(f), Effect.provide(clientProtocolLayer(wsUrl)));

interface StallProxy {
  readonly url: string;
  readonly close: () => void;
}

/**
 * A transparent WS proxy that, once the first RPC Request passes through, withholds
 * ALL server→client frames for `stallMs`. On the wire this is indistinguishable from
 * a server whose event loop is pinned by synchronous work (schema decode, stringify
 * of a giant snapshot, a tokened egress triple pass): requests and pings still ARRIVE
 * at the server, but nothing — data or Pong — comes back until the stall ends.
 */
const startStallProxy = (upstreamUrl: string, stallMs: number): Promise<StallProxy> =>
  new Promise((resolve) => {
    const proxyServer = new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
    proxyServer.on("connection", (clientConn) => {
      const upstream = new NodeSocket.NodeWS.WebSocket(upstreamUrl);
      const pendingToUpstream: Array<{ data: Buffer; binary: boolean }> = [];
      const withheld: Array<{ data: Buffer; binary: boolean }> = [];
      let upstreamOpen = false;
      let stallUntil = 0;
      const flushWithheld = () => {
        stallUntil = 0;
        for (const frame of withheld) clientConn.send(frame.data, { binary: frame.binary });
        withheld.length = 0;
      };
      upstream.on("open", () => {
        upstreamOpen = true;
        for (const frame of pendingToUpstream) upstream.send(frame.data, { binary: frame.binary });
        pendingToUpstream.length = 0;
      });
      clientConn.on("message", (data, isBinary) => {
        const frame = { data: data as Buffer, binary: isBinary };
        if (stallMs > 0 && !isBinary && String(frame.data).includes('"Request"')) {
          stallUntil = Date.now() + stallMs;
          setTimeout(flushWithheld, stallMs);
        }
        if (upstreamOpen) upstream.send(frame.data, { binary: frame.binary });
        else pendingToUpstream.push(frame);
      });
      upstream.on("message", (data, isBinary) => {
        if (Date.now() < stallUntil) {
          withheld.push({ data: data as Buffer, binary: isBinary });
          return;
        }
        clientConn.send(data as Buffer, { binary: isBinary });
      });
      clientConn.on("close", () => upstream.close());
      upstream.on("close", () => clientConn.close());
    });
    proxyServer.on("listening", () => {
      const address = proxyServer.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${address.port}/ws`,
        close: () => proxyServer.close(),
      });
    });
  });

// TestClock.withLive is REQUIRED: the pinger's 5 s cadence and the proxy's stall are
// wall-clock; under the default TestClock the pinger never fires and test 2 would pass
// for the wrong reason.
it.effect(
  "size probe: a giant first frame served at full speed survives the pinger on this machine",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(servedLayer);
      const wsUrl = yield* getWsServerUrl;

      const bodyBytes = 64 * 1024 * 1024;
      const startedAt = Date.now();
      const items = yield* withTestClient(wsUrl, (client) =>
        client["test.subscribeSnapshotLike"]({ bodyBytes }).pipe(Stream.take(1), Stream.runCollect),
      ).pipe(Effect.scoped, Effect.timeout("30 seconds"));
      const elapsedMs = Date.now() - startedAt;

      assert.equal(items.length, 1);
      assert.equal(items[0]!.body.length, bodyBytes);
      // If serving 64 MiB through the real transport ever comes within reach of the
      // pong window on the reference machine, the loop threshold has moved into
      // realistic territory and the snapshot path needs flow control.
      assert.isBelow(
        elapsedMs,
        PONG_WINDOW_MS,
        `serving a 64 MiB frame took ${elapsedMs} ms — inside the pong window's reach`,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  { timeout: 60_000 },
);

it.effect(
  "a fully-silent server IS declared dead at ~4× the ping interval (S4 dropped: asserted contract)",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(servedLayer);
      const upstreamUrl = yield* getWsServerUrl;
      // Stall comfortably past three full ping cycles (ping at ~5 s, verdict at ~20 s —
      // beta.103's makePinger requires 3 consecutive missed pongs, not 1): the kill must
      // land while the wire is still silent, proving the PINGER ended the connection —
      // not the stall running out.
      const stallMs = PONG_WINDOW_MS * 6;
      const proxy = yield* Effect.acquireRelease(
        Effect.promise(() => startStallProxy(upstreamUrl, stallMs)),
        (running) => Effect.sync(() => running.close()),
      );

      // RATIFIED CONTRACT (boot-performance.md — S4 dropped): a server that emits
      // NOTHING for a full pong window is unrecoverable-in-place; the pinger fails
      // the socket with SocketError("ping timeout") at ~4× the ping interval
      // (beta.103 pinger: 3 consecutive missed pongs, RpcClient.js makePinger
      // `missedPongs >= 3`). With S1 (bounded catch-up), S2 (live cursor) and S3
      // (capped backoff) the subsequent reconnect is cheap and convergent, so the
      // fast verdict is the DESIRED behavior. This pins the kill and its timing window.
      const startedAt = Date.now();
      const outcome = yield* withTestClient(proxy.url, (client) =>
        client["test.subscribeSnapshotLike"]({ bodyBytes: 1024 }).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      ).pipe(Effect.scoped, Effect.timeout("40 seconds"), Effect.exit);
      const elapsedMs = Date.now() - startedAt;

      assert.isTrue(
        outcome._tag === "Failure",
        "the silence-kill contract: the subscribe must fail, not hang",
      );
      // Name the killer. makePinger fails the socket with
      // SocketOpenError({ kind: "Timeout", cause: Error("ping timeout") }) — the
      // TOP-LEVEL message renders as `timeout waiting for "open"` (SocketOpenError's
      // kind-based message), so the pinger's verdict must be read from reason.cause.
      const failure = outcome._tag === "Failure" ? Cause.squash(outcome.cause) : undefined;
      const failureReasonCause =
        typeof failure === "object" && failure !== null && "reason" in failure
          ? String((failure as { readonly reason: { readonly cause?: unknown } }).reason.cause)
          : String(failure);
      assert.include(
        failureReasonCause,
        "ping timeout",
        `expected the pinger's verdict, got: ${failureReasonCause}`,
      );
      // Verdict timing: after at least three full pong windows (beta.103's makePinger
      // requires 3 consecutive missed pongs before it fails the socket), well before
      // the stall (30 s) or the outer timeout (40 s) would have ended things another
      // way — proving the PINGER ended it, not the stall or the test timeout.
      assert.isAtLeast(elapsedMs, PONG_WINDOW_MS * 3);
      assert.isBelow(elapsedMs, stallMs);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  { timeout: 60_000 },
);
