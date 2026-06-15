import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpRouter, type HttpServerResponse } from "effect/unstable/http";

import { respondError, respondJson, type KnownError } from "./respond.ts";

type Method = "GET" | "POST";

const onKnown = (error: KnownError) => Effect.succeed(respondError(error));

// The single route wrapper: known errors → their JSON+status; any remaining
// defect → logged + 500. No handler can throw into the server (never crashes).
export const route = <R>(
  method: Method,
  path: HttpRouter.PathInput,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, KnownError, R>,
) =>
  HttpRouter.add(
    method,
    path,
    handler.pipe(
      Effect.catchTags({ AuthError: onKnown, IngestError: onKnown, NodeNotFoundError: onKnown }),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("route defect", { path, cause: Cause.pretty(cause) }),
          respondJson({ error: "Internal error." }, 500),
        ),
      ),
    ),
  );
