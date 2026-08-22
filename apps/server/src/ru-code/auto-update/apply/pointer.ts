// ru-code: the version pointer — `<appRoot>/current.json`, the single source of "which version
// boots". The frozen wrapper (`<appRoot>/cli.js`, see ../wrapper/wrapperSource.ts) reads it on
// every launch; the install run writes it exactly once per update (the "flip"). Writes are
// tmp + atomic rename — a torn write can never exist, a reader sees the old or the new pointer,
// never garbage. Applying the same version twice is a structural no-op (same pointer bytes).

// @effect-diagnostics preferSchemaOverJson:off

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const POINTER_FILENAME = "current.json";
export const POINTER_SCHEMA = 1;

/** The on-disk pointer shape. `entry` is appRoot-relative (e.g. `versions/1.4.2/bin/cli.js`). */
export interface CurrentPointer {
  readonly schema: typeof POINTER_SCHEMA;
  readonly version: string;
  readonly entry: string;
}

export class PointerWriteError extends Data.TaggedError("PointerWriteError")<{
  readonly detail: string;
}> {}

const isValidPointer = (value: unknown): value is CurrentPointer => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["schema"] === POINTER_SCHEMA &&
    typeof record["version"] === "string" &&
    record["version"] !== "" &&
    typeof record["entry"] === "string" &&
    record["entry"] !== ""
  );
};

/** Read the pointer; `null` for missing/corrupt (the wrapper has its own fallback — we only report). */
export const readPointer = (
  appRoot: string,
): Effect.Effect<CurrentPointer | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(path.join(appRoot, POINTER_FILENAME))
      .pipe(Effect.orElseSucceed(() => null));
    if (raw === null) return null;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    return isValidPointer(parsed) ? parsed : null;
  });

/**
 * Atomically write the pointer: serialize → `current.json.tmp` → rename over `current.json`.
 * The rename is same-directory and therefore atomic on every filesystem we target.
 */
export const writePointer = (
  appRoot: string,
  pointer: CurrentPointer,
): Effect.Effect<void, PointerWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const finalPath = path.join(appRoot, POINTER_FILENAME);
    const tmpPath = `${finalPath}.tmp`;
    const body = `${JSON.stringify(pointer, null, 2)}\n`;
    yield* fs.writeFileString(tmpPath, body).pipe(
      Effect.andThen(fs.rename(tmpPath, finalPath)),
      Effect.mapError(
        (error) => new PointerWriteError({ detail: `pointer write failed: ${String(error)}` }),
      ),
    );
  });

/** The pointer a fresh install/release layout ships for a version. */
export const makePointer = (version: string, entryRelative: string): CurrentPointer => ({
  schema: POINTER_SCHEMA,
  version,
  entry: entryRelative,
});
