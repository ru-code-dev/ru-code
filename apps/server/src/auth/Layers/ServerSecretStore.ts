import * as Crypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import { decryptSecret, encryptSecret } from "../secretCrypto.ts";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore.ts";

export const makeServerSecretStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to secure secrets directory ${serverConfig.secretsDir}.`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const isPlatformError = (u: unknown): u is PlatformError.PlatformError =>
    Predicate.isTagged(u, "PlatformError");

  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
      // ru-fork #4: at-rest decryption runs AFTER the read-error catch — a NotFound stays null; a
      // tampered/unwrappable blob becomes a typed SecretStoreError (Effect.try converts the throw).
      Effect.flatMap((bytes) =>
        bytes === null
          ? Effect.succeed(null)
          : Effect.try({
              try: () => decryptSecret(Uint8Array.from(bytes)),
              catch: (cause) =>
                new SecretStoreError({ message: `Failed to decrypt secret ${name}.`, cause }),
            }),
      ),
    );

  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    const encrypted = encryptSecret(value); // ru-fork #4: at-rest encryption
    return Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, encrypted);
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* fileSystem.rename(tempPath, secretPath);
      yield* fileSystem.chmod(secretPath, 0o600);
    }).pipe(
      Effect.catch((cause) =>
        fileSystem.remove(tempPath).pipe(
          Effect.ignore,
          Effect.flatMap(() =>
            Effect.fail(
              new SecretStoreError({
                message: `Failed to persist secret ${name}.`,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  };

  const create: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const encrypted = encryptSecret(value); // ru-fork #4: at-rest encryption
    return Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(encrypted);
        yield* file.sync;
        yield* fileSystem.chmod(secretPath, 0o600);
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to persist secret ${name}.`,
            cause,
          }),
      ),
    );
  };

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap((existing) => {
        if (existing) {
          return Effect.succeed(existing);
        }

        const generated = Crypto.randomBytes(bytes);
        return create(name, generated).pipe(
          Effect.as(Uint8Array.from(generated)),
          Effect.catchTag("SecretStoreError", (error) =>
            isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists"
              ? get(name).pipe(
                  Effect.flatMap((created) =>
                    created !== null
                      ? Effect.succeed(created)
                      : Effect.fail(
                          new SecretStoreError({
                            message: `Failed to read secret ${name} after concurrent creation.`,
                          }),
                        ),
                  ),
                )
              : Effect.fail(error),
          ),
        );
      }),
    );

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to remove secret ${name}.`,
                cause,
              }),
            ),
      ),
    );

  const pruneByPrefix: ServerSecretStoreShape["pruneByPrefix"] = (prefix, keep) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(serverConfig.secretsDir)
        .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
      for (const entry of entries) {
        if (!entry.endsWith(".bin")) {
          continue;
        }
        const name = entry.slice(0, -".bin".length);
        if (!name.startsWith(prefix) || keep.has(name)) {
          continue;
        }
        // ru-fork: best-effort GC. `force` makes an already-gone file a no-op; a real remove failure is
        // logged (not lost) but must NOT abort pruning the remaining orphans, so it's swallowed per file.
        yield* fileSystem.remove(path.join(serverConfig.secretsDir, entry), { force: true }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("mcp secret prune: failed to remove a secret file", { entry, cause }),
          ),
        );
      }
    });

  return {
    get,
    set,
    getOrCreateRandom,
    remove,
    pruneByPrefix,
  } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
