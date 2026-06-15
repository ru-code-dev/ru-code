import { AuthError, IngestError, IngestRequest } from "@pixso-move/contracts";
import { Processor } from "@pixso-move/processor";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";

import { NodeStore } from "../services/nodeStore.ts";
import { requireDesignerId } from "./auth.ts";
import { respondJson } from "./respond.ts";
import { route } from "./route.ts";

// POST /ingest — validate, store the node, nudge the processor, return { nodeId }.
export const ingestRoute = route(
  "POST",
  "/ingest",
  Effect.gen(function* () {
    const designerId = yield* requireDesignerId;
    const body = yield* HttpServerRequest.schemaBodyJson(IngestRequest).pipe(
      Effect.mapError(() => new IngestError({ message: "Invalid ingest payload.", status: 400 })),
    );
    if (body.designerId !== designerId) {
      return yield* new AuthError({
        message: "Designer key does not match the payload.",
        status: 401,
      });
    }
    const nodes = yield* NodeStore;
    const { nodeId } = yield* nodes.insert({
      designerId,
      rootName: body.rootName,
      nodesJson: body.nodesJson,
      preview: body.preview,
    });
    // Fire-and-forget pickup. `notify` is non-blocking; even so, contain any failure here so
    // a processor hiccup can never turn a stored node into a failed HTTP response.
    yield* (yield* Processor).notify.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("ingest notify failed", { nodeId, cause: Cause.pretty(cause) }),
      ),
    );
    yield* Effect.logDebug("ingest stored", { nodeId, designerId });
    return respondJson({ nodeId }, 200);
  }),
);
