// ru-fork: SkillScannerLive — thin wrapper over
// `../common/cachedFsScanner.ts`. The state machine, cache codec,
// hydrate/persist, and background warm-up all live in common — this
// file only wires the skill-specific bits (cache path, item schema,
// scan effects, scope tags) and renames the common result's `user`
// field back to `global` for the public Service contract.
//
// Public Service shape (`SkillScannerShape.getSkillsForCwd → { global, project }`)
// is unchanged from the pre-refactor version. The RPC + web client
// continue to see the same wire format.

import type { ServerProviderSkill } from "@t3tools/contracts";
import { ServerProviderSkill as ServerProviderSkillSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { makeCachedFsScanner, type ScanResult } from "../common/cachedFsScanner.ts";
import { cliProjectRoot, cliUserRoot } from "../common/cliRoots.ts";
import { SCOPE_PROJECT, SCOPE_USER } from "../common/constants.ts";

import { SKILLS_SUBDIR } from "./constants.ts";
import { scanCliSkillsDir } from "./scanCliSkillsDir.ts";
import {
  SkillScanner,
  type SkillScannerShape,
  type SkillsForCwdResult,
} from "./SkillScannerService.ts";

// The public SkillScannerShape names the user-level bucket `global`
// (predates cli-code's `user`/`project`/`builtin` terminology). The
// common core uses `user`; rename at this boundary only. Module-scope
// because it captures nothing from the factory closure.
const toResult = (r: ScanResult<ServerProviderSkill>): SkillsForCwdResult => ({
  global: r.user,
  project: r.project,
});

const makeScanner = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const core = yield* makeCachedFsScanner({
    cachePath: config.skillsCachePath,
    itemSchema: ServerProviderSkillSchema,
    scanUser: (now) =>
      Effect.gen(function* () {
        const root = yield* cliUserRoot(config.cliConfigDir, SKILLS_SUBDIR);
        const items = yield* scanCliSkillsDir(root, SCOPE_USER);
        return { items, scannedAt: now };
      }),
    scanProject: (cwd, now) =>
      Effect.gen(function* () {
        const root = yield* cliProjectRoot(cwd, SKILLS_SUBDIR);
        const items = yield* scanCliSkillsDir(root, SCOPE_PROJECT);
        return { items, scannedAt: now };
      }),
    logTag: "[ru-fork-skills]",
  });

  return {
    getSkillsForCwd: (cwd) => core.getForCwd(cwd).pipe(Effect.map(toResult)),
    refreshSkillsForCwd: (cwd) => core.refreshForCwd(cwd).pipe(Effect.map(toResult)),
  } satisfies SkillScannerShape;
});

export const SkillScannerLive = Layer.effect(SkillScanner, makeScanner);

// Re-export for callers that want the wire payload type without
// reaching into SkillScannerService.ts directly (mirrors the original).
export type { SkillsForCwdResult, ServerProviderSkill };
