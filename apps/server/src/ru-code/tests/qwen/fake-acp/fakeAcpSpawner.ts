// ru-code: in-memory shell for the fake ACP agent (`fakeAcpCore.ts`). Provides a
// `ChildProcessSpawner` layer whose spawned handle is backed by live in-memory
// queues, with the fake agent forked onto the layer scope reading/writing them.
// The REAL QwenAdapter runs unchanged over this handle — no real process, no
// real pipe, no wall-clock — so the adapter→ingestion flow is exercised end to
// end, deterministically.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type FakeAcpScript,
  type FakeAcpTransportControls,
  runFakeAcpAgent,
} from "./fakeAcpCore.ts";

const encoder = new TextEncoder();

// A PlatformError to fail the handle's exitCode with on a broken pipe (C4). Its
// only role is to make `makeTerminationError`'s onFailure branch fire, yielding
// an AcpTransportError on the client side.
const brokenPipeError = new PlatformError.PlatformError(
  new PlatformError.BadArgument({
    module: "FakeAcp",
    method: "exitCode",
    description: "fake acp transport closed mid-stream",
  }),
);

/**
 * ru-code: optional lifecycle observers for the fake handle. `onSpawn` fires each
 * time the adapter spawns a child (proving the no-respawn guarantee: exactly one
 * spawn across a multi-turn session); `onKill` fires when the adapter force-kills
 * the child (proving the end-force SIGKILL teardown path).
 */
export interface FakeAcpSpawnerObservers {
  readonly onSpawn?: () => void;
  readonly onKill?: () => void;
}

/**
 * A `ChildProcessSpawner` layer wired to the fake agent driven by `script`.
 * Provide this in place of the real spawner to run the adapter against the fake.
 */
export const fakeAcpSpawnerLayer = (
  script: FakeAcpScript,
  observers?: FakeAcpSpawnerObservers,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      // ru-code: agents forked per spawn attach here so they outlive the spawn
      // call itself and die with the layer.
      const layerScope = yield* Effect.scope;
      let spawnCount = 0;

      // ru-code: a FRESH agent + queues per spawn (was: one shared handle for
      // every spawn). A killed child ends its queues for good, so post-teardown
      // restarts — the post-compaction `session/load` resume, mode-change
      // restarts — need a live transport of their own, exactly like a real
      // re-spawned process. Single-spawn tests are unaffected (same first
      // handle, `onSpawn` still counts every spawn).
      const spawnFakeChild = Effect.gen(function* () {
        spawnCount += 1;
        observers?.onSpawn?.();
        // client→server (the agent reads this) and server→client (the client
        // reads handle.stdout from this). `Cause.Done<void>` is the
        // clean-completion type used by effect-acp's own in-memory stdio.
        const clientToServer = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const serverToClient = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const exitDeferred = yield* Deferred.make<
          ChildProcessSpawner.ExitCode,
          PlatformError.PlatformError
        >();

        const controls: FakeAcpTransportControls = {
          // malformed frame → client AcpProtocolParseError (C1)
          writeRaw: (bytes) =>
            Queue.offer(serverToClient, encoder.encode(bytes)).pipe(Effect.asVoid),
          // EOF + failed exit status → client AcpTransportError (C4)
          closeTransport: Queue.end(serverToClient).pipe(
            Effect.andThen(Deferred.fail(exitDeferred, brokenPipeError)),
            Effect.asVoid,
          ),
          // EOF + exit status `code` → client AcpProcessExitedError (B1)
          exit: (code) =>
            Queue.end(serverToClient).pipe(
              Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code))),
              Effect.asVoid,
            ),
        };

        const agentStdio = Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(clientToServer),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Queue.offer(
                serverToClient,
                typeof chunk === "string" ? encoder.encode(chunk) : chunk,
              ),
            ),
          stderr: () => Sink.drain,
        });

        yield* runFakeAcpAgent(agentStdio, script, controls).pipe(
          // The agent fiber may end abnormally when we tear the transport down;
          // that is the scenario under test, not a harness failure.
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(layerScope),
        );

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawnCount),
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(true),
          // Adapter forceKill (SIGKILL): EOF + non-zero exit so the in-flight
          // prompt fails into the finalizer AND the child-exit watcher fires.
          kill: () =>
            Effect.sync(() => observers?.onKill?.()).pipe(
              Effect.andThen(Queue.end(serverToClient)),
              Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(137))),
              Effect.asVoid,
              Effect.ignore,
            ),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Queue.offer(clientToServer, bytes).pipe(Effect.asVoid),
          ),
          stdout: Stream.fromQueue(serverToClient),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      });

      return ChildProcessSpawner.make(() => spawnFakeChild);
    }),
  );

// A PlatformError to fail the spawn itself with (B3). Its only role is to make
// the runtime's `spawner.spawn(...)` mapError branch fire — the runtime wraps
// ANY spawn failure into an `AcpSpawnError`, which the classifier routes to B3.
const spawnFailedError = new PlatformError.PlatformError(
  new PlatformError.BadArgument({
    module: "FakeAcp",
    method: "spawn",
    description: "fake acp spawn failed: command not found (ENOENT)",
  }),
);

/**
 * A `ChildProcessSpawner` layer whose `spawn` FAILS before any wire exists —
 * mirrors `fakeAcpSpawnerLayer`'s service shape but fails the spawn instead of
 * returning a handle. Provide this to drive the adapter's B3 (spawn-failure)
 * path: the session runtime maps the failed spawn into an `AcpSpawnError` which
 * the finalizer/dispatcher classifies as B3 (T+N). No queues, no fake agent —
 * the process never starts.
 */
export const failingAcpSpawnerLayer = (): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.fail(spawnFailedError)),
  );
