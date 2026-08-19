// ru-code: coverage for the qwen-specific process-control surface the session
// runtime adds on top of the port's generic ACP runtime — `forceKill` (SIGKILL
// teardown) and `waitForExit` (child-exit watcher). We drive the runtime layer
// with a FAKE ChildProcessHandle (Stream.never stdio) so NO real process is
// spawned. The full start/prompt/session lifecycle rides real child stdio and is
// covered by the Phase 3 fake-ACP e2e suite (see AcpJsonRpcConnection.test.ts).
// @effect-diagnostics globalErrorInEffectFailure:off - we deliberately fail the
// fake handle with a global Error to prove forceKill/waitForExit swallow it.
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import {
  QwenAcpSessionRuntime,
  type AcpSessionRuntimeOptions,
} from "../../../qwen/acp/QwenAcpSessionRuntime.ts";

interface KillCall {
  readonly killSignal: string | undefined;
}

// Build a fake ChildProcessHandle whose stdio never emits (so the ACP client's
// background reader parks harmlessly) and whose exitCode / kill are scripted.
const makeFakeHandle = (config: {
  readonly exitCode: Effect.Effect<number, never>;
  readonly kill: (options?: { readonly killSignal?: string }) => Effect.Effect<void, never>;
}) =>
  ({
    pid: 4242,
    exitCode: config.exitCode,
    isRunning: Effect.succeed(true),
    kill: config.kill,
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    // The runtime never touches these on the tested paths; cast covers the
    // remaining structural/branding members of ChildProcessHandle.
  }) as unknown as ChildProcessSpawner.ChildProcessHandle;

const baseOptions: AcpSessionRuntimeOptions = {
  spawn: { command: process.execPath, args: ["/opt/cli.js", "--acp"] },
  cwd: "/tmp/qwen-test",
  clientInfo: { name: "t3-code", version: "0.0.0" },
  authMethodId: "openai",
};

// Provide the runtime layer with a fake spawner returning `handle`; Crypto comes
// from NodeServices. Everything runs scoped so the background ACP reader is
// interrupted on completion.
const withRuntime = <A>(
  handle: ChildProcessSpawner.ChildProcessHandle,
  use: (runtime: QwenAcpSessionRuntime["Service"]) => Effect.Effect<A>,
): Effect.Effect<A> => {
  const fakeSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: () => Effect.succeed(handle),
  } as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]);

  return Effect.gen(function* () {
    const runtime = yield* QwenAcpSessionRuntime;
    return yield* use(runtime);
  }).pipe(
    Effect.provide(QwenAcpSessionRuntime.layer(baseOptions)),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // ru-code: seal the layer-build error channel — a runtime construction
    // failure is a test defect, and it.effect requires `Effect<A, never, never>`.
    Effect.orDie,
  );
};

describe("QwenAcpSessionRuntime process control", () => {
  it.effect("forceKill sends SIGKILL to the child", () =>
    Effect.gen(function* () {
      const kills: Array<KillCall> = [];
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        kill: (options) =>
          Effect.sync(() => {
            kills.push({ killSignal: options?.killSignal });
          }),
      });

      yield* withRuntime(handle, (runtime) => runtime.forceKill);

      expect(kills).toHaveLength(1);
      expect(kills[0]?.killSignal).toBe("SIGKILL");
    }),
  );

  it.effect("forceKill swallows a kill failure (Effect.ignore) and still completes", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        // A failing kill must not surface — forceKill is Effect<void> (no error channel).
        kill: () =>
          Effect.fail(new Error("kernel refused")) as unknown as Effect.Effect<void, never>,
      });

      // Resolving at all (no failure) is the assertion.
      const result = yield* withRuntime(handle, (runtime) => runtime.forceKill);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("waitForExit resolves once the child's exitCode settles", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        kill: () => Effect.void,
      });

      const result = yield* withRuntime(handle, (runtime) => runtime.waitForExit);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("waitForExit swallows an exitCode failure and still resolves", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        // exitCode failing (e.g. read-exit-status error) must be swallowed — the
        // watcher only cares about the timing, never the error.
        exitCode: Effect.fail(new Error("no exit status")) as unknown as Effect.Effect<
          number,
          never
        >,
        kill: () => Effect.void,
      });

      const result = yield* withRuntime(handle, (runtime) => runtime.waitForExit);
      expect(result).toBeUndefined();
    }),
  );
});
