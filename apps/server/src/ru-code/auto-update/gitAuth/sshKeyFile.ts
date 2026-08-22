// ru-code: SSH deploy-key FILE lifecycle for git auth. Passphrase-less ed25519 keys only. Three
// operations: write a user-pasted private key to disk, generate a fresh deploy key via ssh-keygen,
// and read the public fingerprint of an existing key. Key files are locked down to owner-only
// (0600 on POSIX; a best-effort icacls on Windows via the injected platform). The private key
// material never appears in a log or error — only paths, fingerprints, and ssh-keygen's own stderr.
// @effect-diagnostics nodeBuiltinImport:off

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ProcessRunner } from "../../../processRunner.ts";

const KEY_COMMENT = "ru-code-update";

/** A key-file operation failed. `detail` holds paths / ssh-keygen stderr only — never key bytes. */
export class SshKeyError extends Data.TaggedError("SshKeyError")<{
  readonly reason: "keygen-unavailable" | "generate-failed" | "read-failed" | "write-failed";
  readonly detail: string;
}> {
  override get message(): string {
    return `ssh key ${this.reason}: ${this.detail}`;
  }
}

export interface GeneratedDeployKey {
  readonly path: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** Extract the `SHA256:…` fingerprint token from `ssh-keygen -lf` output. */
const parseFingerprint = (stdout: string): string | null => {
  const parts = stdout.trim().split(/\s+/);
  return parts.length >= 2 && parts[1] !== undefined && parts[1] !== "" ? parts[1] : null;
};

/** Lock a freshly written key file to owner-only. POSIX 0600; Windows → best-effort icacls. */
const restrictKeyFile = (
  keyPath: string,
): Effect.Effect<void, never, FileSystem.FileSystem | ProcessRunner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const isWindows = (yield* HostProcessPlatform) === "win32";
    if (!isWindows) {
      yield* fs.chmod(keyPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
      return;
    }
    const runner = yield* ProcessRunner;
    const owner = NodeOS.userInfo().username;
    // Best effort: strip inherited ACLs and grant the current user full control only.
    yield* runner
      .run({
        command: "icacls",
        args: [keyPath, "/inheritance:r", "/grant:r", `${owner}:F`],
      })
      .pipe(Effect.ignore);
  });

/**
 * Write a user-pasted private key PEM to `keyPath` at 0600. A trailing newline is ensured so
 * OpenSSH accepts the file.
 */
export const writePastedKey = (
  pem: string,
  keyPath: string,
): Effect.Effect<
  { readonly path: string },
  SshKeyError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const body = pem.endsWith("\n") ? pem : `${pem}\n`;
    yield* fs
      .makeDirectory(path.dirname(keyPath), { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fs
      .writeFileString(keyPath, body, { mode: 0o600 })
      .pipe(Effect.mapError(() => new SshKeyError({ reason: "write-failed", detail: keyPath })));
    yield* restrictKeyFile(keyPath);
    return { path: keyPath };
  });

/**
 * The path a NOT-YET-ACCEPTED key is written to. Both wizard routes that produce a key — generate
 * and paste — write here first, so the key the app is currently authenticating with is untouched
 * until the new one has been tested AND the user has saved.
 *
 * The bug this exists for: `generateDeployKey` removes the target key before running ssh-keygen (it
 * has to; ssh-keygen would otherwise block on an overwrite prompt), and the wizard fires generate on
 * ENTERING the step. Open the wizard, pick «Сгенерировать новый», close it — and the working key
 * was already gone, while the stored fingerprint still described it. Every scheduled check then
 * authenticated with a key the host had never seen, and after two of those the source persisted
 * `paused`. Nothing on screen connected the two.
 */
export const stagingKeyPath = (keyPath: string): string => `${keyPath}.new`;

/**
 * Promote a staged key to the live path — the ONE moment the previous key stops being the one in
 * use. `rename` is atomic within a filesystem, so a reader sees either the old key or the new one,
 * never a partial file. The public half moves with it, because `readPublicInfo` and any later
 * fingerprint read go looking for `<keyPath>.pub`.
 */
export const promoteStagedKey = (
  keyPath: string,
): Effect.Effect<void, SshKeyError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = stagingKeyPath(keyPath);
    yield* fs
      .rename(staged, keyPath)
      .pipe(Effect.mapError(() => new SshKeyError({ reason: "write-failed", detail: staged })));
    // The public half is optional: a pasted key has none, and nothing downstream requires it.
    yield* fs.rename(`${staged}.pub`, `${keyPath}.pub`).pipe(Effect.orElseSucceed(() => undefined));
  });

/** Remove a staged key that was never accepted. Best effort — an orphan is harmless, just untidy. */
export const discardStagedKey = (
  keyPath: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = stagingKeyPath(keyPath);
    yield* fs.remove(staged).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.remove(`${staged}.pub`).pipe(Effect.orElseSucceed(() => undefined));
  });

/** Fingerprint an existing key file via `ssh-keygen -lf`. Typed error if it can't be read. */
export const readPublicInfo = (
  keyPath: string,
): Effect.Effect<{ readonly fingerprint: string }, SshKeyError, ProcessRunner> =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const result = yield* runner.run({ command: "ssh-keygen", args: ["-lf", keyPath] }).pipe(
      Effect.mapError(
        (error) =>
          new SshKeyError({
            reason: error._tag === "ProcessSpawnError" ? "keygen-unavailable" : "read-failed",
            detail: error._tag,
          }),
      ),
    );
    if (result.code !== 0) {
      return yield* new SshKeyError({ reason: "read-failed", detail: result.stderr.trim() });
    }
    const fingerprint = parseFingerprint(result.stdout);
    if (fingerprint === null) {
      return yield* new SshKeyError({ reason: "read-failed", detail: "no fingerprint" });
    }
    return { fingerprint };
  });

/**
 * Generate a fresh passphrase-less ed25519 deploy key at `keyPath` (+`.pub`) via ssh-keygen, then
 * return its public key and fingerprint. Fails cleanly with `keygen-unavailable` when ssh-keygen is
 * not on PATH. Any pre-existing key at the path is removed first so ssh-keygen never blocks on an
 * overwrite prompt.
 */
export const generateDeployKey = (
  keyPath: string,
): Effect.Effect<
  GeneratedDeployKey,
  SshKeyError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner;

    yield* fs
      .makeDirectory(path.dirname(keyPath), { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.remove(keyPath).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.remove(`${keyPath}.pub`).pipe(Effect.orElseSucceed(() => undefined));

    const result = yield* runner
      .run({
        command: "ssh-keygen",
        args: ["-t", "ed25519", "-N", "", "-C", KEY_COMMENT, "-f", keyPath],
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new SshKeyError({
              reason: error._tag === "ProcessSpawnError" ? "keygen-unavailable" : "generate-failed",
              detail: error._tag,
            }),
        ),
      );
    if (result.code !== 0) {
      return yield* new SshKeyError({ reason: "generate-failed", detail: result.stderr.trim() });
    }

    yield* restrictKeyFile(keyPath);

    const publicKey = yield* fs
      .readFileString(`${keyPath}.pub`)
      .pipe(
        Effect.mapError(() => new SshKeyError({ reason: "read-failed", detail: `${keyPath}.pub` })),
      );
    const { fingerprint } = yield* readPublicInfo(keyPath);
    return { path: keyPath, publicKey: publicKey.trim(), fingerprint };
  });
