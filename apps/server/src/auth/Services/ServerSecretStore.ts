import * as Data from "effect/Data";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class SecretStoreError extends Data.TaggedError("SecretStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  /**
   * Remove every stored secret whose name starts with `prefix` and is NOT in `keep`.
   * Used to GC orphaned MCP var secrets (sibling of the probe-cache `deleteKeysNotIn`).
   * A missing store directory / individual removal error is swallowed (best-effort GC).
   */
  // ru-fork: best-effort GC of orphaned secret files — never fails (a remove failure is logged, not
  // surfaced), so the error channel is `never`.
  readonly pruneByPrefix: (
    prefix: string,
    keep: ReadonlySet<string>,
  ) => Effect.Effect<void>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "@ru-code/ru-code/auth/Services/ServerSecretStore",
) {}
