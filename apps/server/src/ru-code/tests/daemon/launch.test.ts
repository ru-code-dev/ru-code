// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the launch policy's REUSE branch — the only branch that can run
// in-process (the spawn branches would re-exec process.argv[1], i.e. the test
// runner). A healthy instance (live pid + real listener) must be reused: banner
// only — no kill, no reap, no state rewrite. The kill-free guarantee matters:
// reuse against a running server must never touch its children or journals.
// (Spawn/retry/port-fallback branches remain covered piecewise: net.test,
// daemonStatus.test, waitForReady.test — and by the real-machine smoke.)

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";

import { APP_NAME } from "@ru-code/branding";
import type { ForwardableServerFlags } from "@ru-code/daemon/childArgs";
import { launchDaemon } from "@ru-code/daemon/launch";
import { isProcessAlive } from "@ru-code/daemon/signal";

import { withLoopbackListener, withSleeper } from "./spawnSleeper.ts";

const noFlags: ForwardableServerFlags = {
  port: Option.none(),
  host: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  language: Option.none(),
  logWebSocketEvents: Option.none(),
};

describe("daemon launch policy (reuse branch)", () => {
  it.live("healthy instance → reused: no kill, no journal reap, state intact", () =>
    Effect.scoped(
      withSleeper((serverPid) =>
        withSleeper((journaledChild) =>
          withLoopbackListener((port) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-launch-" });
              const statePath = path.join(root, "server-runtime.json");
              const journalPath = path.join(root, "qwen-pids.qwen.json");
              const stateContents = JSON.stringify({
                version: 1,
                pid: serverPid,
                host: "127.0.0.1",
                port,
                origin: `http://127.0.0.1:${port}`,
                startedAt: "2026-07-19T10:00:00.000Z",
              });
              yield* fileSystem.writeFileString(statePath, stateContents);
              yield* fileSystem.writeFileString(
                journalPath,
                JSON.stringify([
                  { pid: journaledChild, kind: "session", spawnedAt: "2026-07-19T10:00:00.000Z" },
                ]),
              );

              // Reuse: port override pins the probe at OUR listener's port.
              yield* launchDaemon({
                flags: { ...noFlags, port: Option.some(port) },
                statePath,
                baseDir: root,
                version: "0.0.0-test",
              });

              // Nothing was killed, nothing was reaped, nothing was rewritten.
              assert.isTrue(yield* isProcessAlive(serverPid));
              assert.isTrue(yield* isProcessAlive(journaledChild));
              assert.isTrue(yield* fileSystem.exists(journalPath));
              assert.equal(yield* fileSystem.readFileString(statePath), stateContents);
            }),
          ),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ru-code: the `--json` output contract on the one branch that runs in-process.
// The reuse branch is the branch the INSTALLER hits when the app is already up, and
// it must be indistinguishable from a fresh start to the shell reading the line.
const reuseOutput = (jsonOutput: boolean) =>
  Effect.scoped(
    withSleeper((serverPid) =>
      withLoopbackListener((port) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "ru-code-launch-json-",
          });
          const statePath = path.join(root, "server-runtime.json");
          yield* fileSystem.writeFileString(
            statePath,
            JSON.stringify({
              version: 1,
              pid: serverPid,
              host: "127.0.0.1",
              port,
              origin: `http://127.0.0.1:${port}`,
              startedAt: "2026-07-19T10:00:00.000Z",
            }),
          );

          yield* launchDaemon({
            flags: { ...noFlags, port: Option.some(port) },
            statePath,
            baseDir: root,
            version: "9.9.9-test",
            jsonOutput,
          });

          return {
            logLines: yield* TestConsole.logLines,
            errorLines: yield* TestConsole.errorLines,
            expectedPid: serverPid,
            expectedUrl: `http://127.0.0.1:${port}`,
          };
        }),
      ),
    ),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)));

describe("daemon launch output (--json)", () => {
  it.live("JSON mode: exactly ONE stdout line, the success record, no banner", () =>
    Effect.gen(function* () {
      const { logLines, errorLines, expectedPid, expectedUrl } = yield* reuseOutput(true);
      assert.lengthOf(logLines, 1);
      assert.lengthOf(errorLines, 0);
      const line = logLines[0];
      assert.isString(line);
      if (typeof line !== "string") return;
      assert.notInclude(line, "\n");
      // No banner anywhere in JSON mode — not the box, not the wordmark headline.
      assert.notInclude(line, APP_NAME);
      assert.notInclude(line, "Open:");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), ["ok", "url", "version", "pid"]);
      assert.deepEqual(parsed, {
        ok: true,
        url: expectedUrl,
        version: "9.9.9-test",
        pid: expectedPid,
      });
    }),
  );

  it.live("default mode is unchanged: the human banner, no JSON", () =>
    Effect.gen(function* () {
      const { logLines, errorLines, expectedUrl } = yield* reuseOutput(false);
      assert.lengthOf(logLines, 1);
      assert.lengthOf(errorLines, 0);
      const line = logLines[0];
      assert.isString(line);
      if (typeof line !== "string") return;
      assert.include(line, `${APP_NAME} is already running`);
      assert.include(line, "Open:");
      assert.include(line, expectedUrl);
      assert.notInclude(line, '"ok"');
    }),
  );
});
