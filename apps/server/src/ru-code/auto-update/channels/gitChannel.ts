// ru-code: the git update source. The release repository carries the WHOLE release on its release
// branch — `<dir>/manifest.json`, `<dir>/changelog.json` and the tarball beside them (the same tree
// `prepare-release` emits), so git is a complete source and not a pointer to one.
//
// Nothing is ever cloned in full to answer a CHECK. Two strategies, picked by what the server can
// actually do (see gitStrategy.ts) and then REMEMBERED for the process:
//
//   archive — `git archive --remote` names the paths and gets them back; no repo on disk at all.
//   clone   — a blobless, checkout-less `--depth 1` clone, then `cat-file` for the metadata and
//             `checkout -- <path>` for the one blob an install needs.
//
// A probe is still a `git ls-remote` of the release ref. Every temp workspace is caller-supplied and
// ALWAYS removed. The caller passes a ready-made auth env (built by the credential agents — this
// module never constructs credentials); we layer the prompt-disabling guarantees around it so git
// can never hang, then classify any real failure into an evidence-based `ClassifiedFailure` via
// `classifyGitStderr`. git is spawned via a caller-injected ProcessRunner (argv arrays only — never
// a shell), and its output is written to FILES rather than captured, because a tarball is far larger
// than the runner's output cap and stdout is decoded as text (which would corrupt binary bytes).

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Tar from "tar";

// ru-code: the git timeouts, the output cap, the release layout and the tarball naming convention
// are branding values — see ru-code/branding/src/auto-update.ts and index.ts.
import {
  releaseTarballName,
  UPDATE_GIT_ARCHIVE_TIMEOUT_MS,
  UPDATE_GIT_BRANCH,
  UPDATE_GIT_CLONE_TIMEOUT_MS,
  UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS,
  UPDATE_GIT_OUTPUT_CAP_BYTES,
  UPDATE_GIT_PROBE_TIMEOUT_MS,
  UPDATE_GIT_RELEASE_DIR,
} from "@ru-code/branding";

import type { UpdateFailureCode } from "@t3tools/contracts";

import * as ProcessRunner from "../../../processRunner.ts";
import { type ClassifiedFailure, classifyGitStderr } from "../engine/classification.ts";
import { buildGitEnv, redactUrl } from "../gitAuth/gitEnv.ts";
import { type Manifest, parseManifest } from "../manifest.ts";
import {
  archiveIsPossible,
  filterWasIgnored,
  type GitStrategy,
  isArchiveCapabilityRejection,
  isArchivePathMissing,
  releaseRepoPath,
} from "./gitStrategy.ts";

/** The spawner shape this module needs — the injected ProcessRunner service. */
type GitSpawner = ProcessRunner.ProcessRunner["Service"];

/** Synthetic output when git itself can't be started (classifies to transport-other → unreachable). */
const SPAWN_FAILED: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "git could not be started",
  code: null,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

const MANIFEST_FILENAME = "manifest.json";
const CHANGELOG_FILENAME = "changelog.json";
/** Where an `archive` strategy drops the server's tar stream before it is unpacked. */
const ARCHIVE_TMP_NAME = "release.tar";

// ── typed outcomes ─────────────────────────────────────────────────────────────

/** A parsed git release: the manifest, raw changelog text (null when absent), and metrics. */
export interface GitRelease {
  readonly manifest: Manifest;
  readonly changelog: string | null;
  readonly latencyMs: number;
  readonly bytes: number;
  /** Which strategy actually produced it — journalled in the debug log, not on the wire. */
  readonly strategy: GitStrategy;
}

/** A release tarball pulled out of the repo and waiting on disk for verification. */
export interface GitTarball {
  readonly path: string;
  readonly bytes: number;
  readonly latencyMs: number;
  readonly strategy: GitStrategy;
}

/**
 * The single failure type for the git source. Carries an evidence-based `ClassifiedFailure`
 * (answered git-access-denied / git-not-found / invalid-manifest vs transport dns/timeout/…). The
 * class/code express what the old GitAuthError / GitNetworkError split conveyed, now with full
 * evidence; `GitInvalidManifestError` is folded in as `answered` / `invalid-manifest`.
 */
export class GitSourceFailure extends Data.TaggedError("GitSourceFailure")<{
  readonly url: string;
  readonly failure: ClassifiedFailure;
}> {}

/** A lightweight reachability probe result over ls-remote. */
export type GitProbeResult =
  | { readonly ok: true; readonly latencyMs: number; readonly raw: string }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * The per-process memory of which strategy a repo answers to. In memory ON PURPOSE: persisting it
 * would go stale the day the server is upgraded or the repo moves, and re-probing every tick would
 * spend a round trip to re-learn something that changes once a year. A process start re-probes.
 */
export interface GitStrategyCache {
  readonly get: (repoUrl: string) => GitStrategy | null;
  readonly set: (repoUrl: string, strategy: GitStrategy) => void;
}

export const makeGitStrategyCache = (): GitStrategyCache => {
  const remembered = new Map<string, GitStrategy>();
  return {
    get: (repoUrl) => remembered.get(repoUrl) ?? null,
    set: (repoUrl, strategy) => {
      remembered.set(repoUrl, strategy);
    },
  };
};

const firstMeaningfulLine = (text: string): string => {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return redactUrl(line ?? "no output").slice(0, 200);
};

// ── shared access parameters ─────────────────────────────────────────────────────

/** Everything a git operation needs to reach ONE release repository. */
export interface GitAccess {
  readonly repoUrl: string;
  readonly env: Record<string, string>;
  readonly spawner: GitSpawner;
  /** Release branch; "" = the remote's default. Defaults to the baked branding value. */
  readonly branch?: string;
  /** Directory inside the repo carrying the release. Defaults to the baked branding value. */
  readonly releaseDir?: string;
  /** Remembers which strategy this repo answers to; omitted = decide fresh every call. */
  readonly strategyCache?: GitStrategyCache;
}

const accessBranch = (access: GitAccess): string => access.branch ?? UPDATE_GIT_BRANCH;
const accessReleaseDir = (access: GitAccess): string => access.releaseDir ?? UPDATE_GIT_RELEASE_DIR;
/** The ref an operation names. With no branch configured that is the remote's own default. */
const accessRef = (access: GitAccess): string => {
  const branch = accessBranch(access);
  return branch === "" ? "HEAD" : branch;
};

// ── one git invocation ───────────────────────────────────────────────────────────

interface GitRun {
  readonly output: ProcessRunner.ProcessRunOutput;
  readonly latencyMs: number;
}

const runGit = (params: {
  readonly access: GitAccess;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly cwd?: string;
}): Effect.Effect<GitRun> =>
  Effect.timed(
    params.access.spawner
      .run({
        command: "git",
        args: params.args,
        env: buildGitEnv({
          repoUrl: params.access.repoUrl,
          authEnv: params.access.env,
          baseEnv: process.env,
        }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        timeout: Duration.millis(params.timeoutMs),
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
        maxOutputBytes: UPDATE_GIT_OUTPUT_CAP_BYTES,
      })
      .pipe(Effect.orElseSucceed(() => SPAWN_FAILED)),
  ).pipe(
    Effect.map(([duration, output]) => ({
      output,
      latencyMs: Math.round(Duration.toMillis(duration)),
    })),
  );

/** Turn a failed git run into the source's typed failure. */
const gitFailure = (params: {
  readonly access: GitAccess;
  readonly run: GitRun;
  readonly what: string;
}): GitSourceFailure => {
  const redactedUrl = redactUrl(params.access.repoUrl);
  if (params.run.output.timedOut) {
    return new GitSourceFailure({
      url: redactedUrl,
      failure: {
        class: "transport",
        code: "timeout",
        raw: `${params.what} timed out`,
        latencyMs: params.run.latencyMs,
        status: null,
      },
    });
  }
  const classified = classifyGitStderr(params.run.output.stderr);
  return new GitSourceFailure({
    url: redactedUrl,
    failure: {
      class: classified.class,
      code: classified.code,
      raw: `${params.what}: ${firstMeaningfulLine(params.run.output.stderr)}`,
      latencyMs: params.run.latencyMs,
      status: null,
    },
  });
};

/** An `answered` failure about the release layout rather than the connection. */
const answeredFailure = (params: {
  readonly access: GitAccess;
  readonly code: UpdateFailureCode;
  readonly raw: string;
  readonly latencyMs: number;
}): GitSourceFailure =>
  new GitSourceFailure({
    url: redactUrl(params.access.repoUrl),
    failure: {
      class: "answered",
      code: params.code,
      raw: params.raw,
      latencyMs: params.latencyMs,
      status: null,
    },
  });

// ── strategy: archive ────────────────────────────────────────────────────────────

/** What an archive attempt produced. `unsupported` is the capability answer — never a failure. */
type ArchiveAttempt =
  | { readonly tag: "ok"; readonly latencyMs: number }
  | { readonly tag: "unsupported" }
  | { readonly tag: "missing-path"; readonly latencyMs: number; readonly raw: string }
  | { readonly tag: "failed"; readonly failure: GitSourceFailure };

/**
 * `git archive --remote=<url> --output=<file> <ref> <paths…>` followed by an in-process untar
 * (see {@link untarInto}). The server streams a tar of exactly those paths; `--output` keeps the
 * bytes out of the process (the runner's stdout is text-decoded and capped, which binary content
 * cannot survive).
 */
const archiveInto = (params: {
  readonly access: GitAccess;
  readonly paths: ReadonlyArray<string>;
  readonly destDir: string;
  readonly timeoutMs: number;
}): Effect.Effect<ArchiveAttempt, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tarPath = path.join(params.destDir, ARCHIVE_TMP_NAME);

    yield* fs
      .makeDirectory(params.destDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));

    const run = yield* runGit({
      access: params.access,
      args: [
        "archive",
        `--remote=${params.access.repoUrl}`,
        "--output",
        tarPath,
        accessRef(params.access),
        ...params.paths,
      ],
      timeoutMs: params.timeoutMs,
    });

    if (run.output.code !== 0) {
      if (!run.output.timedOut && isArchiveCapabilityRejection(run.output.stderr)) {
        yield* Effect.logDebug("[auto-update] git archive not supported; falling back to clone", {
          url: redactUrl(params.access.repoUrl),
          raw: firstMeaningfulLine(run.output.stderr),
        });
        return { tag: "unsupported" };
      }
      if (!run.output.timedOut && isArchivePathMissing(run.output.stderr)) {
        return {
          tag: "missing-path",
          latencyMs: run.latencyMs,
          raw: firstMeaningfulLine(run.output.stderr),
        };
      }
      return {
        tag: "failed",
        failure: gitFailure({ access: params.access, run, what: "git archive" }),
      };
    }

    const unpacked = yield* untarInto(tarPath, params.destDir);
    yield* fs.remove(tarPath).pipe(Effect.orElseSucceed(() => undefined));
    if (!unpacked.ok) {
      return {
        tag: "failed",
        failure: answeredFailure({
          access: params.access,
          code: "invalid-manifest",
          raw: `could not unpack the archive: ${unpacked.raw}`,
          latencyMs: run.latencyMs,
        }),
      };
    }
    return { tag: "ok", latencyMs: run.latencyMs };
  });

/**
 * In-process untar of the server's archive stream (node-tar — pure JS, no ambient binary).
 * Separate from git so an extract failure is never read as a git failure. This used to spawn
 * whatever `tar` PATH resolved, which was a field failure class of its own: GNU tar under
 * Git-Bash on Windows reads `C:\…` as a `host:file` remote («Cannot connect to C: resolve
 * failed») and reported it here as if the SERVER's release were broken; a PATH-stripped Linux
 * launch had no tar at all. In-process extraction removes the binary entirely, and what remains
 * of this failure genuinely IS the server's stream being malformed — which is exactly what the
 * `invalid-manifest` classification downstream claims.
 */
const untarInto = (
  tarPath: string,
  destDir: string,
): Effect.Effect<{ readonly ok: boolean; readonly raw: string }> =>
  Effect.promise(() =>
    Tar.extract({ file: tarPath, cwd: destDir }).then(
      () => ({ ok: true, raw: "" }),
      (error: unknown) => ({
        ok: false,
        raw: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      }),
    ),
  );

// ── strategy: clone ──────────────────────────────────────────────────────────────

/**
 * A shallow single-branch clone. `blobless` controls `--filter=blob:none`: true for a CHECK
 * (transfers only trees — the tarball blob stays on the server), false for an INSTALL (the tarball
 * blob must be local so `checkout` can write it without a lazy fetch, which fails on some git
 * servers). When the server ignores the filter the clone is full — logged, never an error.
 */
const shallowClone = (params: {
  readonly access: GitAccess;
  readonly dir: string;
  readonly blobless: boolean;
}): Effect.Effect<
  { readonly ok: true } | { readonly ok: false; readonly failure: GitSourceFailure }
> =>
  Effect.gen(function* () {
    const branch = accessBranch(params.access);
    const run = yield* runGit({
      access: params.access,
      args: [
        "clone",
        ...(params.blobless ? ["--filter=blob:none"] : []),
        "--no-checkout",
        "--depth",
        "1",
        "--single-branch",
        ...(branch === "" ? [] : ["--branch", branch]),
        params.access.repoUrl,
        params.dir,
      ],
      timeoutMs: UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS,
    });
    if (run.output.code !== 0) {
      return { ok: false, failure: gitFailure({ access: params.access, run, what: "git clone" }) };
    }
    if (params.blobless && filterWasIgnored(run.output.stderr)) {
      yield* Effect.logDebug("[auto-update] git server ignored --filter; the clone was full", {
        url: redactUrl(params.access.repoUrl),
      });
    }
    return { ok: true };
  });

/** Read one small blob out of a clone. Returns null when the path is absent from the tree. */
const readBlob = (params: {
  readonly access: GitAccess;
  readonly dir: string;
  readonly repoPath: string;
}): Effect.Effect<string | null> =>
  runGit({
    access: params.access,
    args: ["-C", params.dir, "cat-file", "blob", `HEAD:${params.repoPath}`],
    timeoutMs: UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS,
  }).pipe(Effect.map((run) => (run.output.code === 0 ? run.output.stdout : null)));

/** Materialise ONE path of the tree into the clone's working directory (fetches just that blob). */
const checkoutBlob = (params: {
  readonly access: GitAccess;
  readonly dir: string;
  readonly repoPath: string;
}): Effect.Effect<GitRun> =>
  runGit({
    access: params.access,
    args: ["-C", params.dir, "checkout", "HEAD", "--", params.repoPath],
    timeoutMs: UPDATE_GIT_CLONE_TIMEOUT_MS,
  });

// ── probe ────────────────────────────────────────────────────────────────────────

/**
 * The ref the probe asks for. With no branch configured that is `HEAD` (the remote's default, the
 * pre-branch behaviour); with one it is that branch's ref, so a repo whose RELEASE branch is
 * missing fails the probe instead of reporting a healthy source that can never deliver.
 */
const probeRef = (branch: string): string => (branch === "" ? "HEAD" : `refs/heads/${branch}`);

/**
 * Probe a git remote with `git ls-remote <repoUrl> <ref>` under the prompt-disabling env, killing it
 * after the probe budget. Returns `{ok:true}` on exit 0 (includes ambient success via the user's own
 * credential helper) or `{ok:false, failure}` with an evidence-based classification (a timeout is
 * transport `timeout`; a non-zero exit runs through `classifyGitStderr`). Never throws.
 */
export const probeGit = (params: {
  readonly repoUrl: string;
  readonly env: Record<string, string>;
  readonly spawner: GitSpawner;
  /** Release branch; "" = the remote's default. Defaults to the baked branding value. */
  readonly branch?: string;
}): Effect.Effect<GitProbeResult> =>
  Effect.gen(function* () {
    const access: GitAccess = params;
    const branch = accessBranch(access);
    const run = yield* runGit({
      access,
      args: ["ls-remote", params.repoUrl, probeRef(branch)],
      timeoutMs: UPDATE_GIT_PROBE_TIMEOUT_MS,
    });
    const redactedUrl = redactUrl(params.repoUrl);

    if (run.output.timedOut) {
      return {
        ok: false,
        failure: {
          class: "transport",
          code: "timeout",
          raw: `ls-remote timed out for ${redactedUrl}`,
          latencyMs: run.latencyMs,
          status: null,
        },
      };
    }
    if (run.output.code === 0) {
      // `ls-remote` exits 0 for a ref that does not exist — it just prints nothing. So an empty
      // answer for a CONFIGURED branch is an answered failure (the repo is reachable, the release
      // branch is not there), not a healthy source.
      if (branch !== "" && run.output.stdout.trim() === "") {
        return {
          ok: false,
          failure: {
            class: "answered",
            code: "git-not-found",
            raw: `${redactedUrl}: no ${probeRef(branch)}`,
            latencyMs: run.latencyMs,
            status: null,
          },
        };
      }
      return { ok: true, latencyMs: run.latencyMs, raw: "ls-remote ok" };
    }
    const classified = classifyGitStderr(run.output.stderr);
    return {
      ok: false,
      failure: {
        class: classified.class,
        code: classified.code,
        raw: `${redactedUrl}: ${firstMeaningfulLine(run.output.stderr)}`,
        latencyMs: run.latencyMs,
        status: null,
      },
    };
  });

// ── metadata fetch (the CHECK) ───────────────────────────────────────────────────

/** Parse the two metadata texts into a release, or fail with the layout's own `answered` code. */
const releaseFromTexts = (params: {
  readonly access: GitAccess;
  readonly rawManifest: string | null;
  readonly rawChangelog: string | null;
  readonly latencyMs: number;
  readonly strategy: GitStrategy;
}): Effect.Effect<GitRelease, GitSourceFailure> =>
  Effect.gen(function* () {
    if (params.rawManifest === null) {
      return yield* answeredFailure({
        access: params.access,
        code: "invalid-manifest",
        raw: `${releaseRepoPath(accessReleaseDir(params.access), MANIFEST_FILENAME)} not found on ${
          accessBranch(params.access) === "" ? "the default branch" : accessBranch(params.access)
        }`,
        latencyMs: params.latencyMs,
      });
    }
    const manifest = parseManifest(params.rawManifest);
    if (manifest === null) {
      return yield* answeredFailure({
        access: params.access,
        code: "invalid-manifest",
        raw: "manifest.json could not be parsed",
        latencyMs: params.latencyMs,
      });
    }
    const bytes =
      new TextEncoder().encode(params.rawManifest).length +
      (params.rawChangelog === null ? 0 : new TextEncoder().encode(params.rawChangelog).length);
    return {
      manifest,
      changelog: params.rawChangelog,
      latencyMs: params.latencyMs,
      bytes,
      strategy: params.strategy,
    };
  });

/** Read the two metadata files with `archive` — one round trip, nothing left on disk. */
const metadataByArchive = (params: {
  readonly access: GitAccess;
  readonly tmpDir: string;
}): Effect.Effect<
  { readonly tag: "unsupported" } | { readonly tag: "release"; readonly release: GitRelease },
  GitSourceFailure,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const releaseDir = accessReleaseDir(params.access);
    const manifestPath = releaseRepoPath(releaseDir, MANIFEST_FILENAME);
    const changelogPath = releaseRepoPath(releaseDir, CHANGELOG_FILENAME);
    const dest = path.join(params.tmpDir, "archive");

    // Ask for both; a repo without release notes makes the server reject the WHOLE pathspec, so that
    // case retries with the manifest alone rather than reporting a missing release.
    let attempt = yield* archiveInto({
      access: params.access,
      paths: [manifestPath, changelogPath],
      destDir: dest,
      timeoutMs: UPDATE_GIT_ARCHIVE_TIMEOUT_MS,
    });
    if (attempt.tag === "missing-path") {
      attempt = yield* archiveInto({
        access: params.access,
        paths: [manifestPath],
        destDir: dest,
        timeoutMs: UPDATE_GIT_ARCHIVE_TIMEOUT_MS,
      });
    }
    if (attempt.tag === "unsupported") return { tag: "unsupported" };
    if (attempt.tag === "failed") return yield* attempt.failure;
    if (attempt.tag === "missing-path") {
      return yield* answeredFailure({
        access: params.access,
        code: "invalid-manifest",
        raw: `${manifestPath}: ${attempt.raw}`,
        latencyMs: attempt.latencyMs,
      });
    }

    const readText = (repoPath: string): Effect.Effect<string | null> =>
      fs.readFileString(path.join(dest, repoPath)).pipe(Effect.orElseSucceed(() => null));

    const release = yield* releaseFromTexts({
      access: params.access,
      rawManifest: yield* readText(manifestPath),
      rawChangelog: yield* readText(changelogPath),
      latencyMs: attempt.latencyMs,
      strategy: "archive",
    });
    return { tag: "release", release };
  });

/** Read the two metadata files out of a blobless clone. */
const metadataByClone = (params: {
  readonly access: GitAccess;
  readonly tmpDir: string;
}): Effect.Effect<GitRelease, GitSourceFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = path.join(params.tmpDir, "checkout");
    const releaseDir = accessReleaseDir(params.access);

    const [duration, cloned] = yield* Effect.timed(
      shallowClone({ access: params.access, dir, blobless: true }),
    );
    if (!cloned.ok) return yield* cloned.failure;
    const latencyMs = Math.round(Duration.toMillis(duration));

    return yield* releaseFromTexts({
      access: params.access,
      rawManifest: yield* readBlob({
        access: params.access,
        dir,
        repoPath: releaseRepoPath(releaseDir, MANIFEST_FILENAME),
      }),
      rawChangelog: yield* readBlob({
        access: params.access,
        dir,
        repoPath: releaseRepoPath(releaseDir, CHANGELOG_FILENAME),
      }),
      latencyMs,
      strategy: "clone",
    });
  });

/**
 * Fetch a git release's METADATA — the manifest (required) and the changelog (optional). Tries the
 * remembered strategy first, falls through from `archive` to `clone` on a capability answer, and
 * remembers whichever one produced the release.
 *
 * THE CALLER OWNS `tmpDir` — the same contract as {@link fetchGitTarball}. This used to clean up
 * after itself as well, while its caller cleaned in an `Effect.ensuring` too: one directory with
 * two owners, beside a sibling with the opposite rule, so removing either cleanup looked safe from
 * one side and leaked from the other. One owner, stated in both places.
 */
export const fetchGitRelease = (
  params: GitAccess & { readonly tmpDir: string },
): Effect.Effect<GitRelease, GitSourceFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const cache = params.strategyCache;
    const preferred = cache?.get(params.repoUrl) ?? null;

    if (preferred !== "clone" && archiveIsPossible(params.repoUrl)) {
      const attempt = yield* metadataByArchive({ access: params, tmpDir: params.tmpDir });
      if (attempt.tag === "release") {
        cache?.set(params.repoUrl, "archive");
        yield* logFetched(params, attempt.release);
        return attempt.release;
      }
    }
    // Remembered only once the clone actually produced the release — the ladder's promise is that
    // it remembers what WORKED, and setting it before the attempt made that promise false (benign,
    // because the statement was reachable only when clone was already the right answer).
    const release = yield* metadataByClone({ access: params, tmpDir: params.tmpDir });
    cache?.set(params.repoUrl, "clone");
    yield* logFetched(params, release);
    return release;
  });

const logFetched = (access: GitAccess, release: GitRelease): Effect.Effect<void> =>
  Effect.logDebug("[auto-update] git release fetched", {
    url: redactUrl(access.repoUrl),
    version: release.manifest.version,
    strategy: release.strategy,
    bytes: release.bytes,
    latencyMs: release.latencyMs,
  });

// ── tarball fetch (the INSTALL) ──────────────────────────────────────────────────

/**
 * Pull the release TARBALL out of the repository and leave it on disk for the verification pipeline.
 * Same ladder as the metadata read, same remembered strategy; the caller owns `tmpDir` and its
 * removal, because the file must outlive this effect.
 *
 * There is no progress here: git reports none for either strategy. The install run watches the file
 * grow instead, which is the only honest source of a percentage.
 */
export const fetchGitTarball = (
  params: GitAccess & { readonly tmpDir: string; readonly version: string },
): Effect.Effect<GitTarball, GitSourceFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cache = params.strategyCache;
    const preferred = cache?.get(params.repoUrl) ?? null;
    const repoPath = releaseRepoPath(accessReleaseDir(params), releaseTarballName(params.version));

    const sized = (file: string, latencyMs: number, strategy: GitStrategy) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(file).pipe(Effect.result);
        if (info._tag === "Failure") {
          return yield* answeredFailure({
            access: params,
            code: "invalid-manifest",
            raw: `${repoPath} is not in the release`,
            latencyMs,
          });
        }
        return {
          path: file,
          bytes: Number(info.success.size),
          latencyMs,
          strategy,
        } satisfies GitTarball;
      });

    if (preferred !== "clone" && archiveIsPossible(params.repoUrl)) {
      const dest = path.join(params.tmpDir, "archive");
      const attempt = yield* archiveInto({
        access: params,
        paths: [repoPath],
        destDir: dest,
        timeoutMs: UPDATE_GIT_CLONE_TIMEOUT_MS,
      });
      if (attempt.tag === "ok") {
        cache?.set(params.repoUrl, "archive");
        return yield* sized(path.join(dest, repoPath), attempt.latencyMs, "archive");
      }
      if (attempt.tag === "failed") return yield* attempt.failure;
      if (attempt.tag === "missing-path") {
        return yield* answeredFailure({
          access: params,
          code: "release-download-failed",
          raw: `${repoPath}: ${attempt.raw}`,
          latencyMs: attempt.latencyMs,
        });
      }
      // `unsupported` — fall through to the clone below and remember it.
    }

    cache?.set(params.repoUrl, "clone");
    const dir = path.join(params.tmpDir, "checkout");
    const cloned = yield* shallowClone({ access: params, dir, blobless: false });
    if (!cloned.ok) return yield* cloned.failure;
    let run = yield* checkoutBlob({ access: params, dir, repoPath });
    if (run.output.code !== 0) {
      yield* Effect.logDebug("[auto-update] git checkout failed, retrying once", {
        stderr: run.output.stderr,
      });
      run = yield* checkoutBlob({ access: params, dir, repoPath });
    }
    if (run.output.code !== 0) {
      yield* Effect.logDebug("[auto-update] git checkout failed after retry", {
        stderr: run.output.stderr,
      });
      if (run.output.timedOut) {
        return yield* gitFailure({ access: params, run, what: "git checkout" });
      }
      return yield* answeredFailure({
        access: params,
        code: "release-download-failed",
        raw: `${repoPath}: ${firstMeaningfulLine(run.output.stderr)}`,
        latencyMs: run.latencyMs,
      });
    }
    return yield* sized(path.join(dir, repoPath), run.latencyMs, "clone");
  });
