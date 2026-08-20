// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the shared kill routine behind both `stop` and the launcher's reclaim
// path. The production-critical contract is the RETURN value — "confirmed dead" —
// which `stop` now keys its honest success/failure (and exit code) off of. We prove
// it against a real process on the posix path (graceful SIGTERM, forced SIGKILL,
// already-dead), and that terminateInstance reports confirmed-dead. The Windows
// taskkill-blocked `false` branch is validated manually (no policy-blocked pid here).

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isProcessAlive } from "@ru-code/daemon/signal";
import { terminateInstance, terminateProcessGracefully } from "@ru-code/daemon/terminate";

import { awaitPidDead, withSleeper } from "./spawnSleeper.ts";

describe("daemon terminate (graceful kill + confirmed-dead)", () => {
  it.live("terminateProcessGracefully confirms death of a live process (SIGTERM path)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          assert.isTrue(yield* isProcessAlive(pid));
          assert.isTrue(yield* terminateProcessGracefully(pid));
          assert.isFalse(yield* isProcessAlive(pid));
        }),
      ),
    ),
  );

  it.live("terminateProcessGracefully with force confirms death (SIGKILL path)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          assert.isTrue(yield* terminateProcessGracefully(pid, { force: true }));
          assert.isFalse(yield* isProcessAlive(pid));
        }),
      ),
    ),
  );

  it.live("terminateProcessGracefully on an already-dead pid reports dead", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          yield* terminateProcessGracefully(pid, { force: true });
          yield* awaitPidDead(pid);
          assert.isTrue(yield* terminateProcessGracefully(pid));
        }),
      ),
    ),
  );

  it.live("terminateInstance returns confirmed-dead for a real process (posix path)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "ru-code-daemon-terminate-",
          });
          // No qwen-pids.*.json in the temp dir — child cleanup is a clean no-op.
          const statePath = path.join(root, "server-runtime.json");
          assert.isTrue(yield* terminateInstance({ pid, statePath }));
          assert.isFalse(yield* isProcessAlive(pid));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("terminateInstance kills the server AND reaps its journaled children", () =>
    Effect.scoped(
      withSleeper((serverPid) =>
        withSleeper((childPid) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "ru-code-daemon-terminate-",
            });
            const statePath = path.join(root, "server-runtime.json");
            const journalPath = path.join(root, "qwen-pids.qwen.json");
            yield* fileSystem.writeFileString(
              journalPath,
              JSON.stringify([
                { pid: childPid, kind: "warm", spawnedAt: "2026-07-19T10:00:00.000Z" },
              ]),
            );

            assert.isTrue(yield* terminateInstance({ pid: serverPid, statePath }));

            assert.isFalse(yield* isProcessAlive(serverPid));
            assert.isTrue(yield* awaitPidDead(childPid));
            // All entries confirmed dead → the journal file is gone.
            assert.isFalse(yield* fileSystem.exists(journalPath));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
