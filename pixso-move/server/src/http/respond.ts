import type { AuthError, IngestError, NodeNotFoundError } from "@pixso-move/contracts";
import { HttpServerResponse } from "effect/unstable/http";

export type KnownError = AuthError | IngestError | NodeNotFoundError;

// The single JSON response + error-mapping helpers. CORS headers are added by
// the cors middleware (see ./cors.ts), so responses only set status + body.
export const respondJson = (body: unknown, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status });

export const respondError = (error: KnownError): HttpServerResponse.HttpServerResponse =>
  respondJson({ error: error.message }, error.status);
