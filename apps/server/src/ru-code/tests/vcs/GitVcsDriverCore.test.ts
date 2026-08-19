// @effect-diagnostics nodeBuiltinImport:off
// ru-code: fork seams over GitVcsDriverCore, proven on REAL git repos:
//   1. raw UTF-8 pathnames — `executeRaw` prepends `-c core.quotePath=false`
//      (rawUtf8Paths.ts), so non-ASCII names (`привет.md`) reach every parser
//      and the UI as-is instead of octal-escaped `"\320\277..."`;
//   2. unborn HEAD — `statusDetailsRemote` on a freshly-initialized repo (zero
//      commits) is a NORMAL state, not a GitCommandError; the status broadcaster
//      used to error-loop on every `git init`. Upstream fixed this too (#5944) and
//      its fix is what runs now — these cases guard the behaviour, not our module.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";

import { ServerConfig } from "../../../config.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-git-core-seams-" })),
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

function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-git-core-"));
  tempDirs.push(dir);
  return dir;
}

function initRepository(cwd: string): void {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
}

function makeRepositoryWithCyrillicFile(): string {
  const cwd = makeTempDir();
  initRepository(cwd);
  NodeFS.writeFileSync(NodePath.join(cwd, CYRILLIC_FILE), "строка 1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

describe("raw UTF-8 pathnames (core.quotePath seam)", () => {
  it.effect("review diff preview carries the Cyrillic path raw, never octal-escaped", () =>
    Effect.gen(function* () {
      const cwd = makeRepositoryWithCyrillicFile();
      NodeFS.writeFileSync(NodePath.join(cwd, CYRILLIC_FILE), "строка 2\n", "utf8");

      const git = yield* GitVcsDriver.GitVcsDriver;
      const preview = yield* git.getReviewDiffPreview({ cwd });
      const workingTree = preview.sources.find((source) => source.kind === "working-tree");
      assert.isDefined(workingTree);
      assert.include(workingTree!.diff, `a/${CYRILLIC_FILE}`);
      assert.notInclude(workingTree!.diff, "\\320");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("untracked Cyrillic files appear raw in the review preview too", () =>
    Effect.gen(function* () {
      const cwd = makeRepositoryWithCyrillicFile();
      NodeFS.writeFileSync(NodePath.join(cwd, "новый файл.md"), "черновик\n", "utf8");

      const git = yield* GitVcsDriver.GitVcsDriver;
      const preview = yield* git.getReviewDiffPreview({ cwd });
      const workingTree = preview.sources.find((source) => source.kind === "working-tree");
      assert.isDefined(workingTree);
      assert.include(workingTree!.diff, "новый файл.md");
      assert.notInclude(workingTree!.diff, "\\320");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("status details list the Cyrillic path raw in working-tree files", () =>
    Effect.gen(function* () {
      const cwd = makeRepositoryWithCyrillicFile();
      NodeFS.writeFileSync(NodePath.join(cwd, CYRILLIC_FILE), "строка 2\n", "utf8");

      const git = yield* GitVcsDriver.GitVcsDriver;
      const details = yield* git.statusDetailsLocal(cwd);
      assert.strictEqual(details.isRepo, true);
      const filePaths = details.workingTree.files.map((file) => file.path);
      assert.include(filePaths, CYRILLIC_FILE);
      for (const filePath of filePaths) {
        assert.notInclude(filePath, "\\320");
        assert.notInclude(filePath, '"');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("unborn HEAD (freshly-initialized repo seam)", () => {
  it.effect("statusDetailsRemote on a zero-commit repo is a normal state, not an error", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir();
      initRepository(cwd);

      const git = yield* GitVcsDriver.GitVcsDriver;
      const details = yield* git.statusDetailsRemote(cwd);
      assert.strictEqual(details.isRepo, true);
      assert.strictEqual(details.branch, "main");
      assert.strictEqual(details.hasUpstream, false);
      assert.strictEqual(details.aheadCount, 0);
      assert.strictEqual(details.behindCount, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("control: a repo WITH commits keeps the original remote-status behavior", () =>
    Effect.gen(function* () {
      const cwd = makeRepositoryWithCyrillicFile();

      const git = yield* GitVcsDriver.GitVcsDriver;
      const details = yield* git.statusDetailsRemote(cwd);
      assert.strictEqual(details.isRepo, true);
      assert.strictEqual(details.branch, "main");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("control: a non-repository directory still reports isRepo false", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir();

      const git = yield* GitVcsDriver.GitVcsDriver;
      const details = yield* git.statusDetailsRemote(cwd);
      assert.strictEqual(details.isRepo, false);
    }).pipe(Effect.provide(TestLayer)),
  );
});
