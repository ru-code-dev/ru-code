/**
 * ru-code: QwenModelDiscoveryStore — per-instance persistence of the models the
 * qwen CLI actually serves, discovered live from two channels:
 *   A. the `session/new` / `session/load` response `models.availableModels[]`
 *      (merged: same-slug rows are kept as stored, missing slugs dropped, new
 *      slugs appended — qwen re-advertises the FULL set every session), and
 *   B. backend model-not-found errors (remove the dead model, add the models
 *      the backend's error prose suggests).
 *
 * Deliberately NOT part of `ServerSettings`: the instance registry tears down
 * and rebuilds a provider instance whenever its settings config changes, which
 * would kill the very ACP session that produced the discovery. This store is a
 * sibling state file (`<stateDir>/qwen-discovered-models.json`) — writes leave
 * instances running and only refresh their snapshots.
 *
 * Once an instance has ≥1 discovered model, its profile built-ins stop being
 * served (see `qwenModelsForSettings`) — discovery is authoritative from the
 * first successful session onward, across restarts, until the file is cleared.
 *
 * @module ru-code/qwen/discovery/QwenModelDiscoveryStore
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../../atomicWrite.ts";
import { ServerConfig } from "../../../config.ts";

/**
 * One discovered model. Mirrors the `ServerProviderModel` fields the qwen
 * snapshot serves so assembly is a plain map, no re-derivation.
 */
export const DiscoveredQwenModel = Schema.Struct({
  slug: Schema.String,
  authMethod: Schema.String,
  name: Schema.String,
  // Absent ⇒ window unknown (meter falls back to the adapter default).
  nTokens: Schema.optionalKey(Schema.Number),
});
export type DiscoveredQwenModel = typeof DiscoveredQwenModel.Type;

// On-disk shape. Tolerant decode: a corrupt/foreign file degrades to an empty
// store (profile models keep serving) instead of failing instance creation.
const PersistedDiscovery = Schema.Struct({
  instances: Schema.Record(
    Schema.String,
    Schema.Struct({
      models: Schema.Array(DiscoveredQwenModel),
      updatedAt: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
type PersistedDiscovery = typeof PersistedDiscovery.Type;

// Decode/encode straight from/to the file's JSON string (no untyped JSON.parse).
const PersistedDiscoveryJson = Schema.fromJsonString(PersistedDiscovery);
const decodePersistedDiscoveryJson = Schema.decodeEffect(PersistedDiscoveryJson);
const encodePersistedDiscoveryJson = Schema.encodeEffect(PersistedDiscoveryJson);

const DISCOVERY_FILE_NAME = "qwen-discovered-models.json";

export interface QwenModelDiscoveryStoreShape {
  /** Discovered models for one instance (empty ⇒ nothing discovered yet). */
  readonly get: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<DiscoveredQwenModel>>;
  /**
   * Channel A: merge a session advertisement into the instance's set. A slug
   * that is already stored KEEPS its stored row untouched (qwen re-derives
   * authType/window from its current config+auth state, so re-advertised
   * metadata flips run-to-run — the stored row is what the user's threads
   * actually dispatch with); slugs missing from the advertisement are
   * dropped; new slugs are appended. An identical catalog — in any order —
   * is therefore a no-op: no file write, no `changes` emission, no snapshot
   * respawn ripple. The empty-list guard lives at the CALL SITE (an empty
   * advertisement means "broken run, keep what we have").
   */
  readonly applyAdvertisement: (
    instanceId: ProviderInstanceId,
    advertisedModels: ReadonlyArray<DiscoveredQwenModel>,
  ) => Effect.Effect<void>;
  /**
   * Channel B: drop one dead model and merge in backend-suggested ones (slugs
   * already present are kept as-is — discovery's window data wins). Returns
   * whether anything actually changed (callers skip the snapshot refresh
   * otherwise).
   */
  readonly applyModelError: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly badModelSlug: string | null;
    readonly suggestedModels: ReadonlyArray<DiscoveredQwenModel>;
  }) => Effect.Effect<boolean>;
  /** Fires the instanceId after every persisted mutation of its set. */
  readonly changes: Stream.Stream<ProviderInstanceId>;
}

export class QwenModelDiscoveryStore extends Context.Service<
  QwenModelDiscoveryStore,
  QwenModelDiscoveryStoreShape
>()("t3/ru-code/qwen/discovery/QwenModelDiscoveryStore") {
  static layer(): Layer.Layer<
    QwenModelDiscoveryStore,
    never,
    FileSystem.FileSystem | Path.Path | ServerConfig
  > {
    return Layer.effect(QwenModelDiscoveryStore, makeQwenModelDiscoveryStore());
  }
}

const sameModelSets = (
  left: ReadonlyArray<DiscoveredQwenModel>,
  right: ReadonlyArray<DiscoveredQwenModel>,
): boolean =>
  left.length === right.length &&
  left.every(
    (model, index) =>
      model.slug === right[index]?.slug &&
      model.authMethod === right[index]?.authMethod &&
      model.name === right[index]?.name &&
      model.nTokens === right[index]?.nTokens,
  );

const makeQwenModelDiscoveryStore = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const filePath = path.join(serverConfig.stateDir, DISCOVERY_FILE_NAME);

  // Hydrate once at layer build; afterwards the Ref is the source of truth and
  // the file is a write-through mirror.
  const hydrated: PersistedDiscovery = yield* Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { instances: {} } satisfies PersistedDiscovery;
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    return yield* decodePersistedDiscoveryJson(raw).pipe(
      Effect.orElseSucceed(() => ({ instances: {} }) satisfies PersistedDiscovery),
    );
  });

  const stateRef = yield* Ref.make<PersistedDiscovery>(hydrated);
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ProviderInstanceId>();

  const persist = (state: PersistedDiscovery) =>
    Effect.flatMap(encodePersistedDiscoveryJson(state), (contents) =>
      writeFileStringAtomically({ filePath, contents }),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("[qwen-model-discovery] persist failed", { filePath, cause }),
      ),
      // Persistence failure keeps the in-memory set live for this run; the
      // next successful write re-mirrors everything.
      Effect.ignore,
      // The shape methods are R=never; bind the layer-time services here.
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const mutate = (
    instanceId: ProviderInstanceId,
    update: (current: ReadonlyArray<DiscoveredQwenModel>) => ReadonlyArray<DiscoveredQwenModel>,
  ): Effect.Effect<boolean> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const current = state.instances[instanceId]?.models ?? [];
        const next = update(current);
        if (sameModelSets(current, next)) return false;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const nextState: PersistedDiscovery = {
          instances: {
            ...state.instances,
            [instanceId]: { models: next, updatedAt },
          },
        };
        yield* Ref.set(stateRef, nextState);
        yield* persist(nextState);
        yield* PubSub.publish(changesPubSub, instanceId);
        return true;
      }),
    );

  return {
    get: (instanceId) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.instances[instanceId]?.models ?? [])),
    applyAdvertisement: (instanceId, advertisedModels) =>
      Effect.asVoid(
        mutate(instanceId, (current) => {
          const currentSlugs = new Set(current.map((model) => model.slug));
          const advertisedSlugs = new Set(advertisedModels.map((model) => model.slug));
          const keptModels = current.filter((model) => advertisedSlugs.has(model.slug));
          const addedModels = advertisedModels.filter((model) => !currentSlugs.has(model.slug));
          return [...keptModels, ...addedModels];
        }),
      ),
    applyModelError: ({ instanceId, badModelSlug, suggestedModels }) =>
      mutate(instanceId, (current) => {
        const withoutBad =
          badModelSlug === null ? current : current.filter((model) => model.slug !== badModelSlug);
        const knownSlugs = new Set(withoutBad.map((model) => model.slug));
        const additions = suggestedModels.filter(
          (model) => model.slug !== badModelSlug && !knownSlugs.has(model.slug),
        );
        return [...withoutBad, ...additions];
      }),
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies QwenModelDiscoveryStoreShape;
});
