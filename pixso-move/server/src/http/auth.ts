import { AuthError, DesignerId } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";

const decodeDesignerId = Schema.decodeUnknownEffect(DesignerId);

// Read and validate the `x-designer-id` header. Missing/blank/invalid → 401.
export const requireDesignerId = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = request.headers["x-designer-id"];
  return yield* decodeDesignerId(raw).pipe(
    Effect.mapError(() => new AuthError({ message: "Missing or invalid designer key.", status: 401 })),
  );
});
