// ru-code: WRITE-ONLY pid journal (acp-process-pool §2.5). The adapter records
// every ACP child it spawns ({pid, kind, spawnedAt}) and removes entries when
// it observes the child's teardown (scope close). The file exists so a FUTURE
// leftover-cleanup feature can reap children a hard crash (kill -9 of our
// server) orphaned; nothing in this codebase reads it back — no boot sweep, no
// identity checks, no daemon (explicitly out of scope).
//
// Best-effort by contract (I-12): journal I/O failures are logged and NEVER
// fail a spawn, a kill, or shutdown. Writes are serialized and atomic
// (temp + rename) so the file is never observed half-written. Write LATENCY
// rides the caller (a small local-FS append per op); a pathologically hung
// filesystem would stall the recording operation — the same kernel-edge class
// as any state-dir I/O, accepted.

import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../../../atomicWrite.ts";

const QwenProcessJournalEntrySchema = Schema.Struct({
  pid: Schema.Number,
  kind: Schema.Literals(["session", "warm"]),
  spawnedAt: Schema.String,
});
export type QwenProcessJournalEntry = typeof QwenProcessJournalEntrySchema.Type;

// The whole file: a pretty-printed JSON array of entries (schema-encoded).
const encodeJournalFile = Schema.encodeSync(
  fromJsonStringPretty(Schema.Array(QwenProcessJournalEntrySchema)),
);

export interface QwenProcessJournalShape {
  /** Append an entry for a freshly spawned child. Never fails. */
  readonly record: (input: {
    readonly pid: number;
    readonly kind: "session" | "warm";
  }) => Effect.Effect<void>;
  /** Drop the entry for an observed teardown. Never fails. */
  readonly remove: (pid: number) => Effect.Effect<void>;
}

export const makeQwenProcessJournal = (options: {
  readonly journalPath: string;
}): Effect.Effect<QwenProcessJournalShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // In-memory source of truth — the journal is write-only, never read back.
    const entries = new Map<number, QwenProcessJournalEntry>();
    const mutex = yield* Semaphore.make(1);

    const flush = Effect.gen(function* () {
      const contents = encodeJournalFile(Array.from(entries.values()));
      yield* writeFileStringAtomically({ filePath: options.journalPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("[acp-pool] pid-journal: write failed (advisory — continuing)", {
          journalPath: options.journalPath,
          cause,
        }),
      ),
    );

    const record: QwenProcessJournalShape["record"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          // The warm→session re-record (a slot taken by a session) flips
          // `kind` ONLY — the original spawnedAt is the truth a future
          // age-based reaper needs. Any OTHER same-pid record (OS pid reuse
          // after a missed removal) is a NEW process: fresh spawnedAt.
          const existing = entries.get(input.pid);
          const spawnedAt =
            existing !== undefined && existing.kind === "warm" && input.kind === "session"
              ? existing.spawnedAt
              : DateTime.formatIso(yield* DateTime.now);
          entries.set(input.pid, { pid: input.pid, kind: input.kind, spawnedAt });
          yield* flush;
        }),
      );

    const remove: QwenProcessJournalShape["remove"] = (pid) =>
      mutex.withPermit(
        Effect.gen(function* () {
          if (!entries.delete(pid)) return; // unknown pid — nothing to flush
          yield* flush;
        }),
      );

    return { record, remove } satisfies QwenProcessJournalShape;
  });
