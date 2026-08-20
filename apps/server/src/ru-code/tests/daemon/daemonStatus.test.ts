// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the reuse/reclaim/spawn verdict — inspectExistingDaemon combines the
// state file, pid liveness and the TCP probe into the launcher's decision input.
// Proven with real pids + real loopback listeners: healthy → reuse shape
// (alive+listening), wedged → reclaim shape (alive, not listening), crashed →
// dead shape, no file → none.

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { inspectExistingDaemon } from "@ru-code/daemon/daemonStatus";
import { signalProcess } from "@ru-code/daemon/signal";

import {
  awaitPidDead,
  closedLoopbackPort,
  withLoopbackListener,
  withSleeper,
} from "./spawnSleeper.ts";

const stateJson = (pid: number, port: number): string =>
  JSON.stringify({
    version: 1,
    pid,
    host: "127.0.0.1",
    port,
    origin: `http://127.0.0.1:${port}`,
    startedAt: "2026-07-19T10:00:00.000Z",
    pairingUrl: `http://127.0.0.1:${port}/?pair=abc`,
  });

describe("daemon inspectExistingDaemon", () => {
  it.live("no state file → none (spawn fresh)", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-status-" });
      const verdict = yield* inspectExistingDaemon(
        path.join(root, "server-runtime.json"),
        "127.0.0.1",
      );
      assert.isTrue(Option.isNone(verdict));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("healthy instance → alive AND listening (reuse)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        withLoopbackListener((port) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-status-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

            const verdict = Option.getOrThrow(yield* inspectExistingDaemon(statePath, "127.0.0.1"));
            assert.isTrue(verdict.alive);
            assert.isTrue(verdict.listening);
            assert.equal(verdict.pid, pid);
            assert.equal(verdict.port, port);
            assert.equal(verdict.origin, `http://127.0.0.1:${port}`);
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("wedged instance → alive but NOT listening (reclaim)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-status-" });
          const statePath = path.join(root, "server-runtime.json");
          const port = yield* closedLoopbackPort();
          yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

          const verdict = Option.getOrThrow(yield* inspectExistingDaemon(statePath, "127.0.0.1"));
          assert.isTrue(verdict.alive);
          assert.isFalse(verdict.listening);
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("crashed instance → not alive, not listening (spawn fresh + reap)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        withLoopbackListener((port) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-status-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* signalProcess(pid, "SIGKILL");
            yield* awaitPidDead(pid);
            // Even with SOMETHING on the port, a dead pid must not read as reusable.
            yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

            const verdict = Option.getOrThrow(yield* inspectExistingDaemon(statePath, "127.0.0.1"));
            assert.isFalse(verdict.alive);
            assert.isFalse(verdict.listening);
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
