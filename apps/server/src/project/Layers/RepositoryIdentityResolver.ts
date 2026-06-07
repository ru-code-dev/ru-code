import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";

import * as ProcessRunner from "../../processRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

// ru-fork: returns `Some(repoRoot)` only when `cwd` is a resolvable git repo;
// `None` when git can't run / times out / the folder is not a repo. A `None`
// lets `resolve` skip the remote lookup entirely (nothing to enrich), and is
// never cached, so a later `git init` is picked up on the next resolve.
const resolveRepositoryIdentityCacheKey = Effect.fn("resolveRepositoryIdentityCacheKey")(function* (
  cwd: string,
): Effect.fn.Return<Option.Option<string>, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const topLevelResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  // ru-fork git-health classification (§2.2 — "don't silently swallow a broken git"):
  if (topLevelResult._tag === "None") {
    // spawn failure: git missing / unspawnable -> REAL problem, surface it.
    yield* Effect.logWarning(
      `repository-identity: \`git rev-parse\` could not run for ${cwd} — git missing or unspawnable`,
    );
    return Option.none();
  }
  if (topLevelResult.value.timedOut) {
    // git unresponsive -> REAL problem, surface it.
    yield* Effect.logWarning(
      `repository-identity: \`git rev-parse\` timed out for ${cwd} — git unresponsive`,
    );
    return Option.none();
  }
  if (topLevelResult.value.code !== 0) {
    // not a git repo -> benign, expected for many folders. Quiet.
    yield* Effect.logDebug(
      `repository-identity: ${cwd} is not a git repo (rev-parse code=${topLevelResult.value.code})`,
    );
    return Option.none();
  }

  const candidate = topLevelResult.value.stdout.trim();
  return Option.some(candidate.length > 0 ? candidate : cwd);
});

const resolveRepositoryIdentityFromCacheKey = Effect.fn("resolveRepositoryIdentityFromCacheKey")(
  function* (
    cacheKey: string,
  ): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const remoteResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey, "remote", "-v"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    // ru-fork git-health classification (§2.2):
    if (remoteResult._tag === "None") {
      yield* Effect.logWarning(
        `repository-identity: \`git remote -v\` could not run for ${cacheKey} — git missing or unspawnable`,
      );
      return null;
    }
    if (remoteResult.value.timedOut) {
      yield* Effect.logWarning(
        `repository-identity: \`git remote -v\` timed out for ${cacheKey} — git unresponsive`,
      );
      return null;
    }
    if (remoteResult.value.code !== 0) {
      // repo with no remote -> benign. Quiet.
      yield* Effect.logDebug(
        `repository-identity: ${cacheKey} has no usable remote (remote -v code=${remoteResult.value.code})`,
      );
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
  },
);

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) =>
        resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      const cacheKey = yield* resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      );
      // ru-fork: not a resolvable git repo (not a repo / git broken) -> skip the
      // remote lookup; there is nothing to enrich and no cache entry to make.
      if (Option.isNone(cacheKey)) {
        return null;
      }
      return yield* Cache.get(repositoryIdentityCache, cacheKey.value);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
).pipe(Layer.provide(ProcessRunner.layer));
