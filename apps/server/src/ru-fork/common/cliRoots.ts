// ru-fork: generic CLI-root resolvers for `.qwen/<subdir>/` scanners.
//
// 1:1 logic port of skills/resolveSkillRoots.ts, parameterized over the
// subdir name so subagents (`agents/`) can reuse it.

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { CLI_FOLDER } from "../../config.ts";

// ru-fork: configDir is the resolver's CLI config dir ({home}/$CLI_DIR), passed
// straight through from ServerConfig.cliConfigDir — NOT derived from baseDir.
// In the bin split the CLI config lives in {home}/.qwen while our app root sits
// on the exec mount, so dirname(baseDir) would point at the wrong tree.
export const cliUserRoot = (
  configDir: string,
  subdir: string,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(configDir, subdir);
  });

export const cliProjectRoot = (
  cwd: string,
  subdir: string,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(cwd, CLI_FOLDER, subdir);
  });
