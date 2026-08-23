// @effect-diagnostics nodeBuiltinImport:off
// ru-code: OFF-path pin for the PR status lookup kill switch (@ru-code/branding
// PR_STATUS_LOOKUP_ENABLED, default OFF; apps/server/src/git/GitManager.ts's
// `lookupStatusPr`). This is a ZONE test (RULES 8.1 — the upstream port test
// apps/server/src/git/GitManager.test.ts only gets a marked vi.mock forcing the const
// back to true, restoring the premise its ~20 pre-existing PR-lookup tests were written
// under; it adds no new cases). This file imports the real, unmocked GitManager module —
// PR_STATUS_LOOKUP_ENABLED reads its real default (false) here — and duplicates the
// minimal slice of GitManager.test.ts's own fixture/spy idiom needed to drive
// `manager.status()` through a pushed branch: temp-repo git helpers and a fake
// GitHubCli whose every method is a call-recorder, so "the guard never let anything
// downstream run" is provable rather than assumed.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import { TextGenerationError, type GitCommandError } from "@t3tools/contracts";
import * as GitHubCli from "../../../sourceControl/GitHubCli.ts";
import * as GitHubSourceControlProvider from "../../../sourceControl/GitHubSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitManager from "../../../git/GitManager.ts";

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* git.execute({ operation: "prStatusLookupGate.test.runGit", cwd, args });
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t3code-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

/** Every method records its call and fails loudly — proof that nothing downstream of the
 * kill switch's guard is ever reached, rather than a fixture that would silently succeed
 * and mask a guard regression. */
function makeSpyGitHubCli(): { service: GitHubCli.GitHubCli["Service"]; calls: string[] } {
  const calls: string[] = [];
  const fail = (operation: string, cwd: string) => {
    calls.push(operation);
    return Effect.fail(
      new GitHubCli.GitHubCliCommandError({
        command: "gh",
        cwd,
        cause: new Error(
          `unexpected gh call (${operation}) — the PR status lookup kill switch should have short-circuited before any source-control provider call`,
        ),
      }),
    );
  };
  const service: GitHubCli.GitHubCli["Service"] = {
    execute: (input) => fail("execute", input.cwd),
    listOpenPullRequests: (input) => fail("listOpenPullRequests", input.cwd),
    getPullRequest: (input) => fail("getPullRequest", input.cwd),
    getRepositoryCloneUrls: (input) => fail("getRepositoryCloneUrls", input.cwd),
    createRepository: (input) => fail("createRepository", input.cwd),
    createPullRequest: (input) => fail("createPullRequest", input.cwd),
    getDefaultBranch: (input) => fail("getDefaultBranch", input.cwd),
    checkoutPullRequest: (input) => fail("checkoutPullRequest", input.cwd),
  };
  return { service, calls };
}

function makeUnusedTextGeneration(): TextGeneration.TextGeneration["Service"] {
  const notUsed = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "not exercised by this fixture (status-only lookup)",
      }),
    );
  return {
    generateCommitMessage: () => notUsed("generateCommitMessage"),
    generatePrContent: () => notUsed("generatePrContent"),
    generateBranchName: () => notUsed("generateBranchName"),
    generateThreadTitle: () => notUsed("generateThreadTitle"),
  };
}

function makeManager(gitHubCli: GitHubCli.GitHubCli["Service"]) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-pr-gate-test-",
  });
  const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
  const vcsDriverLayer = GitVcsDriver.layer.pipe(
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(serverConfigLayer),
  );
  const sourceControlRegistryLayer = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    GitHubSourceControlProvider.make.pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
      Effect.provide(Layer.succeed(GitHubCli.GitHubCli, gitHubCli)),
    ),
  );
  const managerLayer = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, makeUnusedTextGeneration()),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    vcsDriverLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(sourceControlRegistryLayer), Layer.provideMerge(NodeServices.layer));

  return GitManager.make.pipe(Effect.provide(managerLayer));
}

const GitManagerGateTestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-pr-gate-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerGateTestLayer)(
  "GitManager — PR status lookup kill switch (real default)",
  (it) => {
    it.effect(
      "status resolves pr: null and makes zero source-control provider calls when the const is off",
      () =>
        Effect.gen(function* () {
          const repoDir = yield* makeTempDir("t3code-git-manager-pr-gate-");
          yield* initRepo(repoDir);
          yield* runGit(repoDir, ["checkout", "-b", "feature/pr-lookup-off"]);
          const remoteDir = yield* createBareRemote();
          yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
          yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-lookup-off"]);

          const { service: gitHubCli, calls } = makeSpyGitHubCli();
          const manager = yield* makeManager(gitHubCli);

          const status = yield* manager.status({ cwd: repoDir });
          expect(status.isRepo).toBe(true);
          expect(status.pr).toBeNull();
          // Zero source-control provider / discovery-probe invocations from the lookup path:
          // every GitHubCli method is a fail-loud recorder (see makeSpyGitHubCli above), so a
          // non-empty `calls` here means the guard let something downstream run.
          expect(calls).toEqual([]);
        }),
    );
  },
);
