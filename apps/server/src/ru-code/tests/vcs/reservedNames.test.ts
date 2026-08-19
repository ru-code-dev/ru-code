// @effect-diagnostics nodeBuiltinImport:off
// ru-code: Windows reserved-name excludes (reservedNames.ts seam). A stray
// `nul`/`con`/... file aborts the whole `git add -A` on Windows (exit 128,
// --ignore-errors does not rescue), killing checkpoint capture and commit
// staging. Pinned here:
//   - the pathspec construction (win32 vs everything else);
//   - the pathspec SEMANTICS against real git: with the win32 excludes passed
//     explicitly, a literal `nul` file (creatable on Linux) is skipped while
//     the rest of the tree stages;
//   - control: the reshaped `add -A -- .` staging path still stages normally
//     (on mac/Linux the excludes are empty — zero behavior change).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";

import { ServerConfig } from "../../../config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { windowsReservedExcludes, windowsReservedExcludesFor } from "../../vcs/reservedNames.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-reserved-names-" })),
  Layer.provideMerge(NodeServices.layer),
);

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

function makeRepository(): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-reserved-"));
  tempDirs.push(cwd);
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  return cwd;
}

describe("windowsReservedExcludesFor", () => {
  it("builds root + any-depth case-insensitive excludes for every reserved name on win32", () => {
    const excludes = windowsReservedExcludesFor("win32");
    expect(excludes).toEqual([
      ":(exclude,icase)con",
      ":(exclude,icase)**/con",
      ":(exclude,icase)prn",
      ":(exclude,icase)**/prn",
      ":(exclude,icase)aux",
      ":(exclude,icase)**/aux",
      ":(exclude,icase)nul",
      ":(exclude,icase)**/nul",
    ]);
  });

  it("is EMPTY off Windows — these are legitimate filenames on mac/Linux", () => {
    expect(windowsReservedExcludesFor("linux")).toEqual([]);
    expect(windowsReservedExcludesFor("darwin")).toEqual([]);
  });

  it.effect("the host-bound Effect respects the injected platform reference", () =>
    Effect.gen(function* () {
      const onWindows = yield* windowsReservedExcludes.pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      assert.lengthOf(onWindows, 8);
      const onLinux = yield* windowsReservedExcludes.pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      assert.lengthOf(onLinux, 0);
    }),
  );
});

describe("reserved-name exclusion semantics against real git", () => {
  it.effect("the win32 pathspecs skip a literal `nul` file while the rest of the tree stages", () =>
    Effect.gen(function* () {
      const cwd = makeRepository();
      NodeFS.writeFileSync(NodePath.join(cwd, "nul"), "junk\n", "utf8");
      NodeFS.mkdirSync(NodePath.join(cwd, "nested"));
      NodeFS.writeFileSync(NodePath.join(cwd, "nested", "NUL"), "junk\n", "utf8");
      NodeFS.writeFileSync(NodePath.join(cwd, "real.md"), "содержимое\n", "utf8");

      const git = yield* GitVcsDriver.GitVcsDriver;
      yield* git.execute({
        operation: "ru-code.reservedNames.addWithExcludes",
        cwd,
        args: ["add", "-A", "--", ".", ...windowsReservedExcludesFor("win32")],
      });
      const staged = yield* git.execute({
        operation: "ru-code.reservedNames.staged",
        cwd,
        args: ["diff", "--cached", "--name-only"],
      });
      const stagedPaths = staged.stdout.trim().split("\n").filter(Boolean);
      assert.include(stagedPaths, "real.md");
      assert.notInclude(stagedPaths, "nul");
      assert.notInclude(stagedPaths, "nested/NUL");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "control: prepareCommitContext (the reshaped addAll seam) still stages everything",
    () =>
      Effect.gen(function* () {
        const cwd = makeRepository();
        NodeFS.writeFileSync(NodePath.join(cwd, "первый.md"), "раз\n", "utf8");
        runGit(cwd, ["add", "."]);
        runGit(cwd, ["commit", "-m", "Initial"]);
        NodeFS.writeFileSync(NodePath.join(cwd, "второй.md"), "два\n", "utf8");

        const git = yield* GitVcsDriver.GitVcsDriver;
        const context = yield* git.prepareCommitContext(cwd);
        assert.isNotNull(context);
        assert.include(context!.stagedSummary, "второй.md");
      }).pipe(Effect.provide(TestLayer)),
  );
});
