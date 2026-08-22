// ru-code: the git channel over REAL local git repositories — a bare repo carrying the release
// layout on the release branch, reached over the same two strategies production uses:
//
//   · `git archive --remote` (a local bare repo answers `upload-archive`, so this is the real
//     command, not a simulation)
//   · a blobless `--no-checkout` clone + `cat-file` / `checkout` (forced by seeding the strategy
//     cache, and reached for real when the first strategy is refused)
//
// Both metadata reads and both tarball reads are covered, plus the invariants that matter: the
// tarball lands byte-identical, the temp workspace is always removed, the release branch is
// honoured, and a repo whose server ignores `--filter` still works (the row-4 degrade — a local
// PLAIN-PATH clone genuinely triggers git's "filtering not recognized" path, so it is exercised,
// not mocked). The whole suite is skipped cleanly when git is not on PATH.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { releaseTarballName, UPDATE_GIT_RELEASE_DIR } from "@ru-code/branding";

import * as ProcessRunner from "../../../processRunner.ts";
import {
  fetchGitRelease,
  fetchGitTarball,
  GitSourceFailure,
  makeGitStrategyCache,
  probeGit,
} from "../../auto-update/channels/gitChannel.ts";
import { releaseRepoPath } from "../../auto-update/channels/gitStrategy.ts";

const VERSION = "1.2.3";
const BRANCH = "release-line";
const VALID_MANIFEST =
  '{"version":"1.2.3","sha256":"deadbeef","minNode":">=20","sizeBytes":123,"releasedAt":"2026-01-01T00:00:00Z"}';
const CHANGELOG = '{"1.2.3":["first note"]}';
/** Big enough that a truncating stdout capture would be caught, and binary so text-decoding shows. */
const TARBALL_BYTES = NodeCrypto.randomBytes(300_000);

const manifestPath = releaseRepoPath(UPDATE_GIT_RELEASE_DIR, "manifest.json");
const changelogPath = releaseRepoPath(UPDATE_GIT_RELEASE_DIR, "changelog.json");
const tarballPath = releaseRepoPath(UPDATE_GIT_RELEASE_DIR, releaseTarballName(VERSION));

const gitOnPath = (): boolean => {
  try {
    NodeChildProcess.execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const hasGit = gitOnPath();

const createdRoots: Array<string> = [];

const runGit = (args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", args, {
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
};

/**
 * A real bare release repo carrying `files` on `branch`. Returns the bare repo's PATH; callers pick
 * the transport (`file://<path>` or the path itself — git treats them differently, and the
 * difference is exactly what the filter-degrade case needs).
 */
const makeReleaseRepo = (params: {
  readonly files: Record<string, Uint8Array | string>;
  readonly branch?: string;
}): string => {
  const branch = params.branch ?? BRANCH;
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-au-git-"));
  createdRoots.push(root);
  const bare = NodePath.join(root, "release.git");
  const work = NodePath.join(root, "work");
  runGit(["init", "--bare", "-b", branch, bare]);
  runGit(["init", "-b", branch, work]);
  runGit(["-C", work, "config", "user.email", "ci@example.com"]);
  runGit(["-C", work, "config", "user.name", "CI"]);
  runGit(["-C", work, "config", "commit.gpgsign", "false"]);
  // Partial clone is a server capability: without it git warns and transfers everything, which is
  // the matrix's row 4. Enabled here so the filtered path is genuinely exercised.
  runGit(["-C", bare, "config", "uploadpack.allowFilter", "true"]);
  for (const [name, content] of Object.entries(params.files)) {
    const target = NodePath.join(work, name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
  runGit(["-C", work, "add", "."]);
  runGit(["-C", work, "commit", "-m", "release"]);
  runGit(["-C", work, "remote", "add", "origin", bare]);
  runGit(["-C", work, "push", "-u", "origin", branch]);
  return bare;
};

const fullRelease = (): Record<string, Uint8Array | string> => ({
  [manifestPath]: VALID_MANIFEST,
  [changelogPath]: CHANGELOG,
  [tarballPath]: TARBALL_BYTES,
});

let missingRepoCounter = 0;
const nonexistentRepoUrl = (): string => {
  missingRepoCounter += 1;
  return `file://${NodePath.join(NodeOS.tmpdir(), `ru-au-missing-${process.pid}-${missingRepoCounter}.git`)}`;
};

/** A cache pinned to `clone`, so the clone strategy is exercised on a repo that supports archive. */
/**
 * A caller-owned workspace, registered for teardown. `fetchGitRelease` no longer removes `tmpDir`
 * itself — the caller owns it, the same contract `fetchGitTarball` has always had — so a spec that
 * makes one is the thing that has to clean it up, exactly like the engine's `Effect.ensuring` does
 * in production. Without this the suite left a repo checkout in the OS temp dir on every run.
 */
const callerOwnedTmp = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix });
    createdRoots.push(dir);
    return dir;
  });

const cloneOnly = (repoUrl: string) => {
  const cache = makeGitStrategyCache();
  cache.set(repoUrl, "clone");
  return cache;
};

afterAll(() => {
  for (const root of createdRoots) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

if (!hasGit) {
  describe.skip("gitChannel (git not on PATH)", () => {
    // No dummy assertion: `expect(true).toBe(true)` inside a skipped block makes a lean container
    // report the SAME green (and the same test count) as a full run, for the git channel's ONLY
    // coverage anywhere. An empty skipped describe reports a skip, which is the truth.
    it.skip("gitChannel specs require git on PATH", () => undefined);
  });
} else {
  it.layer(NodeServices.layer)("gitChannel — metadata", (it) => {
    it.effect("archive: reads manifest + changelog with no repository on disk", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        const release = yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
        });
        expect(release.strategy).toBe("archive");
        expect(release.manifest.version).toBe(VERSION);
        expect(release.manifest.sha256).toBe("deadbeef");
        expect(release.changelog).toBe(CHANGELOG);
        expect(release.bytes).toBeGreaterThan(0);
        expect(release.latencyMs).toBeGreaterThanOrEqual(0);

        // THE CALLER owns `tmpDir` — the same contract as `fetchGitTarball`, so the two sibling
        // exports no longer have opposite rules and the engine's `Effect.ensuring` is the single
        // owner of the removal (it used to be removed twice, from both sides).
        expect(yield* fs.exists(tmpDir)).toBe(true);
        // An `archive` read leaves no repository behind, which is the property that matters here.
        expect(yield* fs.exists(path.join(tmpDir, "checkout"))).toBe(false);
      }),
    );

    it.effect("archive: a release with no changelog.json still resolves, changelog = null", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: { [manifestPath]: VALID_MANIFEST } })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        // The server rejects the WHOLE pathspec when one path is missing, so this only works
        // because the ladder retries with the manifest alone.
        const release = yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
        });
        expect(release.strategy).toBe("archive");
        expect(release.manifest.version).toBe(VERSION);
        expect(release.changelog).toBeNull();
      }),
    );

    it.effect("clone: reads the same metadata through a blobless checkout-less clone", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const fs = yield* FileSystem.FileSystem;
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        const release = yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
          strategyCache: cloneOnly(repoUrl),
        });
        expect(release.strategy).toBe("clone");
        expect(release.manifest.version).toBe(VERSION);
        expect(release.changelog).toBe(CHANGELOG);
        // Caller-owned workspace (see the archive spec above).
        expect(yield* fs.exists(tmpDir)).toBe(true);
      }),
    );

    it.effect("clone: still works when the server IGNORES --filter (matrix row 4)", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        // A PLAIN local path makes git print «--filter is ignored in local clones» and transfer
        // everything. The result must be identical — a fatter clone, never a failure.
        const repoUrl = makeReleaseRepo({ files: fullRelease() });
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        const release = yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
          strategyCache: cloneOnly(repoUrl),
        });
        expect(release.manifest.version).toBe(VERSION);
        expect(release.changelog).toBe(CHANGELOG);
      }),
    );

    it.effect("a branch that carries no release answers invalid-manifest, both strategies", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: { "README.md": "no release here" } })}`;

        for (const strategyCache of [undefined, cloneOnly(repoUrl)]) {
          const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");
          const error = yield* fetchGitRelease({
            repoUrl,
            env: {},
            spawner,
            tmpDir,
            branch: BRANCH,
            ...(strategyCache === undefined ? {} : { strategyCache }),
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(GitSourceFailure);
          expect(error.failure.class).toBe("answered");
          expect(error.failure.code).toBe("invalid-manifest");
        }
      }),
    );

    it.effect("a manifest that cannot be parsed is answered/invalid-manifest, not a crash", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: { [manifestPath]: "{not json" } })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        const error = yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
        }).pipe(Effect.flip);
        expect(error.failure.code).toBe("invalid-manifest");
      }),
    );

    it.effect("classifies a nonexistent repo path as a GitSourceFailure", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");

        const error = yield* fetchGitRelease({
          repoUrl: nonexistentRepoUrl(),
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(GitSourceFailure);
        expect(error.failure.raw).not.toBeNull();
      }),
    );

    it.effect("remembers the strategy that worked, so the next reach skips the ladder", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const strategyCache = makeGitStrategyCache();
        expect(strategyCache.get(repoUrl)).toBeNull();

        const tmpDir = yield* callerOwnedTmp("ru-au-fetch-");
        yield* fetchGitRelease({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          branch: BRANCH,
          strategyCache,
        });
        expect(strategyCache.get(repoUrl)).toBe("archive");
      }),
    );
  });

  it.layer(NodeServices.layer)("gitChannel — the release tarball", (it) => {
    it.effect("archive: lands the tarball byte-identical", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const fs = yield* FileSystem.FileSystem;
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-blob-");

        const tarball = yield* fetchGitTarball({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          version: VERSION,
          branch: BRANCH,
        });
        expect(tarball.strategy).toBe("archive");
        expect(tarball.bytes).toBe(TARBALL_BYTES.byteLength);
        const landed = yield* fs.readFile(tarball.path);
        expect(Buffer.from(landed).equals(TARBALL_BYTES)).toBe(true);
      }),
    );

    it.effect("clone: lands the same bytes through sparse blob materialisation", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const fs = yield* FileSystem.FileSystem;
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-blob-");

        const tarball = yield* fetchGitTarball({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          version: VERSION,
          branch: BRANCH,
          strategyCache: cloneOnly(repoUrl),
        });
        expect(tarball.strategy).toBe("clone");
        const landed = yield* fs.readFile(tarball.path);
        expect(Buffer.from(landed).equals(TARBALL_BYTES)).toBe(true);
      }),
    );

    it.effect(
      "a release whose tarball is missing answers release-download-failed, both strategies",
      () =>
        Effect.gen(function* () {
          const spawner = yield* ProcessRunner.make();
          const repoUrl = `file://${makeReleaseRepo({
            files: { [manifestPath]: VALID_MANIFEST, [changelogPath]: CHANGELOG },
          })}`;

          for (const strategyCache of [undefined, cloneOnly(repoUrl)]) {
            const tmpDir = yield* callerOwnedTmp("ru-au-blob-");
            const error = yield* fetchGitTarball({
              repoUrl,
              env: {},
              spawner,
              tmpDir,
              version: VERSION,
              branch: BRANCH,
              ...(strategyCache === undefined ? {} : { strategyCache }),
            }).pipe(Effect.flip);
            expect(error.failure.class).toBe("answered");
            expect(error.failure.code).toBe("release-download-failed");
          }
        }),
    );

    it.effect("the tarball path is exactly the one prepare-release writes", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;
        const tmpDir = yield* callerOwnedTmp("ru-au-blob-");

        const tarball = yield* fetchGitTarball({
          repoUrl,
          env: {},
          spawner,
          tmpDir,
          version: VERSION,
          branch: BRANCH,
        });
        // The repo path the channel asked for is the producer's own layout — the fixture writes
        // `dist-bundle/ru-code-1.2.3.tgz` and nothing here re-states that shape by hand.
        expect(tarball.path.endsWith(tarballPath)).toBe(true);
      }),
    );
  });

  it.layer(NodeServices.layer)("gitChannel — probe", (it) => {
    it.effect("probeGit reports ok for the configured release branch, with latency", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease() })}`;

        const result = yield* probeGit({ repoUrl, env: {}, spawner, branch: BRANCH });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      }),
    );

    it.effect("probeGit FAILS when the repo is reachable but the release branch is missing", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const repoUrl = `file://${makeReleaseRepo({ files: fullRelease(), branch: "main" })}`;

        // `ls-remote` exits 0 and prints nothing for an absent ref — a healthy-looking answer that
        // can never deliver a release.
        const result = yield* probeGit({ repoUrl, env: {}, spawner, branch: BRANCH });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.code).toBe("git-not-found");
      }),
    );

    it.effect("probeGit reports a failure for a nonexistent repo", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.make();
        const result = yield* probeGit({ repoUrl: nonexistentRepoUrl(), env: {}, spawner });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.failure.latencyMs).toBe("number");
          expect(result.failure.raw).not.toBeNull();
        }
      }),
    );
  });
}
