// ru-fork: SubagentScannerLive — thin wrapper over
// `../common/cachedFsScanner.ts`. State machine, hydrate/persist, and
// background warm-up live in common; this file wires the
// subagent-specific bits: cache path, item schema, scan effects, and the
// project==home dedup that has no skills analogue.

import type { ServerProviderSubagent } from "@t3tools/contracts";
import { ServerProviderSubagent as ServerProviderSubagentSchema } from "@t3tools/contracts";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { makeCachedFsScanner, type RootEntry, type ScanResult } from "../common/cachedFsScanner.ts";
import { cliProjectRoot, cliUserRoot } from "../common/cliRoots.ts";
import { SCOPE_PROJECT, SCOPE_USER } from "../common/constants.ts";

import { BUILTIN_SUBAGENTS } from "./builtinSubagents.ts";
import { AGENTS_SUBDIR } from "./constants.ts";
import { scanCliAgentsDir } from "./scanCliAgentsDir.ts";
import {
  SubagentScanner,
  type SubagentScannerShape,
  type SubagentsForCwdResult,
} from "./SubagentScannerService.ts";

const toResult = (r: ScanResult<ServerProviderSubagent>): SubagentsForCwdResult => ({
  builtin: BUILTIN_SUBAGENTS,
  user: r.user,
  project: r.project,
});

const makeScanner = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  // ru-fork: resolve FileSystem at layer creation and provide it (with Path) into each
  // method below, so the scan dependencies stay internal to the layer rather than leaking
  // onto the public service surface.
  const fs = yield* FileSystem.FileSystem;

  // Mirrors cli-code's SubagentManager: when `cwd === homedir`, project
  // scan would re-read the user agents dir and double-list every entry.
  // Skip in that case. Skills don't have this — keep the divergence here.
  const resolvedHome = path.resolve(homedir());

  const core = yield* makeCachedFsScanner({
    cachePath: config.subagentsCachePath,
    itemSchema: ServerProviderSubagentSchema,
    scanUser: (now) =>
      Effect.gen(function* () {
        const root = yield* cliUserRoot(config.cliConfigDir, AGENTS_SUBDIR);
        const items = yield* scanCliAgentsDir(root, SCOPE_USER);
        return { items, scannedAt: now };
      }),
    scanProject: (cwd, now) =>
      Effect.gen(function* () {
        if (path.resolve(cwd) === resolvedHome) {
          return { items: [], scannedAt: now } satisfies RootEntry<ServerProviderSubagent>;
        }
        const root = yield* cliProjectRoot(cwd, AGENTS_SUBDIR);
        const items = yield* scanCliAgentsDir(root, SCOPE_PROJECT);
        return { items, scannedAt: now };
      }),
    logTag: "[ru-fork-subagents]",
  });

  return {
    getSubagentsForCwd: (cwd) =>
      core.getForCwd(cwd).pipe(
        Effect.map(toResult),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    refreshSubagentsForCwd: (cwd) =>
      core.refreshForCwd(cwd).pipe(
        Effect.map(toResult),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
  } satisfies SubagentScannerShape;
});

export const SubagentScannerLive = Layer.effect(SubagentScanner, makeScanner);

export type { SubagentsForCwdResult, ServerProviderSubagent };
