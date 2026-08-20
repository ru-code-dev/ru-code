// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the launcher's readiness wait — all three outcomes against real pids
// + real state files: ready (child published its pairing URL), exited (child
// died — the EADDRINUSE-retry trigger), timeout (still up, no URL; short budget
// via the tests-only override, falling back to the plain origin).

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { signalProcess } from "@ru-code/daemon/signal";
import { awaitDaemonReady } from "@ru-code/daemon/waitForReady";

import { awaitPidDead, withSleeper } from "./spawnSleeper.ts";

const stateJson = (pid: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    pid,
    port: 7777,
    origin: "http://127.0.0.1:7777",
    startedAt: "2026-07-19T10:00:00.000Z",
    ...extra,
  });

describe("daemon awaitDaemonReady", () => {
  it.live("ready: the child published its state with a pairing URL", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-ready-" });
          const statePath = path.join(root, "server-runtime.json");
          yield* fileSystem.writeFileString(
            statePath,
            stateJson(pid, { pairingUrl: "http://127.0.0.1:7777/?pair=abc" }),
          );

          const outcome = yield* awaitDaemonReady({ statePath, childPid: pid });
          assert.equal(outcome._tag, "ready");
          if (outcome._tag === "ready") {
            assert.equal(outcome.url, "http://127.0.0.1:7777/?pair=abc");
            assert.equal(outcome.startedAt, "2026-07-19T10:00:00.000Z");
          }
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("exited: a dead child reports exited (the retry trigger)", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-ready-" });
          const statePath = path.join(root, "server-runtime.json");
          yield* signalProcess(pid, "SIGKILL");
          yield* awaitPidDead(pid);

          const outcome = yield* awaitDaemonReady({ statePath, childPid: pid });
          assert.equal(outcome._tag, "exited");
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("timeout: child alive, state written WITHOUT a pairing URL → plain origin", () =>
    Effect.scoped(
      withSleeper((pid) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-ready-" });
          const statePath = path.join(root, "server-runtime.json");
          yield* fileSystem.writeFileString(statePath, stateJson(pid));

          const outcome = yield* awaitDaemonReady({ statePath, childPid: pid, timeoutMs: 600 });
          assert.equal(outcome._tag, "timeout");
          if (outcome._tag === "timeout") {
            assert.deepEqual(outcome.url, Option.some("http://127.0.0.1:7777"));
          }
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("timeout: state belongs to a DIFFERENT pid → no url (never a stale banner)", () =>
    Effect.scoped(
      withSleeper((child) =>
        withSleeper((stranger) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-ready-" });
            const statePath = path.join(root, "server-runtime.json");
            yield* fileSystem.writeFileString(statePath, stateJson(stranger));

            const outcome = yield* awaitDaemonReady({
              statePath,
              childPid: child,
              timeoutMs: 600,
            });
            assert.equal(outcome._tag, "timeout");
            if (outcome._tag === "timeout") {
              assert.isTrue(Option.isNone(outcome.url));
            }
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
