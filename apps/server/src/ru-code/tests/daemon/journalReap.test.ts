// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the journal reaper — the KILL_BY_JOURNAL_PIDS backend that replaces
// signature guessing with exact tracked pids. Driven end-to-end against real
// temp journal files (the app's `qwen-pids.<instanceSlug>.json` shape) and a
// real throwaway process. Contract under test: live journaled pids are killed,
// dead/garbled/absent entries never fail the reap, files are deleted after
// (a reaped journal must not be re-reaped), and multiple instance files merge.

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { reapJournaledChildren } from "@ru-code/daemon/journalReap";
import { isProcessAlive } from "@ru-code/daemon/signal";

import { awaitPidDead, withSleeper, withStubbornSleeper } from "./spawnSleeper.ts";

const journalJson = (pids: ReadonlyArray<number>): string =>
  JSON.stringify(
    pids.map((pid) => ({ pid, kind: "session", spawnedAt: "2026-07-19T10:00:00.000Z" })),
  );

describe("daemon journalReap", () => {
  it.live("kills a live journaled pid and deletes the journal file", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
          const statePath = path.join(root, "server-runtime.json");
          const journalPath = path.join(root, "qwen-pids.qwen.json");
          yield* fileSystem.writeFileString(journalPath, journalJson([pid]));

          yield* reapJournaledChildren(statePath);

          assert.isTrue(yield* awaitPidDead(pid));
          assert.isFalse(yield* fileSystem.exists(journalPath));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("merges pids across multiple instance journals", () =>
    Effect.scoped(
      withSleeper((pidA) =>
        withSleeper((pidB) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(
              path.join(root, "qwen-pids.qwen.json"),
              journalJson([pidA]),
            );
            yield* fileSystem.writeFileString(
              path.join(root, "qwen-pids.custom_fork.json"),
              journalJson([pidB]),
            );

            yield* reapJournaledChildren(statePath);

            assert.isTrue(yield* awaitPidDead(pidA));
            assert.isTrue(yield* awaitPidDead(pidB));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("dead pids and garbled journals never fail; files are still cleaned up", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
      const statePath = path.join(root, "server-runtime.json");
      const stale = path.join(root, "qwen-pids.stale.json");
      const garbled = path.join(root, "qwen-pids.broken.json");
      // 99999999 exceeds any real pid range — guaranteed-dead entry.
      yield* fileSystem.writeFileString(stale, journalJson([99_999_999]));
      yield* fileSystem.writeFileString(garbled, "{ not json at all");

      yield* reapJournaledChildren(statePath);

      assert.isFalse(yield* fileSystem.exists(stale));
      assert.isFalse(yield* fileSystem.exists(garbled));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("no journal files at all is a clean no-op", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
      yield* reapJournaledChildren(path.join(root, "server-runtime.json"));
      // Also: a statePath whose directory does not exist must not fail.
      yield* reapJournaledChildren(path.join(root, "missing-subdir", "server-runtime.json"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "a SIGTERM-ignoring child (fake stuck qwen) survives — its entry is REWRITTEN, not deleted",
    () =>
      Effect.scoped(
        withStubbornSleeper((stubborn) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
            const statePath = path.join(root, "server-runtime.json");
            const journalPath = path.join(root, "qwen-pids.qwen.json");
            yield* fileSystem.writeFileString(journalPath, journalJson([stubborn]));

            yield* reapJournaledChildren(statePath);

            // Default GROUP_KILL_METHOD is SIGTERM_NO_WAIT → the trap wins.
            assert.isTrue(yield* isProcessAlive(stubborn));
            // The survivor stays tracked: file present and still names the pid.
            assert.isTrue(yield* fileSystem.exists(journalPath));
            const contents = yield* fileSystem.readFileString(journalPath);
            assert.include(contents, String(stubborn));
            // The atomic rewrite leaves no temp residue behind.
            assert.isFalse(yield* fileSystem.exists(`${journalPath}.tmp`));
          }),
        ),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("mixed journal: dead entries are dropped, only the survivor is kept", () =>
    Effect.scoped(
      withStubbornSleeper((stubborn) =>
        withSleeper((obedient) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
            const statePath = path.join(root, "server-runtime.json");
            const journalPath = path.join(root, "qwen-pids.qwen.json");
            yield* fileSystem.writeFileString(journalPath, journalJson([stubborn, obedient]));

            yield* reapJournaledChildren(statePath);

            // The obedient child died to SIGTERM; the stubborn one survived.
            assert.isTrue(yield* awaitPidDead(obedient));
            assert.isTrue(yield* isProcessAlive(stubborn));
            const contents = yield* fileSystem.readFileString(journalPath);
            const keptPids = (JSON.parse(contents) as Array<{ pid: number }>).map(
              (entry) => entry.pid,
            );
            assert.deepEqual(keptPids, [stubborn]);
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("force reap: SIGKILL beats the SIGTERM trap — no survivor, file deleted", () =>
    Effect.scoped(
      withStubbornSleeper((stubborn) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
          const statePath = path.join(root, "server-runtime.json");
          const journalPath = path.join(root, "qwen-pids.qwen.json");
          yield* fileSystem.writeFileString(journalPath, journalJson([stubborn]));

          yield* reapJournaledChildren(statePath, { force: true });

          // `stop --force` semantics: the trap cannot save it.
          assert.isTrue(yield* awaitPidDead(stubborn));
          assert.isFalse(yield* fileSystem.exists(journalPath));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not touch a live process that is NOT journaled", () =>
    Effect.scoped(
      withSleeper((journaled) =>
        withSleeper((bystander) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-reap-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(
              path.join(root, "qwen-pids.qwen.json"),
              journalJson([journaled]),
            );

            yield* reapJournaledChildren(statePath);

            assert.isTrue(yield* awaitPidDead(journaled));
            assert.isTrue(yield* isProcessAlive(bystander));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
