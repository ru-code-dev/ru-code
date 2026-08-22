// ru-code: the cache-first repository-identity wrapper (boot-performance.md
// Fix G). Contract: `resolve` NEVER waits on the underlying resolver — it
// answers from cache or null immediately, forks exactly one deduped background
// fill per root, and serves the stale value during a TTL refresh.
import { describe, expect, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeCacheFirstRepositoryIdentity } from "../../reconnect/cacheFirstRepositoryIdentity.ts";

const identityFor = (rootPath: string): RepositoryIdentity => ({
  canonicalKey: `github.com/acme${rootPath}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/acme${rootPath}.git`,
  },
  rootPath,
});

describe("makeCacheFirstRepositoryIdentity", () => {
  it.effect("a hanging git never blocks resolve: immediate null, ONE deduped fill", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let resolverCalls = 0;
        const wrapper = yield* makeCacheFirstRepositoryIdentity({
          resolve: (cwd) =>
            Effect.sync(() => {
              resolverCalls += 1;
            }).pipe(
              // The hung-git shape: stage-1 blocked until the process timeout.
              Effect.andThen(Effect.sleep("60 seconds")),
              Effect.as(identityFor(cwd)),
            ),
        });

        // Both calls answer instantly (virtual clock never advanced) …
        expect(yield* wrapper.resolve("/slow")).toBeNull();
        expect(yield* wrapper.resolve("/slow")).toBeNull();
        // … and fork one fill between them, not two.
        yield* TestClock.adjust("1 millis");
        expect(resolverCalls).toBe(1);

        // Once the real resolver finally answers, the cache serves it.
        yield* TestClock.adjust("60 seconds");
        expect(yield* wrapper.resolve("/slow")).toEqual(identityFor("/slow"));
        expect(resolverCalls).toBe(1);
      }),
    ),
  );

  it.effect("positive TTL: an expired entry serves its stale value while refreshing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let resolverCalls = 0;
        const wrapper = yield* makeCacheFirstRepositoryIdentity(
          {
            resolve: (cwd) =>
              Effect.sync(() => {
                resolverCalls += 1;
              }).pipe(Effect.as(identityFor(cwd))),
          },
          { positiveTtl: "1 minute" },
        );

        expect(yield* wrapper.resolve("/repo")).toBeNull();
        yield* TestClock.adjust("1 millis"); // fill (instant resolver) lands
        expect(yield* wrapper.resolve("/repo")).toEqual(identityFor("/repo"));
        expect(resolverCalls).toBe(1);

        // Past the TTL the entry is expired: the known badge is STILL served
        // (never flickers off) and one refresh is forked.
        yield* TestClock.adjust("2 minutes");
        expect(yield* wrapper.resolve("/repo")).toEqual(identityFor("/repo"));
        yield* TestClock.adjust("1 millis");
        expect(resolverCalls).toBe(2);
      }),
    ),
  );

  it.effect("negative TTL: null is served for its TTL, then re-resolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let resolverCalls = 0;
        const wrapper = yield* makeCacheFirstRepositoryIdentity(
          {
            resolve: () =>
              Effect.sync(() => {
                resolverCalls += 1;
              }).pipe(Effect.as(null)),
          },
          { negativeTtl: "30 seconds" },
        );

        expect(yield* wrapper.resolve("/no-repo")).toBeNull();
        yield* TestClock.adjust("1 millis");
        expect(resolverCalls).toBe(1);

        // Within the negative TTL: served from cache, no new fill.
        expect(yield* wrapper.resolve("/no-repo")).toBeNull();
        yield* TestClock.adjust("1 millis");
        expect(resolverCalls).toBe(1);

        // Past it: one refresh is forked.
        yield* TestClock.adjust("30 seconds");
        expect(yield* wrapper.resolve("/no-repo")).toBeNull();
        yield* TestClock.adjust("1 millis");
        expect(resolverCalls).toBe(2);
      }),
    ),
  );

  it.effect("distinct roots fill independently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resolvedRoots: string[] = [];
        const wrapper = yield* makeCacheFirstRepositoryIdentity({
          resolve: (cwd) =>
            Effect.sync(() => {
              resolvedRoots.push(cwd);
            }).pipe(Effect.as(identityFor(cwd))),
        });

        expect(yield* wrapper.resolve("/a")).toBeNull();
        expect(yield* wrapper.resolve("/b")).toBeNull();
        yield* TestClock.adjust("1 millis");
        expect(resolvedRoots.toSorted()).toEqual(["/a", "/b"]);
        expect(yield* wrapper.resolve("/a")).toEqual(identityFor("/a"));
        expect(yield* wrapper.resolve("/b")).toEqual(identityFor("/b"));
      }),
    ),
  );
});
