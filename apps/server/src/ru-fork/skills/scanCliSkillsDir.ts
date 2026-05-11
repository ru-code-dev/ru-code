// ru-fork: pure filesystem scan of one skills root.
//
// Given an absolute path like `~/$CLI_FOLDER/skills` or
// `<cwd>/$CLI_FOLDER/skills`, returns a `ServerProviderSkill[]` by
// reading each immediate subdir for a `SKILL.md` and parsing its
// frontmatter. Missing root → empty. Per-skill errors are logged +
// skipped so one bad SKILL.md cannot poison the whole result.

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "./parseSkillFrontmatter.ts";
import { SKILL_MANIFEST } from "./constants.ts";

export const scanCliSkillsDir = (
  root: string,
  scope: string,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }

    const entries = yield* fs
      .readDirectory(root)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("[ru-fork-skills] readDirectory failed", { root, cause }).pipe(
            Effect.as<ReadonlyArray<string>>([]),
          ),
        ),
      );

    const skills = yield* Effect.forEach(
      entries,
      (entry) => readOneSkill(fs, path, root, entry, scope),
      { concurrency: 8 },
    );

    return skills.filter((s): s is ServerProviderSkill => s !== null);
  });

const readOneSkill = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  entry: string,
  scope: string,
): Effect.Effect<ServerProviderSkill | null> =>
  Effect.gen(function* () {
    const skillDir = path.join(root, entry);
    const stat = yield* fs.stat(skillDir).pipe(Effect.orElseSucceed(() => null));
    if (stat === null || stat.type !== "Directory") {
      return null;
    }
    const manifestPath = path.join(skillDir, SKILL_MANIFEST);
    const manifestExists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!manifestExists) {
      return null;
    }
    const source = yield* fs.readFileString(manifestPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("[ru-fork-skills] read SKILL.md failed", {
          manifestPath,
          cause,
        }).pipe(Effect.as<string | null>(null)),
      ),
    );
    if (source === null) {
      return null;
    }
    const meta = parseSkillFrontmatter(source);
    const name = meta.name ?? entry;
    const skill: ServerProviderSkill = {
      name,
      path: skillDir,
      scope,
      enabled: true,
      ...(meta.description ? { description: meta.description } : {}),
    };
    return skill;
  });
