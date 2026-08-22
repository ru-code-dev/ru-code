// ru-code: the encrypted credential FILE store. Reads/writes one AES-256-GCM blob at a
// caller-supplied path (the engine passes `<stateDir>/auto-update-credentials.enc`). Writes are
// atomic (temp file + rename) and serialized through a single-permit Semaphore. Secrets live ONLY
// inside the decrypted model: `load` hands them to in-process callers, `presence` exposes redacted
// non-secret metadata for the wire, and no operation ever puts a password or PEM in a log or error.

import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import {
  type CredentialKeySource,
  decryptCredential,
  encryptCredential,
  usernameScryptKeySource,
} from "./credentialCipher.ts";
import {
  type SshKeyOrigin,
  type StoredCredentials,
  type StoredHttpsCredential,
  type StoredSshCredential,
  EMPTY_CREDENTIALS,
  decodeCredentials,
  encodeCredentials,
} from "./credentialModel.ts";

/** Which stored branch to clear: git-https, git-ssh, or the web source's basic auth. */
export type CredentialKind = "https" | "ssh" | "web";

/**
 * Redacted, wire-safe metadata. Deliberately omits the password and the private-key material; the
 * SSH file path is also withheld (only the fingerprint identifies the key).
 */
export interface CredentialFilePresence {
  readonly https: {
    readonly username: string;
    readonly savedAt: number;
  } | null;
  readonly ssh: {
    readonly fingerprint: string;
    readonly origin: SshKeyOrigin;
    readonly keyType: "ed25519";
    readonly savedAt: number;
  } | null;
  readonly web: {
    readonly username: string;
    readonly savedAt: number;
  } | null;
}

/** A write failed. Carries only the neutral operation name — never any secret. */
export class CredentialStoreError extends Data.TaggedError("CredentialStoreError")<{
  readonly operation: "saveHttps" | "saveSsh" | "saveWeb" | "clear";
}> {
  override get message(): string {
    return `credential store operation '${this.operation}' failed`;
  }
}

/** Plaintext HTTPS input (username + password). `savedAt` is stamped by the store. */
export interface SaveHttpsInput {
  readonly username: string;
  readonly password: string;
}

/** SSH key-file metadata input. `savedAt` is stamped by the store. */
export interface SaveSshInput {
  readonly path: string;
  readonly origin: SshKeyOrigin;
  readonly fingerprint: string;
}

export interface CredentialFileStore {
  /** Decrypt + decode the whole model; absent/corrupt file → empty model, never a failure. */
  readonly load: Effect.Effect<StoredCredentials>;
  /** Redacted metadata for the wire; never a failure. */
  readonly presence: Effect.Effect<CredentialFilePresence>;
  readonly saveHttps: (input: SaveHttpsInput) => Effect.Effect<void, CredentialStoreError>;
  readonly saveSsh: (input: SaveSshInput) => Effect.Effect<void, CredentialStoreError>;
  /** Web source basic-auth (same username/password shape as HTTPS git). */
  readonly saveWeb: (input: SaveHttpsInput) => Effect.Effect<void, CredentialStoreError>;
  readonly clear: (kind: CredentialKind) => Effect.Effect<void, CredentialStoreError>;
}

const toHttpsPresence = (https: StoredHttpsCredential | null): CredentialFilePresence["https"] =>
  https === null ? null : { username: https.username, savedAt: https.savedAt };

const toSshPresence = (ssh: StoredSshCredential | null): CredentialFilePresence["ssh"] =>
  ssh === null
    ? null
    : {
        fingerprint: ssh.fingerprint,
        origin: ssh.origin,
        keyType: ssh.keyType,
        savedAt: ssh.savedAt,
      };

/**
 * Build a store bound to `filePath` and a key source (defaults to the username-scrypt obfuscation
 * key). Requires FileSystem + Path; the engine provides both from the Node platform layer.
 */
export const makeCredentialFileStore = (options: {
  readonly filePath: string;
  readonly keySource?: CredentialKeySource | undefined;
}): Effect.Effect<CredentialFileStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const keySource = options.keySource ?? usernameScryptKeySource;
    const filePath = options.filePath;
    const writeLock = yield* Semaphore.make(1);

    const decryptSafe = (bytes: Uint8Array): Uint8Array | null => {
      try {
        return decryptCredential(bytes, keySource);
      } catch {
        return null;
      }
    };

    /**
     * True once this process has read a credential file it could not decrypt. Two things follow
     * from it, and both matter: the failure is LOGGED (it used to be swallowed silently, so
     * credentials disappeared from the UI with no trace anywhere and checks quietly fell back to
     * ambient auth until the source paused), and the next write refuses to overwrite the
     * undecryptable bytes in place — they are the only copy of a secret the user may still be able
     * to recover once the cause is known (a renamed OS account, a roamed profile, one flipped
     * byte: the key derives from the username, so all three are reachable without any tampering).
     */
    let sawUndecryptable = false;

    const load: Effect.Effect<StoredCredentials> = Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return EMPTY_CREDENTIALS;
      const bytes = yield* fs.readFile(filePath).pipe(
        Effect.map((value): Uint8Array | null => value),
        Effect.orElseSucceed(() => null),
      );
      if (bytes === null) {
        yield* Effect.logError("[auto-update] the credential file could not be read", {
          path: filePath,
        });
        return EMPTY_CREDENTIALS;
      }
      const plain = decryptSafe(bytes);
      if (plain === null) {
        sawUndecryptable = true;
        // No secret in this line — only the path and the fact. This zone's rule is that every
        // failure path logs; the one that erases the user's stored credentials cannot be the
        // exception.
        yield* Effect.logError("[auto-update] the credential file could not be decrypted", {
          path: filePath,
          bytes: bytes.byteLength,
        });
        return EMPTY_CREDENTIALS;
      }
      return decodeCredentials(plain);
    });

    // Atomic write: encrypt → write into a scoped temp dir beside the target (same filesystem) →
    // rename over the target → best-effort 0600. The temp dir is removed when the scope closes.
    const writeAll = (next: StoredCredentials): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = path.dirname(filePath);
          yield* fs
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.orElseSucceed(() => undefined));
          const encrypted = encryptCredential(encodeCredentials(next), keySource);
          const tempDirectory = yield* fs.makeTempDirectoryScoped({
            directory,
            prefix: `${path.basename(filePath)}.`,
          });
          const tempPath = path.join(tempDirectory, "credentials.tmp");
          yield* fs.writeFile(tempPath, encrypted, { mode: 0o600 });
          yield* fs.rename(tempPath, filePath);
          yield* fs.chmod(filePath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
        }),
      );

    const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

    const mutate = (
      operation: CredentialStoreError["operation"],
      update: (current: StoredCredentials) => Effect.Effect<StoredCredentials>,
    ): Effect.Effect<void, CredentialStoreError> =>
      writeLock
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* load;
            const next = yield* update(current);
            // `load` returned an EMPTY model because the file would not decrypt, and the write
            // below would replace those bytes with a model built from nothing — destroying the
            // only copy of credentials that may still be recoverable. Preserve them beside the new
            // file instead; best-effort, because failing the save over a backup would be worse
            // than the situation it guards.
            if (sawUndecryptable) {
              sawUndecryptable = false;
              yield* fs
                .rename(filePath, `${filePath}.unreadable`)
                .pipe(Effect.orElseSucceed(() => undefined));
              yield* Effect.logError(
                "[auto-update] kept the undecryptable credential file beside the new one",
                { path: `${filePath}.unreadable` },
              );
            }
            yield* writeAll(next);
          }),
        )
        // Underlying FS errors carry only a path, never the secret; still, remap to a neutral error.
        .pipe(Effect.mapError(() => new CredentialStoreError({ operation })));

    const saveHttps = (input: SaveHttpsInput): Effect.Effect<void, CredentialStoreError> =>
      mutate("saveHttps", (current) =>
        now.pipe(
          Effect.map((savedAt) => ({
            ...current,
            https: { username: input.username, password: input.password, savedAt },
          })),
        ),
      );

    const saveSsh = (input: SaveSshInput): Effect.Effect<void, CredentialStoreError> =>
      mutate("saveSsh", (current) =>
        now.pipe(
          Effect.map((savedAt) => ({
            ...current,
            ssh: {
              path: input.path,
              origin: input.origin,
              fingerprint: input.fingerprint,
              keyType: "ed25519" as const,
              savedAt,
            },
          })),
        ),
      );

    const saveWeb = (input: SaveHttpsInput): Effect.Effect<void, CredentialStoreError> =>
      mutate("saveWeb", (current) =>
        now.pipe(
          Effect.map((savedAt) => ({
            ...current,
            web: { username: input.username, password: input.password, savedAt },
          })),
        ),
      );

    const clear = (kind: CredentialKind): Effect.Effect<void, CredentialStoreError> =>
      mutate("clear", (current) =>
        Effect.succeed(
          kind === "https"
            ? { ...current, https: null }
            : kind === "ssh"
              ? { ...current, ssh: null }
              : { ...current, web: null },
        ),
      );

    const presence: Effect.Effect<CredentialFilePresence> = load.pipe(
      Effect.map((model) => ({
        https: toHttpsPresence(model.https),
        ssh: toSshPresence(model.ssh),
        web: toHttpsPresence(model.web),
      })),
    );

    return { load, presence, saveHttps, saveSsh, saveWeb, clear };
  });
