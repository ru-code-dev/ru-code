import { IngestError, NodeId, NodeNotFoundError } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";

import { NodeStore } from "../services/nodeStore.ts";
import { ResultStore } from "../services/resultStore.ts";
import { requireDesignerId } from "./auth.ts";
import { queryParam } from "./query.ts";
import { respondJson } from "./respond.ts";
import { route } from "./route.ts";

const decodeNodeId = Schema.decodeUnknownEffect(NodeId);

// GET /processing-data?nodeId=… — all result rows (every tag/status) for a node.
export const processingDataRoute = route(
  "GET",
  "/processing-data",
  Effect.gen(function* () {
    const designerId = yield* requireDesignerId;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const nodeId = yield* decodeNodeId(queryParam(request, "nodeId")).pipe(
      Effect.mapError(
        () => new IngestError({ message: "Missing or invalid nodeId.", status: 400 }),
      ),
    );
    const record = yield* (yield* NodeStore).getById(designerId, nodeId);
    if (record === undefined) {
      return yield* new NodeNotFoundError({ message: "Node not found.", status: 404 });
    }
    const results = yield* (yield* ResultStore).listByNode(designerId, nodeId);
    return respondJson(results, 200);
  }),
);
