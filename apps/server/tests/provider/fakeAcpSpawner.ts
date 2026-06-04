// ru-fork: in-memory shell for the fake ACP agent (`fakeAcpCore.ts`). Provides a
// `ChildProcessSpawner` layer whose spawned handle is backed by live in-memory
// queues, with the fake agent forked onto the layer scope reading/writing them.
// The REAL CliAdapter + AcpSessionRuntime run unchanged over this handle — no
// real process, no real pipe, no wall-clock — so the adapter→ingestion flow is
// exercised end to end, deterministically.
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

import { type FakeAcpScript, type FakeAcpTransportControls, runFakeAcpAgent } from "./fakeAcpCore.ts";

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
 * A `ChildProcessSpawner` layer wired to the fake agent driven by `script`.
 * Provide this in place of the real spawner to run the adapter against the fake.
 */
export const fakeAcpSpawnerLayer = (
  script: FakeAcpScript,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      // client→server (the agent reads this) and server→client (the client reads
      // handle.stdout from this). `Cause.Done<void>` is the clean-completion type
      // used by effect-acp's own in-memory stdio.
      const clientToServer = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const serverToClient = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const exitDeferred = yield* Deferred.make<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
      >();

      const controls: FakeAcpTransportControls = {
        // malformed frame → client AcpProtocolParseError (C1)
        writeRaw: (bytes) => Queue.offer(serverToClient, encoder.encode(bytes)).pipe(Effect.asVoid),
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
        // The agent fiber may end abnormally when we tear the transport down; that
        // is the scenario under test, not a harness failure.
        Effect.catchCause(() => Effect.void),
        Effect.forkScoped,
      );

      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(true),
        // Adapter forceKill (SIGKILL): EOF + non-zero exit so the in-flight prompt
        // fails into the finalizer AND the child-exit watcher fires.
        kill: () =>
          Queue.end(serverToClient).pipe(
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

      return ChildProcessSpawner.make(() => Effect.succeed(handle));
    }),
  );
