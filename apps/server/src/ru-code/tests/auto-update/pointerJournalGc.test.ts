// ru-code: the pointer/journal/GC trio of the new apply design. Real temp dirs. Covers: pointer
// write→read round-trip + atomicity artifacts (no tmp left behind) + corruption → null; journal
// round-trip + boot reconcile (started→ok on version match, started→failed/not-applied on
// mismatch, ok/failed untouched) + wire projection; GC keep-list discipline (empty keep-list
// deletes nothing, keep survives, tmp workspace wiped).
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  collectVersionGarbage,
  UPDATES_TMP_RELATIVE,
  VERSIONS_DIRNAME,
} from "../../auto-update/apply/gc.ts";
import {
  JOURNAL_RELATIVE_PATH,
  JOURNAL_SCHEMA,
  journalToWire,
  readJournal,
  reconcileJournalAtBoot,
  writeJournal,
  type ApplyJournal,
} from "../../auto-update/apply/journal.ts";
import {
  makePointer,
  POINTER_FILENAME,
  readPointer,
  writePointer,
} from "../../auto-update/apply/pointer.ts";

const makeAppRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ prefix });
  });

const startedJournal: ApplyJournal = {
  schema: JOURNAL_SCHEMA,
  targetVersion: "1.4.2",
  fromVersion: "1.4.1",
  outcome: "started",
  reasonCode: null,
  at: 1_000,
};

it.layer(NodeServices.layer)("pointer", (it) => {
  it.effect("writes then reads back, leaving no tmp artifact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("pointer-rt-");
      const pointer = makePointer("1.4.2", "versions/1.4.2/cli.js");
      yield* writePointer(appRoot, pointer);
      assert.deepStrictEqual(yield* readPointer(appRoot), pointer);
      const tmpExists = yield* fs
        .exists(path.join(appRoot, `${POINTER_FILENAME}.tmp`))
        .pipe(Effect.orElseSucceed(() => true));
      assert.isFalse(tmpExists);
    }),
  );

  it.effect("missing and corrupt pointers both read as null", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("pointer-bad-");
      assert.isNull(yield* readPointer(appRoot));
      yield* fs.writeFileString(path.join(appRoot, POINTER_FILENAME), "{ not json");
      assert.isNull(yield* readPointer(appRoot));
      yield* fs.writeFileString(
        path.join(appRoot, POINTER_FILENAME),
        JSON.stringify({ schema: 99, version: "1", entry: "e" }),
      );
      assert.isNull(yield* readPointer(appRoot));
    }),
  );

  it.effect("re-writing the same pointer is a harmless no-op (double-apply shape)", () =>
    Effect.gen(function* () {
      const appRoot = yield* makeAppRoot("pointer-idem-");
      const pointer = makePointer("2.0.0", "versions/2.0.0/cli.js");
      yield* writePointer(appRoot, pointer);
      yield* writePointer(appRoot, pointer);
      assert.deepStrictEqual(yield* readPointer(appRoot), pointer);
    }),
  );
});

it.layer(NodeServices.layer)("journal", (it) => {
  it.effect("round-trips; missing/corrupt read as null", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("journal-rt-");
      assert.isNull(yield* readJournal(appRoot));
      yield* writeJournal(appRoot, startedJournal);
      assert.deepStrictEqual(yield* readJournal(appRoot), startedJournal);
      yield* fs.writeFileString(path.join(appRoot, JOURNAL_RELATIVE_PATH), "garbage");
      assert.isNull(yield* readJournal(appRoot));
    }),
  );

  it.effect("boot reconcile promotes started→ok when the booted version IS the target", () =>
    Effect.gen(function* () {
      const appRoot = yield* makeAppRoot("journal-ok-");
      yield* writeJournal(appRoot, startedJournal);
      const promoted = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "1.4.2",
        now: 2_000,
      });
      assert.strictEqual(promoted?.outcome, "ok");
      assert.strictEqual(promoted?.reasonCode, null);
      assert.strictEqual(promoted?.at, 2_000);
      // Persisted, not just returned.
      assert.strictEqual((yield* readJournal(appRoot))?.outcome, "ok");
    }),
  );

  it.effect("boot reconcile promotes started→failed/not-applied on version mismatch", () =>
    Effect.gen(function* () {
      const appRoot = yield* makeAppRoot("journal-fail-");
      yield* writeJournal(appRoot, startedJournal);
      const promoted = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "1.4.1",
        now: 2_000,
      });
      assert.strictEqual(promoted?.outcome, "failed");
      assert.strictEqual(promoted?.reasonCode, "not-applied");
    }),
  );

  it.effect("boot reconcile leaves a GENUINE terminal failure untouched", () =>
    Effect.gen(function* () {
      const appRoot = yield* makeAppRoot("journal-term-");
      const failed: ApplyJournal = {
        ...startedJournal,
        outcome: "failed",
        reasonCode: "spawn-failed",
      };
      yield* writeJournal(appRoot, failed);
      // A DIFFERENT version is running, so the record describes something that really did fail.
      const result = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "1.4.1",
        now: 9_000,
      });
      assert.deepStrictEqual(result, failed);
    }),
  );

  // The counterpart: a `failed` record whose target IS the running version cannot describe a real
  // failure — the machine is executing the very version it calls unapplied. It is what a port-busy
  // relaunch leaves behind, and it used to survive for ever: /healthz and the settings card
  // reported a FAILED update that had landed, and the boot GC (gated on `ok`) never ran.
  it.effect("boot reconcile corrects a `failed` record for the version that IS running", () =>
    Effect.gen(function* () {
      const appRoot = yield* makeAppRoot("journal-corrected-");
      yield* writeJournal(appRoot, {
        ...startedJournal,
        outcome: "failed",
        reasonCode: "port-busy",
      });
      const result = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "1.4.2",
        now: 9_000,
      });
      assert.strictEqual(result?.outcome, "ok");
      assert.strictEqual(result?.reasonCode, null);
    }),
  );

  it.effect("wire projection: started → null, terminal → LastApplyWire", () =>
    Effect.sync(() => {
      assert.isNull(journalToWire(null));
      assert.isNull(journalToWire(startedJournal));
      const wire = journalToWire({ ...startedJournal, outcome: "failed", reasonCode: "port-busy" });
      assert.deepStrictEqual(wire, {
        targetVersion: "1.4.2",
        fromVersion: "1.4.1",
        outcome: "failed",
        reasonCode: "port-busy",
        at: 1_000,
      });
    }),
  );
});

it.layer(NodeServices.layer)("gc", (it) => {
  it.effect("removes everything outside the keep-list and wipes updates/tmp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("gc-keep-");
      for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
        yield* fs.makeDirectory(path.join(appRoot, VERSIONS_DIRNAME, version), {
          recursive: true,
        });
      }
      yield* fs.makeDirectory(path.join(appRoot, UPDATES_TMP_RELATIVE), { recursive: true });
      yield* collectVersionGarbage({ appRoot, keepVersions: ["1.2.0"] });
      const remaining = yield* fs.readDirectory(path.join(appRoot, VERSIONS_DIRNAME));
      assert.deepStrictEqual(remaining, ["1.2.0"]);
      const tmpExists = yield* fs
        .exists(path.join(appRoot, UPDATES_TMP_RELATIVE))
        .pipe(Effect.orElseSucceed(() => true));
      assert.isFalse(tmpExists);
    }),
  );

  it.effect("refuses an empty keep-list (deletes nothing)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("gc-empty-");
      yield* fs.makeDirectory(path.join(appRoot, VERSIONS_DIRNAME, "1.0.0"), { recursive: true });
      yield* collectVersionGarbage({ appRoot, keepVersions: [] });
      const remaining = yield* fs.readDirectory(path.join(appRoot, VERSIONS_DIRNAME));
      assert.deepStrictEqual(remaining, ["1.0.0"]);
    }),
  );

  it.effect("tolerates a missing versions dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* makeAppRoot("gc-missing-");
      // The claim is "does not fail", so the assertion is on the RESULT of running it — an
      // `assert.isTrue(true)` proved only that the line above had not thrown, which is a weaker
      // statement than it looks (a defect would have failed the effect, not the assertion).
      const outcome = yield* collectVersionGarbage({ appRoot, keepVersions: ["1.0.0"] }).pipe(
        Effect.result,
      );
      assert.strictEqual(outcome._tag, "Success");
      // …and it created nothing on its way through.
      assert.isFalse(yield* fs.exists(path.join(appRoot, VERSIONS_DIRNAME)));
    }),
  );
});
