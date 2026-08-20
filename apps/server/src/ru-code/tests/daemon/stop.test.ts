// @effect-diagnostics preferSchemaOverJson:off
// ru-code: stopDaemon's decision tree, end to end against real state files + a real
// process. Covers the three non-exiting paths: no state file, a stale pid (already
// dead → clears the file, no error), and a live daemon (kills it + clears the file).
// The "alive-and-survived-the-kill → non-zero exit" branch calls process.exit, so
// it's proven via the terminate confirmed-dead contract (terminate.test.ts) + a
// manual Windows check, not here (exiting would kill the runner).

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isProcessAlive, signalProcess } from "@ru-code/daemon/signal";
import { stopDaemon } from "@ru-code/daemon/stop";

import { awaitPidDead, withSleeper, withStubbornSleeper } from "./spawnSleeper.ts";

const stateJson = (pid: number): string =>
  JSON.stringify({
    version: 1,
    pid,
    port: 7777,
    origin: "http://127.0.0.1:7777",
    startedAt: "2026-07-15T10:00:00.000Z",
  });

describe("daemon stopDaemon", () => {
  it.live("no state file → resolves cleanly, nothing to remove", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-daemon-stop-" });
      const statePath = path.join(root, "server-runtime.json");
      yield* stopDaemon({ statePath, force: false });
      assert.isFalse(yield* fileSystem.exists(statePath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stale pid + journaled orphan → the orphan is reaped NOW, not on next start", () =>
    Effect.scoped(
      withSleeper((deadServer) =>
        withSleeper((orphan) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "ru-code-daemon-stop-",
            });
            const statePath = path.join(root, "server-runtime.json");
            // The "server" crashed (pid dead), leaving a journaled acp orphan.
            yield* signalProcess(deadServer, "SIGKILL");
            yield* awaitPidDead(deadServer);
            yield* fileSystem.writeFileString(statePath, stateJson(deadServer));
            yield* fileSystem.writeFileString(
              path.join(root, "qwen-pids.qwen.json"),
              JSON.stringify([
                { pid: orphan, kind: "session", spawnedAt: "2026-07-19T10:00:00.000Z" },
              ]),
            );

            yield* stopDaemon({ statePath, force: false });

            // `stop` means nothing left running — the orphan dies with it.
            assert.isTrue(yield* awaitPidDead(orphan));
            assert.isFalse(yield* fileSystem.exists(statePath));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stale pid (already dead) → clears the state file, no error", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "ru-code-daemon-stop-",
          });
          const statePath = path.join(root, "server-runtime.json");
          yield* signalProcess(pid, "SIGKILL");
          yield* awaitPidDead(pid);
          yield* fileSystem.writeFileString(statePath, stateJson(pid));
          yield* stopDaemon({ statePath, force: false });
          assert.isFalse(yield* fileSystem.exists(statePath));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stop --force kills even a SIGTERM-trapping orphan (force reaches the children)", () =>
    Effect.scoped(
      withSleeper((deadServer) =>
        withStubbornSleeper((stubbornOrphan) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "ru-code-daemon-stop-",
            });
            const statePath = path.join(root, "server-runtime.json");
            yield* signalProcess(deadServer, "SIGKILL");
            yield* awaitPidDead(deadServer);
            yield* fileSystem.writeFileString(statePath, stateJson(deadServer));
            yield* fileSystem.writeFileString(
              path.join(root, "qwen-pids.qwen.json"),
              JSON.stringify([
                { pid: stubbornOrphan, kind: "session", spawnedAt: "2026-07-19T10:00:00.000Z" },
              ]),
            );

            yield* stopDaemon({ statePath, force: true });

            // A plain stop would leave the trap-holder alive (tracked); --force must not.
            assert.isTrue(yield* awaitPidDead(stubbornOrphan));
            assert.isFalse(yield* fileSystem.exists(statePath));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("live daemon → kills the process and clears the state file", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "ru-code-daemon-stop-",
          });
          const statePath = path.join(root, "server-runtime.json");
          yield* fileSystem.writeFileString(statePath, stateJson(pid));
          assert.isTrue(yield* isProcessAlive(pid));
          yield* stopDaemon({ statePath, force: false });
          assert.isTrue(yield* awaitPidDead(pid));
          assert.isFalse(yield* fileSystem.exists(statePath));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
