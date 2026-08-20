// @effect-diagnostics nodeBuiltinImport:off
// ru-code: read-only view of the server's `server-runtime.json`. We deliberately
// re-declare a minimal decoder here (rather than importing the app's schema) so
// this package stays free of app-internal imports. `version: 1` is a stable
// on-disk contract; `pairingUrl` is our additive field (see the matching seam in
// apps/server/src/serverRuntimeState.ts).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";

export const DaemonRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
  // ru-code: the tokenized browser target the launcher prints (web mode only).
  pairingUrl: Schema.optional(Schema.String),
});
export type DaemonRuntimeState = typeof DaemonRuntimeState.Type;

const decodeRuntimeState = Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonRuntimeState));

/**
 * Read + decode the runtime-state file. Returns `None` when the file is absent,
 * empty, or unparseable — every failure mode collapses to "no known daemon" so
 * callers never have to branch on IO errors.
 */
export const readRuntimeState = (
  statePath: string,
): Effect.Effect<Option.Option<DaemonRuntimeState>> =>
  Effect.gen(function* () {
    const contents = yield* Effect.tryPromise(() => NodeFSP.readFile(statePath, "utf8")).pipe(
      Effect.orElseSucceed(() => ""),
    );
    const trimmed = contents.trim();
    if (trimmed.length === 0) {
      return Option.none();
    }
    return yield* decodeRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    );
  });
