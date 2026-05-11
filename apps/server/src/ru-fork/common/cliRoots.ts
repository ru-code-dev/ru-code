// ru-fork: generic CLI-root resolvers for `.qwen/<subdir>/` scanners.
//
// 1:1 logic port of skills/resolveSkillRoots.ts, parameterized over the
// subdir name so subagents (`agents/`) can reuse it.

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { CLI_FOLDER } from "../../config.ts";

export const cliUserRoot = (
  baseDir: string,
  subdir: string,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(path.dirname(baseDir), CLI_FOLDER, subdir);
  });

export const cliProjectRoot = (
  cwd: string,
  subdir: string,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(cwd, CLI_FOLDER, subdir);
  });
