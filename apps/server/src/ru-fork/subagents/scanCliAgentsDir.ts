// ru-fork: pure filesystem scan of one agents root.
//
// Diverges from skills' scanner: CLI's subagents are flat `.md` files at
// the root of `agents/`, not per-skill subdirectories with a manifest:
//   ~/<cli-dir>/agents/code-reviewer.md
//   <cwd>/<cli-dir>/agents/test-runner.md
// Filename (without `.md`) is the fallback name when frontmatter omits
// it, matching cli-code's SubagentManager behavior.

import type { ServerProviderSubagent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseSubagentFrontmatter } from "./parseSubagentFrontmatter.ts";

export const scanCliAgentsDir = (
  root: string,
  scope: string,
): Effect.Effect<ReadonlyArray<ServerProviderSubagent>, never, FileSystem.FileSystem | Path.Path> =>
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
          Effect.logWarning("[ru-fork-subagents] readDirectory failed", { root, cause }).pipe(
            Effect.as<ReadonlyArray<string>>([]),
          ),
        ),
      );

    const agents = yield* Effect.forEach(
      entries,
      (entry) => readOneAgent(fs, path, root, entry, scope),
      { concurrency: 8 },
    );

    return agents.filter((a): a is ServerProviderSubagent => a !== null);
  });

const readOneAgent = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  entry: string,
  scope: string,
): Effect.Effect<ServerProviderSubagent | null> =>
  Effect.gen(function* () {
    if (!entry.endsWith(".md")) {
      return null;
    }
    const filePath = path.join(root, entry);
    const stat = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (stat === null || stat.type !== "File") {
      return null;
    }
    const source = yield* fs.readFileString(filePath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("[ru-fork-subagents] read agent file failed", {
          filePath,
          cause,
        }).pipe(Effect.as<string | null>(null)),
      ),
    );
    if (source === null) {
      return null;
    }
    const meta = parseSubagentFrontmatter(source);
    const fallbackName = entry.slice(0, -".md".length);
    const name = meta.name ?? fallbackName;
    const agent: ServerProviderSubagent = {
      name,
      path: filePath,
      scope,
      enabled: true,
      ...(meta.description ? { description: meta.description } : {}),
      // cli-code treats `color: auto` as "no override" — drop it so the
      // web chip falls back to its themed default.
      ...(meta.color && meta.color !== "auto" ? { color: meta.color } : {}),
      ...(meta.tools && meta.tools.length > 0 ? { tools: meta.tools } : {}),
    };
    return agent;
  });
