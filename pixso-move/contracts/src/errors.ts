import * as Schema from "effect/Schema";

// Domain errors as data. `status` is the HTTP status the server responds with.
export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  status: Schema.Int, // 401
}) {}

export class IngestError extends Schema.TaggedErrorClass<IngestError>()("IngestError", {
  message: Schema.String,
  status: Schema.Int, // 400 | 413
}) {}

export class NodeNotFoundError extends Schema.TaggedErrorClass<NodeNotFoundError>()(
  "NodeNotFoundError",
  {
    message: Schema.String,
    status: Schema.Int, // 404
  },
) {}
