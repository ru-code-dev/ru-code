import { IngestError, NodeId, NodeNotFoundError } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";

import { NodeStore } from "../services/nodeStore.ts";
import { requireDesignerId } from "./auth.ts";
import { queryParam } from "./query.ts";
import { respondJson } from "./respond.ts";
import { route } from "./route.ts";

const decodeNodeId = Schema.decodeUnknownEffect(NodeId);

// GET /nodes — lightweight summaries for the authenticated designer.
export const listNodesRoute = route(
  "GET",
  "/nodes",
  Effect.gen(function* () {
    const designerId = yield* requireDesignerId;
    const summaries = yield* (yield* NodeStore).listSummaries(designerId);
    return respondJson(summaries, 200);
  }),
);

// GET /node?id=… — full record, scoped to the designer's key (404 otherwise).
export const getNodeRoute = route(
  "GET",
  "/node",
  Effect.gen(function* () {
    const designerId = yield* requireDesignerId;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const nodeId = yield* decodeNodeId(queryParam(request, "id")).pipe(
      Effect.mapError(() => new IngestError({ message: "Missing or invalid id.", status: 400 })),
    );
    const record = yield* (yield* NodeStore).getById(designerId, nodeId);
    if (record === undefined) {
      return yield* new NodeNotFoundError({ message: "Node not found.", status: 404 });
    }
    return respondJson(record, 200);
  }),
);
