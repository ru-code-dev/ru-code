// ru-fork: read `advanced.runtimeOutputDir` from the spawned CLI's settings.json
// (global `<cliConfigDir>/settings.json`, then workspace `<cwd>/<CLI_FOLDER>/settings.json`,
// workspace wins — qwen's merge order). Missing/invalid → undefined. This is the
// ONLY thing that moves transcripts off the default base (see paths.ts).
//
// Takes already-resolved `fs`/`path` VALUES (not service requirements) so the
// returned Effect has R = never and the transcript stream stays requirement-free.
//
// We parse the CLI's own settings.json (a foreign file with an unknown shape we
// only sample one field from), so a defensive JSON.parse is the right tool here
// rather than a full Effect Schema decode.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { CLI_FOLDER } from "../../config.ts";

/** Pure: extract `advanced.runtimeOutputDir` from a parsed settings object. */
export const pickRuntimeOutputDir = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const advanced = (raw as Record<string, unknown>)["advanced"];
  if (typeof advanced !== "object" || advanced === null) return undefined;
  const value = (advanced as Record<string, unknown>)["runtimeOutputDir"];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

/** Pure JSON parse that never throws (malformed → undefined). */
const parseJsonSafe = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const readJsonSafe = (fs: FileSystem.FileSystem, filePath: string): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    const text = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    return parseJsonSafe(text);
  });

export const readRuntimeOutputDirOverride = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cliConfigDir: string,
  cwd: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const globalRaw = yield* readJsonSafe(fs, path.join(cliConfigDir, "settings.json"));
    const workspaceRaw = yield* readJsonSafe(fs, path.join(cwd, CLI_FOLDER, "settings.json"));
    return pickRuntimeOutputDir(workspaceRaw) ?? pickRuntimeOutputDir(globalRaw);
  });
