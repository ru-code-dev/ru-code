// ru-code: server-side verification of the per-file checksums manifest a release payload carries
// (`__checksums.json`, written by scripts/ru-code/releaseManifest.ts at prepare-release time, at
// the root of the VERSION PAYLOAD — `package/versions/<v>/`, not the archive root). The tarball's
// own sha256 already proved the ARCHIVE arrived intact; this proves every EXTRACTED file matches
// what the release build hashed — the "only corruption can break us" gate the user demanded,
// enforced at the moment it matters (right before the pointer flip).
//
// Verification is TWO-WAY, and it has to be. Checking only the listed files proves "everything the
// build hashed is intact" and says nothing about a file that is present but unlisted — so an added
// file passed unexamined, in the one gate that stands between an unauthenticated download (the
// shipped web URL is plain http and DISABLE_SSL is on) and the pointer flip. The tree is therefore
// walked as well, and any file the manifest does not list is a failure. The two sides enumerate
// identically by construction: the producer lists every regular file under the payload root except
// the manifest itself (`listFilesRecursive`), and so does the walk below — symlinks and empty
// directories are ignored on both sides, so a genuine release can never fail this.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Must match scripts/ru-code/releaseManifest.ts `CHECKSUMS_FILENAME`. */
export const CHECKSUMS_FILENAME = "__checksums.json";

export interface ChecksumsVerdict {
  readonly ok: boolean;
  /** files checked (0 when the manifest itself is missing/corrupt). */
  readonly checked: number;
  /**
   * First problem found, for the error surface. `missing` — the manifest lists it and it is not
   * there (or is unreadable); `mismatch` — it is there and its bytes differ; `unlisted` — it is
   * there and the manifest does not know about it, which no genuine release payload can contain.
   */
  readonly firstMismatch: {
    readonly path: string;
    readonly reason: "missing" | "mismatch" | "unlisted";
  } | null;
}

/**
 * A file the ARCHIVER created, not the release. bsdtar (the `tar` on macOS) writes an AppleDouble
 * `._<name>` companion for any member carrying an extended attribute, and those extract as real
 * files on the installing machine — AFTER the producer computed its checksums from the staging
 * tree, so the manifest cannot possibly list them.
 *
 * `prepare-release` now packs under `COPYFILE_DISABLE=1` so they are not emitted at all; this is the
 * second half of the same fix, because a release built before that change (or by any other tool that
 * behaves this way) must still install. Narrow on purpose: `._` sidecars carry xattr blobs and are
 * never loaded by anything, so skipping exactly them costs no integrity — every real file still has
 * to be listed and still has to match.
 */
const isArchiveSidecar = (name: string): boolean => name.startsWith("._");

/**
 * Every regular file under `rootDir`, POSIX-relative, EXCLUDING the manifest itself and any archiver
 * sidecar — the counterpart of the producer's `listFilesRecursive`. Directories are recursed;
 * anything that is neither a regular file nor a directory (a symlink, a socket) is skipped, because
 * the producer skips it too and a rule the two sides do not share would fail honest releases.
 *
 * Returns null if the tree cannot be read at all, which the caller reports as a structural failure
 * rather than silently treating as "no extra files".
 */
const listPayloadFiles = (rootDir: string): ReadonlyArray<string> | null => {
  const found: Array<string> = [];
  const walk = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of NodeFS.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = NodePath.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (relativePath === CHECKSUMS_FILENAME) continue;
        if (isArchiveSidecar(entry.name)) continue;
        found.push(relativePath);
      }
    }
  };
  try {
    walk(rootDir, "");
  } catch {
    return null;
  }
  return found.sort();
};

const streamFileSha256 = (filePath: string): Effect.Effect<string | null> =>
  Effect.callback<string | null>((resume) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filePath);
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => settle(hash.digest("hex")));
    stream.on("error", () => settle(null));
    return Effect.sync(() => stream.destroy());
  });

/**
 * Verify the extracted payload against `<rootDir>/__checksums.json`, BOTH WAYS: every listed file
 * matches its recorded sha256, and the tree contains nothing the manifest does not list.
 * A missing or unparseable checksums manifest is itself a failure (the release build always
 * writes one — its absence means the payload is not a v2 release or was tampered with).
 */
export const verifyExtractedChecksums = (
  rootDir: string,
): Effect.Effect<ChecksumsVerdict, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(rootDir, CHECKSUMS_FILENAME);
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => null));
    if (raw === null) {
      return {
        ok: false,
        checked: 0,
        firstMismatch: { path: CHECKSUMS_FILENAME, reason: "missing" as const },
      };
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    const files =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["files"] === "object" &&
      (parsed as Record<string, unknown>)["files"] !== null
        ? ((parsed as Record<string, unknown>)["files"] as Record<string, unknown>)
        : null;
    if (files === null) {
      return {
        ok: false,
        checked: 0,
        firstMismatch: { path: CHECKSUMS_FILENAME, reason: "mismatch" as const },
      };
    }
    // Sorted so the reported first mismatch is deterministic.
    const paths = Object.keys(files).sort();

    // The direction the listed-file loop cannot see: a file that IS there and is NOT listed.
    const present = yield* Effect.sync(() => listPayloadFiles(rootDir));
    if (present === null) {
      return {
        ok: false,
        checked: 0,
        firstMismatch: { path: "", reason: "missing" as const },
      };
    }
    const listed = new Set(paths);
    const unlisted = present.find((relative) => !listed.has(relative));
    if (unlisted !== undefined) {
      return { ok: false, checked: 0, firstMismatch: { path: unlisted, reason: "unlisted" } };
    }

    let checked = 0;
    for (const relative of paths) {
      const expected = files[relative];
      if (typeof expected !== "string") {
        return {
          ok: false,
          checked,
          firstMismatch: { path: relative, reason: "mismatch" as const },
        };
      }
      const actual = yield* streamFileSha256(path.join(rootDir, relative));
      checked += 1;
      if (actual === null) {
        return {
          ok: false,
          checked,
          firstMismatch: { path: relative, reason: "missing" as const },
        };
      }
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        return {
          ok: false,
          checked,
          firstMismatch: { path: relative, reason: "mismatch" as const },
        };
      }
    }
    return { ok: true, checked, firstMismatch: null };
  });
