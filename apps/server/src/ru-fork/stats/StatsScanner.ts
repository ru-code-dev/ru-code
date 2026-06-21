// ru-fork: the Stats engine. Two clearly-separated operations:
//   getSnapshot — PURE READ: return the stored rows from the DB. Never scans disk,
//                 never parses, never writes. The panel's instant safety-net load.
//   refresh     — the ONLY disk-touching op: scan the projects root, re-parse only
//                 the changed files, save, return. Incremental → cheap on every call.
// One file going wrong (locked/unreadable) is logged and skipped; it never fails the
// refresh or poisons the snapshot. The cache table is the only write target.
import { IsoDateTime, type StatsSession, type StatsSnapshot } from "@t3tools/contracts";
import { StatsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { StatsFileCacheRepository } from "../../persistence/Services/StatsFileCache.ts";
import type { StatsFileCacheRow } from "../../persistence/Services/StatsFileCache.ts";
import { aggregateSession } from "./aggregate.ts";
import { chatsDirFor, resolveProjectsRoot } from "./paths.ts";
import { extractFileTelemetry } from "./telemetry.ts";

export interface StatsScannerShape {
  /** Pure DB read — return the stored sessions. No disk scan, no parse, no writes. */
  readonly getSnapshot: () => Effect.Effect<StatsSnapshot, StatsError>;
  /** Scan disk, re-parse changed files, save, return. The only disk-touching op. */
  readonly refresh: () => Effect.Effect<StatsSnapshot, StatsError>;
}

export class StatsScanner extends Context.Service<StatsScanner, StatsScannerShape>()(
  "@ru-code/ru-code/ru-fork/stats/StatsScanner",
) {}

interface DiskFile {
  readonly filePath: string;
  readonly projectDir: string;
  readonly fileSessionId: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/**
 * Presence + lastSeenAt live in the row's columns (markAbsent flips them without
 * rewriting session_json), so reconcile them onto the stored session at read time.
 * A present row's session is already authoritative and returned as-is.
 */
const reconcilePresence = (row: StatsFileCacheRow): StatsSession =>
  row.present ? row.session : { ...row.session, present: false, lastSeenAt: row.lastSeenAt };

const buildSnapshot = (
  rows: ReadonlyArray<StatsFileCacheRow>,
  when: string,
  scannedFiles: number,
  parsedFiles: number,
): StatsSnapshot => ({
  sessions: rows.map(reconcilePresence),
  generatedAt: IsoDateTime.make(when),
  scannedFiles,
  parsedFiles,
});

const makeStatsScanner = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const cache = yield* StatsFileCacheRepository;

  // The machine-local IANA zone — day/hour buckets use it so "today" means the viewer's
  // local day (server and web run on the same machine ⇒ same zone). `Intl` (not `new
  // Date()`, banned here) reads it without constructing a Date.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Codebase idiom for "now as ISO" — identical to ws.ts:131.
  const nowIso = (): Effect.Effect<string> => Effect.map(DateTime.now, DateTime.formatIso);

  /** Enumerate `<projectsRoot>/<projectDir>/chats/*.jsonl` with stat metadata. */
  const listDiskFiles = (): Effect.Effect<ReadonlyArray<DiskFile>> =>
    Effect.gen(function* () {
      const projectsRoot = resolveProjectsRoot({
        env: process.env,
        cliConfigDir: config.cliConfigDir,
      });
      const rootExists = yield* fileSystem.exists(projectsRoot).pipe(Effect.orElseSucceed(() => false));
      if (!rootExists) return [];
      const projectDirs = yield* fileSystem
        .readDirectory(projectsRoot)
        .pipe(Effect.orElseSucceed(() => []));
      const files: DiskFile[] = [];
      for (const projectDir of projectDirs) {
        const chatsDir = chatsDirFor(projectsRoot, projectDir);
        const chatsExists = yield* fileSystem.exists(chatsDir).pipe(Effect.orElseSucceed(() => false));
        if (!chatsExists) continue;
        const entries = yield* fileSystem.readDirectory(chatsDir).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          const filePath = path.join(chatsDir, entry);
          const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.option);
          if (Option.isNone(fileInfo)) continue;
          files.push({
            filePath,
            projectDir,
            fileSessionId: entry.slice(0, -".jsonl".length),
            // effect/FileSystem File.Info: mtime is Option<Date>, size is Size.
            // Absent mtime → 0 (treated as "oldest", forces a (re)parse).
            mtimeMs: Option.getOrElse(
              Option.map(fileInfo.value.mtime, (modifiedAt) => modifiedAt.getTime()),
              () => 0,
            ),
            sizeBytes: Number(fileInfo.value.size),
          });
        }
      }
      return files;
    });

  // Read a file's text; a read failure (locked/unreadable) is logged at `error` and
  // yields None → the caller skips it, keeping the previously stored row.
  const readText = (file: DiskFile): Effect.Effect<Option.Option<string>> =>
    fileSystem.readFileString(file.filePath).pipe(
      Effect.map(Option.some<string>),
      Effect.catch((error) =>
        Effect.logError("[stats] skipped unreadable file", { file: file.filePath, error }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );

  // Outcome of looking at one changed file during a refresh.
  type ParseOutcome =
    | { readonly kind: "session"; readonly session: StatsSession }
    | { readonly kind: "ghost" } // no api_response → no usage → not a real session
    | { readonly kind: "skip" }; // unreadable → leave any prior row untouched

  const parseFile = (file: DiskFile, when: string): Effect.Effect<ParseOutcome> =>
    readText(file).pipe(
      Effect.map((text): ParseOutcome => {
        if (Option.isNone(text)) return { kind: "skip" };
        const telemetry = extractFileTelemetry(text.value);
        // A session with no successful response (empty file, or only tool_call/api_error)
        // has no tokens and no model — not real usage. Skipped.
        const hasResponse = telemetry.events.some((event) => event.kind === "api_response");
        if (!hasResponse) return { kind: "ghost" };
        return {
          kind: "session",
          session: aggregateSession({
            telemetry,
            projectDir: file.projectDir,
            fileSessionId: file.fileSessionId,
            nowIso: when,
            timeZone,
          }),
        };
      }),
    );

  const getSnapshot = (): Effect.Effect<StatsSnapshot, StatsError> =>
    Effect.gen(function* () {
      const when = yield* nowIso();
      const rows = yield* cache.listAll();
      return buildSnapshot(rows, when, 0, 0);
    }).pipe(
      Effect.tapError((error) => Effect.logError("[stats] getSnapshot read failed", { error })),
      Effect.mapError((cause) => new StatsError({ detail: "Failed to read stats snapshot", cause })),
    );

  const refresh = (): Effect.Effect<StatsSnapshot, StatsError> =>
    Effect.gen(function* () {
      const when = yield* nowIso();
      yield* Effect.logDebug("[stats] refresh start");
      const diskFiles = yield* listDiskFiles();
      const cachedRows = yield* cache.listAll();
      const cachedByPath = new Map(cachedRows.map((row) => [row.filePath, row]));
      const diskPaths = new Set(diskFiles.map((file) => file.filePath));

      let parsedFiles = 0;
      const ghostPaths: string[] = [];
      for (const file of diskFiles) {
        const existing = cachedByPath.get(file.filePath);
        const unchanged =
          existing !== undefined &&
          existing.present &&
          existing.mtimeMs === file.mtimeMs &&
          existing.sizeBytes === file.sizeBytes;
        if (unchanged) continue;
        const outcome = yield* parseFile(file, when);
        if (outcome.kind === "skip") continue; // read failed → keep prior row
        if (outcome.kind === "ghost") {
          ghostPaths.push(file.filePath); // zero-usage session → not stored
          continue;
        }
        yield* cache.upsert({
          filePath: file.filePath,
          mtimeMs: file.mtimeMs,
          sizeBytes: file.sizeBytes,
          present: true,
          lastSeenAt: when,
          session: outcome.session,
        });
        parsedFiles += 1;
      }

      // Drop ghost rows that a prior refresh may have stored (file still on disk, so
      // the retain-after-delete sweep below won't catch them).
      yield* cache.removeByPaths(ghostPaths);

      // Retain-after-delete: rows whose file vanished → present = 0 (kept).
      const vanished = cachedRows
        .filter((row) => row.present && !diskPaths.has(row.filePath))
        .map((row) => row.filePath);
      yield* cache.markAbsent({ filePaths: vanished, lastSeenAt: when });

      const finalRows = yield* cache.listAll();
      yield* Effect.logDebug("[stats] refresh done", {
        scanned: diskFiles.length,
        parsed: parsedFiles,
        ghosts: ghostPaths.length,
        retained: vanished.length,
        total: finalRows.length,
      });
      return buildSnapshot(finalRows, when, diskFiles.length, parsedFiles);
    }).pipe(
      Effect.tapError((error) => Effect.logError("[stats] refresh failed", { error })),
      Effect.mapError((cause) => new StatsError({ detail: "Failed to refresh stats", cause })),
    );

  return { getSnapshot, refresh } satisfies StatsScannerShape;
});

export const StatsScannerLive = Layer.effect(StatsScanner, makeStatsScanner);
