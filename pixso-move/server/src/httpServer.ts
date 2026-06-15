import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";

// The Node HTTP listener, bound to the configured host/port. Mirrors
// apps/server/src/server.ts:100-112 (dynamic import to keep it node-only).
export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, { host: config.host, port: config.port });
  }),
);
