import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { corsLayer } from "./http/cors.ts";
import { routesLayer } from "./http/routes.ts";
import { HttpServerLive } from "./httpServer.ts";
import { persistenceLive } from "./persistence/sqlite.ts";
import { ServerLoggerLive } from "./serverLogger.ts";
import { NodeStoreLive } from "./services/nodeStoreLive.ts";
import { ProcessorLive } from "./services/processorLive.ts";
import { ResultStoreLive } from "./services/resultStoreLive.ts";

// Routes + CORS middleware.
const appLayer = routesLayer.pipe(Layer.provide(corsLayer));

// Stores over the shared sqlite connection.
const storesLive = Layer.mergeAll(NodeStoreLive, ResultStoreLive).pipe(
  Layer.provideMerge(persistenceLive),
);

// The processor, built on the stores (provideMerge keeps NodeStore/ResultStore in the output
// context so the route handlers resolve them too). The AcpRunner it needs is provided from
// outside — the real qwen runner in bin.ts, a fake in tests.
const servicesLive = ProcessorLive.pipe(Layer.provideMerge(storesLive));

// The full server: routes served over the HTTP listener, with persistence, stores, the
// embedded processor, and the logger wired in. Still requires ServerConfig (bin.ts / tests)
// and AcpRunner (bin.ts real / tests fake).
export const makeServerLayer = HttpRouter.serve(appLayer).pipe(
  Layer.provideMerge(servicesLive),
  Layer.provide(HttpServerLive),
  Layer.provide(ServerLoggerLive),
  Layer.provide(NodeServices.layer),
);

export const runServer = Layer.launch(makeServerLayer);
