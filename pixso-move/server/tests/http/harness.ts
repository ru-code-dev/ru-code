import { Processor } from "@pixso-move/processor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { corsLayer } from "../../src/http/cors.ts";
import { routesLayer } from "../../src/http/routes.ts";
import { SqlitePersistenceMemory } from "../../src/persistence/sqlite.ts";
import { NodeStore } from "../../src/services/nodeStore.ts";
import { NodeStoreLive } from "../../src/services/nodeStoreLive.ts";
import { ResultStoreLive } from "../../src/services/resultStoreLive.ts";

const noopProcessor = Layer.succeed(Processor, {
  start: Effect.void,
  notify: Effect.void,
  stop: Effect.void,
  runTickOnce: Effect.void,
});

// A NodeStore whose reads die — used to exercise the route catch-all (500).
export const brokenNodeStore = Layer.succeed(NodeStore, {
  insert: () => Effect.die("boom"),
  listSummaries: () => Effect.die("boom"),
  getById: () => Effect.die("boom"),
  listNodeIds: () => Effect.die("boom"),
  getForProcessing: () => Effect.die("boom"),
});

// Build an in-process web handler over a fresh in-memory DB. Services are
// provideMerge'd so they remain in the runtime context the handlers resolve from.
export const makeHandler = (
  nodeStoreLayer: Layer.Layer<NodeStore, never, SqlClient.SqlClient> = NodeStoreLive,
) => {
  const services = Layer.mergeAll(nodeStoreLayer, ResultStoreLive, noopProcessor).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const app = Layer.mergeAll(routesLayer, corsLayer).pipe(Layer.provideMerge(services));
  return HttpRouter.toWebHandler(app);
};

export const jsonRequest = (method: string, path: string, key?: string, body?: unknown): Request =>
  new Request(`http://test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "x-designer-id": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
