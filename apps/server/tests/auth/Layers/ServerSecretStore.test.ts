import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../../src/config.ts";
import {
  SecretStoreError,
  ServerSecretStore,
} from "../../../src/auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../../src/auth/Layers/ServerSecretStore.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const makeServerSecretStoreLayer = () =>
  Layer.provide(ServerSecretStoreLive, makeServerConfigLayer());

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makePermissionDeniedSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(PermissionDeniedFileSystemLayer),
  );

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRenameFailureSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RenameFailureFileSystemLayer),
  );

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRemoveFailureSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RemoveFailureFileSystemLayer),
  );

const ConcurrentReadMissFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        String(path).endsWith("/session-signing-key.bin")
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeConcurrentCreateSecretStoreLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(ConcurrentReadMissFileSystemLayer),
  );

it.layer(NodeServices.layer)("ServerSecretStoreLive", (it) => {
  it.effect("returns null when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      expect(secret).toBeNull();
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      expect(Array.from(second)).toEqual(Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");

      expect(persisted).not.toBeNull();
      expect(Array.from(first)).toEqual(Array.from(persisted ?? new Uint8Array()));
      expect(Array.from(second)).toEqual(Array.from(persisted ?? new Uint8Array()));
    }).pipe(Effect.provide(makeConcurrentCreateSecretStoreLayer())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const recordingFileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStoreLive.pipe(
            Layer.provide(makeServerConfigLayer()),
            Layer.provideMerge(recordingFileSystemLayer),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      expect(chmodCalls.some((call) => call.mode === 0o700 && call.path.endsWith("/secrets"))).toBe(
        true,
      );
      expect(chmodCalls.filter((call) => call.mode === 0o600).length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to read secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makePermissionDeniedSecretStoreLayer())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to persist secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makeRenameFailureSecretStoreLayer())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to remove secret session-signing-key.");
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
      expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("PermissionDenied");
    }).pipe(Effect.provide(makeRemoveFailureSecretStoreLayer())),
  );

  // ru-fork: pruneByPrefix is the MCP secret GC primitive (gcOrphanedSecrets calls it). Below: its
  // correctness (untested until now), then its error path — which the language-service flagged as a
  // dead `Effect.catch` because the body swallows `remove` failures via `Effect.ignore`.
  it.effect("pruneByPrefix removes orphaned secrets but keeps the keep-set and other prefixes", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;
      yield* secretStore.getOrCreateRandom("mcp-secret-keep", 16);
      yield* secretStore.getOrCreateRandom("mcp-secret-orphan", 16);
      yield* secretStore.getOrCreateRandom("other-prefix-survivor", 16);

      yield* secretStore.pruneByPrefix("mcp-secret-", new Set(["mcp-secret-keep"]));

      expect(yield* secretStore.get("mcp-secret-orphan")).toBeNull(); // pruned
      expect(yield* secretStore.get("mcp-secret-keep")).not.toBeNull(); // in keep-set
      expect(yield* secretStore.get("other-prefix-survivor")).not.toBeNull(); // different prefix
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("pruneByPrefix logs (and does not fail) when a secret file cannot be removed", () => {
    const captured: Array<{ readonly level: string; readonly message: string }> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      captured.push({ level: String(logLevel), message: String(message) });
    });
    return Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;
      yield* secretStore.getOrCreateRandom("mcp-secret-stuck", 16); // write ok (only `remove` fails)

      // Best-effort: pruning must SUCCEED even though a remove fails (it must not crash the caller)...
      yield* secretStore.pruneByPrefix("mcp-secret-", new Set());

      // ...AND the failure must be observable at debug level. Current code swallows it silently via
      // `Effect.ignore` ⇒ no log ⇒ this is RED until the swallow becomes a logDebug.
      const debugLog = captured.find(
        (entry) =>
          entry.level.toUpperCase().includes("DEBUG") && entry.message.toLowerCase().includes("remove"),
      );
      expect(debugLog).toBeDefined();
    }).pipe(
      Effect.provide(makeRemoveFailureSecretStoreLayer()),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provide(Layer.succeed(References.MinimumLogLevel, "Debug")),
    );
  });
});
