// ru-code: write-only pid journal unit coverage (acp-process-pool §4.1) —
// record/remove file contents, and the I-12 contract: a journal write failure
// is swallowed (logged), never failing the recording operation.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { makeQwenProcessJournal } from "../../../qwen/lifecycle/QwenProcessJournal.ts";

// A LOCAL reader schema (deliberately not the source's) — pins the exact
// on-disk shape independently of the implementation's encoder.
const readJournalFile = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ pid: Schema.Number, kind: Schema.String, spawnedAt: Schema.String }),
    ),
  ),
);

const withTempDir = <A>(use: (dir: string) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "qwen-pid-journal-" });
    return yield* use(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie);

describe("QwenProcessJournal", () => {
  it.effect("records spawns and removes teardowns, keeping the file in sync", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const journalPath = `${dir}/qwen-pids.json`;
        const journal = yield* makeQwenProcessJournal({ journalPath });

        yield* journal.record({ pid: 101, kind: "session" });
        yield* journal.record({ pid: 202, kind: "warm" });

        const written = readJournalFile(yield* fs.readFileString(journalPath));
        expect(written).toHaveLength(2);
        expect(written.map((entry) => entry.pid).sort()).toEqual([101, 202]);
        expect(written.find((entry) => entry.pid === 202)?.kind).toBe("warm");
        // spawnedAt is a parseable ISO timestamp.
        for (const entry of written) {
          expect(Number.isNaN(Date.parse(entry.spawnedAt))).toBe(false);
        }

        yield* journal.remove(101);
        const afterRemove = readJournalFile(yield* fs.readFileString(journalPath));
        expect(afterRemove.map((entry) => entry.pid)).toEqual([202]);

        yield* journal.remove(202);
        expect(readJournalFile(yield* fs.readFileString(journalPath))).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
  );

  it.effect("re-recording a pid flips kind ONLY — the original spawnedAt is preserved", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const journalPath = `${dir}/qwen-pids.json`;
        const journal = yield* makeQwenProcessJournal({ journalPath });

        // Warm spawn at t0, taken by a session 1s later (TestClock): a future
        // age-based reaper must see the process's REAL spawn time, not the
        // take time.
        yield* journal.record({ pid: 303, kind: "warm" });
        const atSpawn = readJournalFile(yield* fs.readFileString(journalPath))[0]!.spawnedAt;
        yield* TestClock.adjust("1 second");
        yield* journal.record({ pid: 303, kind: "session" });

        const afterTake = readJournalFile(yield* fs.readFileString(journalPath))[0]!;
        expect(afterTake.kind).toBe("session");
        expect(afterTake.spawnedAt).toBe(atSpawn);
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
  );

  it.effect("removing an unknown pid is a no-op (no file churn, no failure)", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const journalPath = `${dir}/qwen-pids.json`;
        const journal = yield* makeQwenProcessJournal({ journalPath });
        yield* journal.remove(999);
        // Nothing was ever recorded — the file was never even created.
        expect(yield* fs.exists(journalPath)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
  );

  it.effect("a write failure is swallowed — the operation still succeeds (I-12)", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Deterministic unwritable target: the journal's parent "directory"
        // is a regular FILE, so the flush's makeDirectory always fails.
        const blocker = `${dir}/not-a-directory`;
        yield* fs.writeFileString(blocker, "plain file");
        const journal = yield* makeQwenProcessJournal({
          journalPath: `${blocker}/qwen-pids.json`,
        });
        // Must complete without failing despite the impossible write.
        yield* journal.record({ pid: 7, kind: "session" });
        yield* journal.remove(7);
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
  );
});
