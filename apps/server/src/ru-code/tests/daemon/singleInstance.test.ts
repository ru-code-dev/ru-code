// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the single-instance guard that makes "two servers on one baseDir"
// impossible (serve/--foreground/desktop bypass the daemon's reuse gate). We test
// the decision core (checkSingleInstance) — the exiting wrapper is a trivial
// failWith like stop's, proven by the same pattern. Real ingredients: a live
// throwaway pid + a REAL loopback listener; conflict ⇔ alive AND listening.

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { checkSingleInstance } from "@ru-code/daemon/singleInstance";
import { DAEMON_CHILD_ENV } from "@ru-code/daemon/constants";
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
  });

describe("daemon checkSingleInstance", () => {
  it.live("alive pid + listening port → conflict reported", () =>
    Effect.scoped(
      withSleeper((pid) =>
        withLoopbackListener((port) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-single-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

            const conflict = yield* checkSingleInstance(statePath);
            assert.isTrue(Option.isSome(conflict));
            assert.deepEqual(Option.getOrThrow(conflict), { pid, port });
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("dead pid (stale state) → no conflict, start may proceed", () =>
    Effect.scoped(
      withSleeper((pid) =>
        withLoopbackListener((port) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-single-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* signalProcess(pid, "SIGKILL");
            yield* awaitPidDead(pid);
            // Port still listening (someone else) — but the recorded pid is dead.
            yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

            assert.isTrue(Option.isNone(yield* checkSingleInstance(statePath)));
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("alive pid but NOT listening (wedged/booting) → no conflict", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-single-" });
          const statePath = path.join(root, "server-runtime.json");
          const closedPort = yield* closedLoopbackPort();
          yield* fileSystem.writeFileString(statePath, stateJson(pid, closedPort));

          assert.isTrue(Option.isNone(yield* checkSingleInstance(statePath)));
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("no state file → no conflict", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-single-" });
      assert.isTrue(
        Option.isNone(yield* checkSingleInstance(path.join(root, "server-runtime.json"))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("the daemon child (env marker) is exempt even on a live conflict", () =>
    Effect.scoped(
      withSleeper((pid) =>
        withLoopbackListener((port) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-single-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(statePath, stateJson(pid, port));

            process.env[DAEMON_CHILD_ENV] = "1";
            try {
              assert.isTrue(Option.isNone(yield* checkSingleInstance(statePath)));
            } finally {
              delete process.env[DAEMON_CHILD_ENV];
            }
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
