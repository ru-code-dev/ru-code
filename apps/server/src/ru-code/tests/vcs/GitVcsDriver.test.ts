// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the SECOND git-invocation funnel — `gitCommand` in GitVcsDriver.ts
// (used by the VcsDriver shape: checkpoint capture/diff and generic execute) —
// must also emit raw UTF-8 pathnames (rawUtf8Paths.ts seam). The checkpoint
// diff is the chat diff-chip's data source, so a Cyrillic filename must come
// through raw end-to-end: capture → checkpoint refs → diffCheckpoints patch.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";

import { CheckpointRef } from "@t3tools/contracts";

import { ServerConfig } from "../../../config.ts";
import { withRawUtf8Paths } from "../../vcs/rawUtf8Paths.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../../../vcs/VcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";

const TestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-git-vcs-seams-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const CYRILLIC_FILE = "привет.md";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeRepositoryWithCyrillicFile(): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-git-vcs-"));
  tempDirs.push(cwd);
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, CYRILLIC_FILE), "строка 1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

describe("withRawUtf8Paths", () => {
  it("prepends the quotePath override before the subcommand", () => {
    expect(withRawUtf8Paths(["status", "--porcelain=2"])).toEqual([
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=2",
    ]);
  });
});

describe("gitCommand funnel (VcsDriver shape) emits raw UTF-8 paths", () => {
  it.effect("checkpoint capture → diffCheckpoints patch carries the Cyrillic path raw", () =>
    Effect.gen(function* () {
      const cwd = makeRepositoryWithCyrillicFile();
      const vcs = yield* VcsDriver.VcsDriver;
      const checkpoints = vcs.checkpoints;
      if (checkpoints === undefined) {
        return yield* Effect.die(new Error("git VcsDriver must expose checkpoint ops"));
      }

      const fromRef = CheckpointRef.make("refs/t3/checkpoints/ru-code-test/0");
      const toRef = CheckpointRef.make("refs/t3/checkpoints/ru-code-test/1");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: fromRef });
      NodeFS.writeFileSync(NodePath.join(cwd, CYRILLIC_FILE), "строка 2\n", "utf8");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: toRef });

      const patch = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: fromRef,
        toCheckpointRef: toRef,
        ignoreWhitespace: false,
        fallbackFromToHead: false,
      });
      assert.include(patch, `a/${CYRILLIC_FILE}`);
      assert.notInclude(patch, "\\320");
    }).pipe(Effect.provide(TestLayer)),
  );
});
