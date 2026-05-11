// ru-fork: generic cached filesystem scanner — owns the state
// machine AND the cache codec, parameterized over an item schema.
//
// 1:1 logic port of:
//   - skills/SkillScannerLive.ts (state machine, background warm-up)
//   - skills/skillsCacheFile.ts   (cache JSON codec, atomic write)
//
// Only renames vs original:
//   - JSON top-level key `global` → `user`     (matches cli-code's level)
//   - JSON per-entry  key `skills` → `items`   (generic item array)
// In-memory state field names follow the JSON renames. Per-feature
// wrappers (e.g. skills/SkillScannerLive.ts) translate back to their
// public API field names for wire compatibility.
//
// No explicit return type on `makeCachedFsScanner` — TS infers it.
// When called with a concrete item schema whose
// `DecodingServices`/`EncodingServices` are `never` (the normal case
// for content-addressable contract schemas), the inferred requirements
// channel collapses to `FileSystem | Path | Scope`, which is exactly
// what `Layer.effect` expects.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

import { STALE_AFTER } from "./constants.ts";

// ─── State + result types (generic over the item type T) ──────────

export interface RootEntry<T> {
  readonly items: ReadonlyArray<T>;
  readonly scannedAt: number;
}

export interface CachedFsState<T> {
  readonly user: RootEntry<T> | undefined;
  readonly byCwd: ReadonlyMap<string, RootEntry<T>>;
}

export interface ScanResult<T> {
  readonly user: ReadonlyArray<T>;
  readonly project: ReadonlyArray<T>;
}

export interface CachedFsScannerShape<T> {
  readonly getForCwd: (
    cwd: string | null,
  ) => Effect.Effect<ScanResult<T>, never, FileSystem.FileSystem | Path.Path>;
  readonly refreshForCwd: (
    cwd: string | null,
  ) => Effect.Effect<ScanResult<T>, never, FileSystem.FileSystem | Path.Path>;
}

export const emptyCachedFsState = <T>(): CachedFsState<T> => ({
  user: undefined,
  byCwd: new Map(),
});

// Module-scope helpers — pure, no closure capture, matching the
// original `skills/SkillScannerLive.ts` structure.
const isStale = <T>(entry: RootEntry<T> | undefined, now: number): boolean => {
  if (entry === undefined) return true;
  return now - entry.scannedAt > Duration.toMillis(STALE_AFTER);
};

const project = <T>(state: CachedFsState<T>, cwd: string | null): ScanResult<T> => ({
  user: state.user?.items ?? [],
  project: cwd !== null ? (state.byCwd.get(cwd)?.items ?? []) : [],
});

// ─── Config (generic over the item schema S) ──────────────────────

export interface CachedFsScannerConfig<S extends Schema.Codec<unknown, unknown, never, never>> {
  /** absolute path to the JSON cache file */
  readonly cachePath: string;
  /** Schema describing a single item; used to build the cache file codec */
  readonly itemSchema: S;
  /** scan the user-level root (e.g. ~/.qwen/skills/ or ~/.qwen/agents/) */
  readonly scanUser: (
    now: number,
  ) => Effect.Effect<RootEntry<S["Type"]>, never, FileSystem.FileSystem | Path.Path>;
  /** scan the project-level root (e.g. <cwd>/.qwen/skills/) */
  readonly scanProject: (
    cwd: string,
    now: number,
  ) => Effect.Effect<RootEntry<S["Type"]>, never, FileSystem.FileSystem | Path.Path>;
  /** prefix for warning logs — e.g. `[ru-fork-skills]` */
  readonly logTag: string;
}

// ─── Factory ──────────────────────────────────────────────────────

export const makeCachedFsScanner = <S extends Schema.Codec<unknown, unknown, never, never>>(
  config: CachedFsScannerConfig<S>,
) =>
  Effect.gen(function* () {
    // Local alias so the body reads naturally; T is the decoded item type.
    type T = S["Type"];

    // ── Cache codec — same schema shape as original skillsCacheFile.ts,
    //    with the two JSON key renames documented at the top of this file.
    const RootEntrySchema = Schema.Struct({
      items: Schema.Array(config.itemSchema),
      scannedAt: Schema.Number,
    });
    const CacheFileSchema = Schema.Struct({
      user: Schema.optional(RootEntrySchema),
      // `Schema.Record(key, value)` is positional + `withDecodingDefault`
      // takes an Effect (not a thunk) — both gotchas documented in the
      // skills shipping doc as pitfalls #2 and #3.
      byCwd: Schema.Record(Schema.String, RootEntrySchema).pipe(
        Schema.withDecodingDefault(Effect.succeed({})),
      ),
    });
    const CacheFileJson = fromJsonStringPretty(CacheFileSchema);
    const decodeCacheFile = Schema.decodeUnknownEffect(CacheFileJson);
    const encodeCacheFile = Schema.encodeUnknownEffect(CacheFileJson);

    // ── 1:1 port of skills/SkillScannerLive.ts logic ──────────────

    const ref = yield* SynchronizedRef.make<CachedFsState<T>>(emptyCachedFsState<T>());

    // 1. Hydrate from disk so reads return non-empty before first scan.
    //    Inlined from skillsCacheFile.ts:readSkillsCache.
    const hydrated: CachedFsState<T> = yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(config.cachePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return emptyCachedFsState<T>();
      }
      const raw = yield* fs.readFileString(config.cachePath).pipe(Effect.orElseSucceed(() => ""));
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return emptyCachedFsState<T>();
      }
      const decoded = yield* decodeCacheFile(trimmed).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        return emptyCachedFsState<T>();
      }
      return {
        user: decoded.value.user,
        byCwd: new Map(Object.entries(decoded.value.byCwd)),
      };
    });
    yield* SynchronizedRef.set(ref, hydrated);

    // Inlined from skillsCacheFile.ts:writeSkillsCache.
    const persist = (state: CachedFsState<T>) =>
      Effect.gen(function* () {
        const payload = {
          ...(state.user ? { user: state.user } : {}),
          byCwd: Object.fromEntries(state.byCwd),
        };
        const contents = yield* encodeCacheFile(payload);
        yield* writeFileStringAtomically({
          filePath: config.cachePath,
          contents: `${contents}\n`,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`${config.logTag} cache write failed`, {
            filePath: config.cachePath,
            cause,
          }),
        ),
      );

    const upsert = (
      next: Partial<{ user: RootEntry<T>; project: { cwd: string; entry: RootEntry<T> } }>,
    ): Effect.Effect<CachedFsState<T>> =>
      SynchronizedRef.updateAndGet(ref, (current) => {
        const updated: CachedFsState<T> = {
          user: next.user ?? current.user,
          byCwd: next.project
            ? new Map(current.byCwd).set(next.project.cwd, next.project.entry)
            : current.byCwd,
        };
        return updated;
      });

    const getForCwd: CachedFsScannerShape<T>["getForCwd"] = (cwd) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* SynchronizedRef.get(ref);

        const userNeedsScan = isStale(current.user, now);
        const projectNeedsScan = cwd !== null && isStale(current.byCwd.get(cwd), now);

        if (!userNeedsScan && !projectNeedsScan) {
          return project(current, cwd);
        }

        const userNext: RootEntry<T> | undefined = userNeedsScan
          ? yield* config
              .scanUser(now)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`${config.logTag} scan failed`, { cause }).pipe(
                    Effect.as<RootEntry<T> | undefined>(undefined),
                  ),
                ),
              )
          : undefined;
        const projectNext: { cwd: string; entry: RootEntry<T> } | undefined =
          projectNeedsScan && cwd !== null
            ? yield* config.scanProject(cwd, now).pipe(
                Effect.map((entry) => ({ cwd, entry })),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`${config.logTag} scan failed`, { cause }).pipe(
                    Effect.as<{ cwd: string; entry: RootEntry<T> } | undefined>(undefined),
                  ),
                ),
              )
            : undefined;

        const updated = yield* upsert({
          ...(userNext ? { user: userNext } : {}),
          ...(projectNext ? { project: projectNext } : {}),
        });
        yield* persist(updated);
        return project(updated, cwd);
      });

    const refreshForCwd: CachedFsScannerShape<T>["refreshForCwd"] = (cwd) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const userNext: RootEntry<T> = yield* config
          .scanUser(now)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`${config.logTag} refresh failed`, { cause }).pipe(
                Effect.as<RootEntry<T>>({ items: [], scannedAt: now }),
              ),
            ),
          );
        const projectNext: { cwd: string; entry: RootEntry<T> } | undefined =
          cwd !== null
            ? yield* config.scanProject(cwd, now).pipe(
                Effect.map((entry) => ({ cwd, entry })),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`${config.logTag} refresh failed`, { cause }).pipe(
                    Effect.as<{ cwd: string; entry: RootEntry<T> } | undefined>(undefined),
                  ),
                ),
              )
            : undefined;
        const updated = yield* upsert({
          user: userNext,
          ...(projectNext ? { project: projectNext } : {}),
        });
        yield* persist(updated);
        return project(updated, cwd);
      });

    // 2. Background warm-up: fresh user-level scan replaces cached value.
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = yield* config.scanUser(now);
      const updated = yield* upsert({ user: entry });
      yield* persist(updated);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${config.logTag} boot scan failed`, { cause }),
      ),
      Effect.forkScoped,
    );

    return {
      getForCwd,
      refreshForCwd,
    } satisfies CachedFsScannerShape<T>;
  });
