// ru-code: the download half of the install run — ACQUIRE the release tarball (an http download, or
// a file the git channel pulled out of the release repo) → verify its
// sha256 → extract into `updates/tmp` → take ONLY the archive's `versions/<v>/` subtree → verify
// EVERY file in it against the embedded `__checksums.json` → land it at `versions/<v>/`. The
// archive's wrapper (`cli.js`) and pointer (`current.json`) are IGNORED here: an update never
// replaces the launcher, only what it points at (a reinstall is what refreshes the launcher). Runs ONLY inside a user-pressed
// install (there is no auto-download in this design); nothing here flips the pointer. Failures are
// a typed taxonomy the engine maps to wire error codes; on ANY failure the partial download /
// extracted tree is deleted (the UI then offers «скачать заново»). Download progress is streamed
// via `onProgress(pct)` — monotonic 0→100.
// Self-contained transport: raw node http/https (basic-auth capable), in-process tar extraction
// (node-tar) — requirements stay FileSystem + Path only.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import * as Tar from "tar";

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DISABLE_SSL,
  RELEASE_SIGNING_PUBLIC_KEY,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
} from "@ru-code/branding";
import type { UpdateFailureCode } from "@t3tools/contracts";

import * as NodeCrypto from "node:crypto";

import { verifySha256 } from "../integrity/sha256.ts";
import { verifyExtractedChecksums } from "./checksums.ts";
import { UPDATES_TMP_RELATIVE, VERSIONS_DIRNAME } from "./gc.ts";

// Every failure carries TWO fields on purpose. `detail` is a human-readable English
// line for `logError` and nothing else. `evidence` is the machine fragment that may
// be shown to the user verbatim (a status, an errno, a path, a sha prefix) — null
// when the code alone says everything. Only `evidence` reaches the wire, which is
// what keeps authored English off a Russian screen (see UpdateErrorWire).

/** Transport failure: connection refused/reset, a dropped stream, or a non-2xx status. */
export class FetchNetworkError extends Data.TaggedError("FetchNetworkError")<{
  readonly detail: string;
  readonly evidence: string | null;
  readonly status: number | null;
  readonly sourceFailureCode: UpdateFailureCode | null;
}> {}

/** The downloaded archive did not match the manifest's sha256. */
export class FetchArchiveIntegrityError extends Data.TaggedError("FetchArchiveIntegrityError")<{
  readonly detail: string;
  readonly evidence: string | null;
}> {}

/** An extracted file is missing or does not match `__checksums.json`. */
export class FetchFileIntegrityError extends Data.TaggedError("FetchFileIntegrityError")<{
  readonly detail: string;
  readonly evidence: string | null;
}> {}

/**
 * The archive did not arrive within {@link UPDATE_DOWNLOAD_TIMEOUT_MS}.
 *
 * Distinct from {@link FetchNetworkError} on purpose: a refused connection and a peer that
 * accepted the request and then went quiet are different problems with different advice, and only
 * one of them used to be detectable at all (node's http.get has no default timeout, and a stalled
 * body emits no event whatsoever). Reaching this error means the transfer was interrupted, not
 * that it failed on its own.
 */
export class FetchTimeoutError extends Data.TaggedError("FetchTimeoutError")<{
  readonly detail: string;
  readonly evidence: string | null;
}> {}

/** The archive could not be extracted, or the extracted tree is missing the entry file. */
export class FetchStructureError extends Data.TaggedError("FetchStructureError")<{
  readonly detail: string;
  readonly evidence: string | null;
}> {}

export type FetchVersionError =
  | FetchNetworkError
  | FetchTimeoutError
  | FetchArchiveIntegrityError
  | FetchFileIntegrityError
  | FetchStructureError;

/** The app entry every valid release payload must carry (also the pointer's entry basename). */
export const VERSION_ENTRY_FILENAME = "cli.js";

const DOWNLOAD_TMP = "download.tgz";
const EXTRACT_TMP = "incoming";

/** Slack over the manifest's declared size before a download is treated as runaway. */
const SIZE_CEILING_MARGIN_BYTES = 1_000_000;

// ── raw node download (memory buffer + basic auth + monotonic progress) ──────────────────────────

const downloadToBuffer = (
  url: string,
  basicAuth: { readonly username: string; readonly password: string } | null,
  onProgress: ((pct: number) => void) | undefined,
  insecureTls: boolean,
  /**
   * The archive size the manifest promised, when it did. The whole response is materialised in
   * memory (and this process is about to fork a second server), so a peer that keeps sending must
   * be stopped — the timeout only bounds a STALL, never a fast hostile or misconfigured feed. The
   * producer writes this field from a `stat` of the very file it packed, so a genuine release can
   * never cross the ceiling; anything that does is not the release we asked for.
   */
  expectedBytes: number | null,
): Effect.Effect<Uint8Array, FetchNetworkError> =>
  Effect.callback<Uint8Array, FetchNetworkError>((resume) => {
    let settled = false;
    const finish = (effect: Effect.Effect<Uint8Array, FetchNetworkError>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const failNet = (detail: string, evidence: string | null, status: number | null = null): void =>
      finish(
        Effect.fail(new FetchNetworkError({ detail, evidence, status, sourceFailureCode: null })),
      );
    /** A node stream/socket error identifies itself with an errno — that IS the evidence. */
    const errno = (error: Error): string | null =>
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? ((error as NodeJS.ErrnoException).code ?? null)
        : null;

    const transport = url.toLowerCase().startsWith("https:") ? NodeHttps : NodeHttp;
    const headers: Record<string, string> =
      basicAuth === null
        ? {}
        : {
            authorization: `Basic ${Buffer.from(
              `${basicAuth.username}:${basicAuth.password}`,
            ).toString("base64")}`,
          };

    // ru-code: certificate verification for THIS request only (see DISABLE_SSL). The option is inert
    // on plain http and is never a process-wide switch.
    const request = transport.get(
      url,
      { headers, rejectUnauthorized: !insecureTls },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          failNet(`server returned ${status}`, `HTTP ${status}`, status);
          return;
        }
        const total = Number(response.headers["content-length"] ?? 0);
        // A margin over the manifest figure, so tar/gzip metadata differences or a re-pack can
        // never fail a legitimate release on an off-by-a-few-bytes comparison.
        const ceiling =
          expectedBytes !== null && expectedBytes > 0
            ? expectedBytes + SIZE_CEILING_MARGIN_BYTES
            : null;
        const chunks: Array<Buffer> = [];
        let received = 0;
        let lastPct = -1;
        let ended = false;

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          received += chunk.length;
          if (ceiling !== null && received > ceiling) {
            request.destroy();
            failNet(
              `the archive exceeded its declared size (${String(received)} > ${String(ceiling)})`,
              `> ${String(Math.round(ceiling / 1e6))} MB`,
            );
            return;
          }
          if (onProgress && total > 0) {
            const pct = Math.min(100, Math.floor((received / total) * 100));
            if (pct > lastPct) {
              lastPct = pct;
              onProgress(pct);
            }
          }
        });
        response.on("end", () => {
          ended = true;
          if (onProgress && lastPct < 100) onProgress(100);
          finish(Effect.succeed(new Uint8Array(Buffer.concat(chunks))));
        });
        response.on("error", (error: Error) => failNet(error.message, errno(error)));
        // Premature socket close before `end` is a dropped download, not a success.
        response.on("close", () => {
          if (!ended) failNet("connection closed before the download completed", null);
        });
        response.on("aborted", () => failNet("connection aborted", null));
      },
    );
    request.on("error", (error: Error) => failNet(error.message, errno(error)));

    // Interruption cleanup — the reason the timeout below is a real stop and not just a message.
    // Without this the socket keeps streaming into `chunks` after the fiber has moved on, so a
    // "timed out" download would go on consuming bandwidth and memory until the peer hung up.
    return Effect.sync(() => {
      request.destroy();
    });
  });

// ── in-process tar extraction ───────────────────────────────────────────────────────────────────

/**
 * Extract with node-tar (pure JS, gzip via node's own zlib) instead of spawning an ambient `tar`.
 * The spawn depended on whatever binary PATH resolved, and that was a real failure class in the
 * field: GNU tar under Git-Bash on Windows reads `C:\…` as a `host:file` remote («Cannot connect
 * to C:»), a desktop-launched Linux app can have no tar/gzip on its process PATH at all, and the
 * child's stderr was discarded — so every one of those environmental failures surfaced as the same
 * generic "not a valid release" with no evidence. In-process extraction behaves identically on
 * every OS, needs no external binary, and its error message IS the evidence.
 *
 * Returns null on success, the error message on failure. node-tar strips absolute paths and
 * `..` members by default, so a hostile archive cannot write outside `destDir` — and the two-way
 * `__checksums.json` verification behind this step still gates everything that landed.
 */
const extractTarball = (tarballPath: string, destDir: string): Effect.Effect<string | null> =>
  Effect.promise(() =>
    Tar.extract({ file: tarballPath, cwd: destDir }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
  );

// ── structural resolution: locate versions/<version> inside the extracted bundle ─────────────────

/**
 * The release tarball IS the installed `bin/` tree (wrapper + pointer + `versions/<v>/`), so an
 * update must take EXACTLY `versions/<version>/` out of it — never the archive root, which carries
 * the frozen wrapper under the same `cli.js` name and would otherwise be landed as the app.
 * The archive root is either the extract dir itself or one directory deep (`package/`), so both
 * are probed; a candidate counts only when it carries the entry file.
 */
const findVersionPayload = (
  extractDir: string,
  version: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const carriesEntry = (dir: string): Effect.Effect<boolean> =>
      fs.exists(path.join(dir, VERSION_ENTRY_FILENAME)).pipe(Effect.orElseSucceed(() => false));

    const atRoot = path.join(extractDir, VERSIONS_DIRNAME, version);
    if (yield* carriesEntry(atRoot)) return atRoot;

    const entries = yield* fs.readDirectory(extractDir).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const nested = path.join(extractDir, entry, VERSIONS_DIRNAME, version);
      if (yield* carriesEntry(nested)) return nested;
    }
    return null;
  });

// ── the fetcher ─────────────────────────────────────────────────────────────────────────────────

export interface FetchedVersion {
  /** `<appRoot>/versions/<version>` — verified, inert, ready for the flip. */
  readonly versionDir: string;
  /** appRoot-relative pointer entry (`versions/<version>/cli.js`). */
  readonly entryRelative: string;
}

/**
 * WHERE the release archive comes from — the ONLY thing that differs between the two channels.
 * Everything after this point (sha256 → extract → structure → per-file checksums → atomic landing)
 * is ONE pipeline both channels run: the git source must not get a weaker verification path than
 * the web source just because its bytes arrived over a different transport.
 *
 * `http` downloads it (with optional basic auth); `file` takes an archive some other step already
 * placed on disk — today the git channel, which pulls the tarball out of the release repo. The file
 * is consumed in place and never moved by this module; the caller owns its lifetime.
 */
export type ArchiveSource =
  | {
      readonly kind: "http";
      readonly url: string;
      readonly basicAuth: { readonly username: string; readonly password: string } | null;
      /** Certificate verification for this download; defaults to the baked DISABLE_SSL. */
      readonly insecureTls?: boolean;
    }
  | { readonly kind: "file"; readonly path: string };

/**
 * Acquire the archive BYTES. The two branches produce exactly the same thing, so the verification
 * pipeline below cannot tell them apart — which is the point. A local read failure is a
 * `FetchNetworkError` (the "could not obtain the archive" slot of the taxonomy, mapped to the
 * `download-failed` wire code) with the path as evidence.
 */
const acquireArchiveBytes = (
  source: ArchiveSource,
  onProgress: ((pct: number) => void) | undefined,
  expectedBytes: number | null,
): Effect.Effect<Uint8Array, FetchNetworkError | FetchTimeoutError, FileSystem.FileSystem> =>
  source.kind === "http"
    ? // The ONE budget on the transfer. `timeoutOrElse` interrupts the download first, which runs
      // the cleanup above and destroys the socket, and only then produces the typed failure — so an
      // expired download stops transferring instead of merely being reported as expired.
      // Only the http branch is bounded here: the `file` branch is a local read of bytes the git
      // channel already fetched under its OWN clone budget, and double-charging it would mean two
      // ceilings on one transfer.
      downloadToBuffer(
        source.url,
        source.basicAuth,
        onProgress,
        source.insecureTls ?? DISABLE_SSL,
        expectedBytes,
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(UPDATE_DOWNLOAD_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new FetchTimeoutError({
                detail: `the download did not complete within ${String(UPDATE_DOWNLOAD_TIMEOUT_MS)}ms`,
                evidence: `${String(Math.round(UPDATE_DOWNLOAD_TIMEOUT_MS / 1000))}s`,
              }),
            ),
        }),
      )
    : Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs.readFile(source.path).pipe(
          Effect.mapError(
            () =>
              new FetchNetworkError({
                detail: `could not read the downloaded archive at ${source.path}`,
                evidence: source.path,
                status: null,
                sourceFailureCode: null,
              }),
          ),
        );
        // The bytes are already local, so the acquire step is done — but the pipeline is not:
        // sha256, extract and per-file verification are still ahead. 99 until they pass; the
        // verify step is what sets 100. The step that PUT them there owns the bar up to here.
        if (onProgress) onProgress(99);
        return bytes;
      });

/**
 * Download + fully verify one release into `versions/<version>`. The work happens in
 * `updates/tmp`; only a COMPLETELY verified tree is renamed into place (same volume → atomic).
 * On any failure everything temporary (and any pre-existing dir for this version) is removed.
 */
export const fetchVersionToDisk = (params: {
  readonly appRoot: string;
  readonly version: string;
  /** Where the archive comes from — an http download, or a file another step landed. */
  readonly source: ArchiveSource;
  readonly expectedSha256: string;
  readonly onProgress?: (pct: number) => void;
  /** The manifest's declared archive size, when it carries one — the download's hard ceiling. */
  readonly expectedBytes?: number | null;
  readonly signature?: string | null;
}): Effect.Effect<FetchedVersion, FetchVersionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const workDir = path.join(params.appRoot, UPDATES_TMP_RELATIVE);
    const tarballPath = path.join(workDir, DOWNLOAD_TMP);
    const extractDir = path.join(workDir, EXTRACT_TMP);
    const versionDir = path.join(params.appRoot, VERSIONS_DIRNAME, params.version);
    const cleanupAll = fs
      .remove(workDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));

    yield* fs.remove(workDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    // A workspace that cannot be created is reported as ITSELF, with the OS error as evidence.
    // This used to be `orElseSucceed(undefined)`: the failure then surfaced two steps later as the
    // extract step's generic sentence with no evidence — blaming the archive for a disk that is
    // full, read-only or root-owned, which is exactly what a user needs told apart.
    const workspaceMade = yield* fs
      .makeDirectory(extractDir, { recursive: true })
      .pipe(Effect.result);
    if (workspaceMade._tag === "Failure") {
      yield* cleanupAll;
      return yield* new FetchStructureError({
        detail: `could not create the update workspace: ${workspaceMade.failure.message}`,
        evidence: workspaceMade.failure.message.slice(0, 200),
      });
    }

    // 1) acquire the archive bytes (http download or a local file the git channel landed).
    const bytes = yield* acquireArchiveBytes(
      params.source,
      params.onProgress,
      params.expectedBytes ?? null,
    ).pipe(Effect.tapError(() => cleanupAll));

    // 2) archive integrity — refuse a mismatch before writing anything durable.
    if (!verifySha256(bytes, params.expectedSha256)) {
      yield* cleanupAll;
      return yield* new FetchArchiveIntegrityError({
        detail: "sha256 verification failed",
        evidence: `sha256 ${params.expectedSha256.slice(0, 12)}…`,
      });
    }

    // 2b) release signature — the manifest's `signature` signs `sha256|version` with the baked
    // ed25519 public key. Old unsigned manifests are accepted (backward compat); a PRESENT but
    // INVALID signature is always rejected.
    const sig = params.signature;
    if (typeof sig === "string" && sig.length > 0) {
      const data = Buffer.from(`${params.expectedSha256}|${params.version}`, "utf8");
      const valid = NodeCrypto.verify(
        null,
        data,
        RELEASE_SIGNING_PUBLIC_KEY,
        Buffer.from(sig, "base64"),
      );
      if (!valid) {
        yield* cleanupAll;
        return yield* new FetchArchiveIntegrityError({
          detail: "release signature verification failed",
          evidence: "invalid signature",
        });
      }
    }

    // 3) extract inside the workspace (never directly into versions/).
    // The staging write's own error is the evidence (same reasoning as the workspace above — a
    // swallowed write surfaced as "could not extract" of a file that was never there).
    const staged = yield* fs.writeFile(tarballPath, bytes).pipe(Effect.result);
    if (staged._tag === "Failure") {
      yield* cleanupAll;
      return yield* new FetchStructureError({
        detail: `could not stage the downloaded archive: ${staged.failure.message}`,
        evidence: staged.failure.message.slice(0, 200),
      });
    }
    const extractError = yield* extractTarball(tarballPath, extractDir);
    if (extractError !== null) {
      yield* cleanupAll;
      return yield* new FetchStructureError({
        detail: `could not extract the archive: ${extractError}`,
        evidence: extractError.slice(0, 200),
      });
    }

    // 4) structure — the archive must carry versions/<version>/cli.js.
    const packageRoot = yield* findVersionPayload(extractDir, params.version);
    if (packageRoot === null) {
      yield* cleanupAll;
      return yield* new FetchStructureError({
        detail: `update is missing ${VERSIONS_DIRNAME}/${params.version}/${VERSION_ENTRY_FILENAME}`,
        evidence: `${VERSIONS_DIRNAME}/${params.version}/${VERSION_ENTRY_FILENAME}`,
      });
    }

    // 5) per-file integrity — every extracted file vs the embedded __checksums.json.
    const verdict = yield* verifyExtractedChecksums(packageRoot);
    if (!verdict.ok) {
      yield* cleanupAll;
      const first = verdict.firstMismatch;
      return yield* new FetchFileIntegrityError({
        detail:
          first === null
            ? "file checksum verification failed"
            : `${first.path}: ${first.reason} (checked ${String(verdict.checked)})`,
        // The offending PATH is the evidence; `reason` is our own wording and stays in the log.
        evidence: first?.path ?? null,
      });
    }

    // 6) land the verified tree at versions/<v> (same volume → atomic replace).
    yield* fs.remove(versionDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs
      .makeDirectory(path.join(params.appRoot, VERSIONS_DIRNAME), { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    // The rename's own error is the evidence. It used to be discarded, so the one failure mode
    // that also destroyed the pre-existing `versions/<v>` (removed just above) reported the least
    // of any branch in this function — a generic sentence with `evidence: null`, on a machine
    // where the cause (a cross-device `updates/` mount, a permission, a Windows handle) is exactly
    // what tells the user what to do.
    const landed = yield* fs.rename(packageRoot, versionDir).pipe(Effect.result);
    yield* cleanupAll;
    if (landed._tag === "Failure") {
      return yield* new FetchStructureError({
        detail: `could not move the package into versions/: ${landed.failure.message}`,
        evidence: landed.failure.message.slice(0, 200),
      });
    }

    return {
      versionDir,
      entryRelative: `${VERSIONS_DIRNAME}/${params.version}/${VERSION_ENTRY_FILENAME}`,
    };
  });
