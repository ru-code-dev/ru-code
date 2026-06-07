// @effect-diagnostics nodeBuiltinImport:off
import { realpathSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../../src/processRunner.ts";
import { RepositoryIdentityResolver } from "../../../src/project/Services/RepositoryIdentityResolver.ts";
import {
  makeRepositoryIdentityResolver,
  RepositoryIdentityResolverLive,
} from "../../../src/project/Layers/RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) =>
  normalizePathSeparators(realpathSync.native(value));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(cwd));
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = `${repoRoot}/packages/web`;

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(repoRoot));
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("prefers upstream over origin when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-upstream-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("upstream");
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});

// ru-fork: git-health classification (§6.2) — real git failures (spawn/timeout)
// must surface a WARN; benign "not a repo / no remote" stay quiet (DEBUG only).
const okOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const exitOutput = (code: number): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const timedOutOutput: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: null,
  timedOut: true,
  stdoutTruncated: false,
  stderrTruncated: false,
};

type FakeRunHandler = (
  input: ProcessRunner.ProcessRunInput,
) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

const fakeProcessRunnerLayer = (handler: FakeRunHandler) =>
  Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run: handler }));

const isRevParse = (input: ProcessRunner.ProcessRunInput) => input.args.includes("rev-parse");

const containsWarn = (messages: ReadonlyArray<string>) =>
  messages.some((message) => message.includes("could not run") || message.includes("timed out"));

const resolveWith = (handler: FakeRunHandler, messages: string[]) => {
  const logger = Logger.make(({ message }) => {
    messages.push(String(message));
  });
  return Effect.gen(function* () {
    const resolver = yield* makeRepositoryIdentityResolver();
    return yield* resolver.resolve("/work/dir");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        fakeProcessRunnerLayer(handler),
        Logger.layer([logger], { mergeWithExisting: false }),
      ),
    ),
  );
};

describe("RepositoryIdentityResolver git-health logging", () => {
  it.effect("logs a WARN and returns null when git times out", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const identity = yield* resolveWith(() => Effect.succeed(timedOutOutput), messages);

      expect(identity).toBeNull();
      expect(messages.some((message) => message.includes("timed out"))).toBe(true);
    }),
  );

  it.effect("logs a WARN and returns null when git cannot be spawned", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const identity = yield* resolveWith(
        (input) =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              args: input.args,
              cause: new Error("spawn git ENOENT"),
            }),
          ),
        messages,
      );

      expect(identity).toBeNull();
      expect(messages.some((message) => message.includes("could not run"))).toBe(true);
    }),
  );

  it.effect("stays quiet (no WARN) for a non-git folder", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const identity = yield* resolveWith(() => Effect.succeed(exitOutput(128)), messages);

      expect(identity).toBeNull();
      expect(containsWarn(messages)).toBe(false);
    }),
  );

  // ru-fork: a non-repo must not trigger a doomed `git remote -v` spawn.
  it.effect("skips the remote lookup entirely for a non-git folder", () => {
    let remoteCalls = 0;
    const handler: FakeRunHandler = (input) => {
      if (isRevParse(input)) {
        return Effect.succeed(exitOutput(128));
      }
      remoteCalls += 1;
      return Effect.succeed(exitOutput(128));
    };

    return Effect.gen(function* () {
      const resolver = yield* makeRepositoryIdentityResolver();
      const identity = yield* resolver.resolve("/work/dir");

      expect(identity).toBeNull();
      expect(remoteCalls).toBe(0);
    }).pipe(Effect.provide(fakeProcessRunnerLayer(handler)));
  });

  it.effect("stays quiet (no WARN) for a repo without a usable remote", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const identity = yield* resolveWith(
        (input) =>
          isRevParse(input)
            ? Effect.succeed(okOutput("/repo/root"))
            : Effect.succeed(exitOutput(1)),
        messages,
      );

      expect(identity).toBeNull();
      expect(containsWarn(messages)).toBe(false);
    }),
  );

  it.effect("resolves a valid remote into an identity with no WARN", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const identity = yield* resolveWith(
        (input) =>
          isRevParse(input)
            ? Effect.succeed(okOutput("/repo/root"))
            : Effect.succeed(
                okOutput(
                  "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n" +
                    "origin\tgit@github.com:T3Tools/t3code.git (push)\n",
                ),
              ),
        messages,
      );

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(containsWarn(messages)).toBe(false);
    }),
  );

  it.effect("caches the remote lookup across resolves of the same repo", () => {
    let remoteCalls = 0;
    const handler: FakeRunHandler = (input) => {
      if (isRevParse(input)) {
        return Effect.succeed(okOutput("/repo/root"));
      }
      remoteCalls += 1;
      return Effect.succeed(okOutput("origin\tgit@github.com:T3Tools/t3code.git (fetch)\n"));
    };

    return Effect.gen(function* () {
      const resolver = yield* makeRepositoryIdentityResolver();
      const first = yield* resolver.resolve("/work/dir");
      const second = yield* resolver.resolve("/work/dir");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(remoteCalls).toBe(1);
    }).pipe(Effect.provide(fakeProcessRunnerLayer(handler)));
  });
});
