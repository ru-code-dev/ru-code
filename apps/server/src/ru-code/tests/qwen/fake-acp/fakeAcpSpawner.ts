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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  /**
   * Fires when a kill signal reaches a LIVE child (adapter forceKill or a
   * scope close finding the process still running) — mirrors the real
   * spawner, where killing an already-exited pid is an ESRCH no-op. A child
   * that exited on its own never counts here; watch `onDispose` for reaping.
   */
  readonly onKill?: () => void;
  /**
   * ru-code (warm engine failure modes): fires exactly once per child when
   * its scope is closed (pool discard/evict/drain or session teardown) —
   * REGARDLESS of whether the child was killed or had already self-exited.
   * The observable for "the pool reaped this slot".
   */
  readonly onDispose?: () => void;
  /**
   * ru-code (warm engine): spawn-recipe capture — fires with the exact
   * command/args/env/cwd of every spawn, so pool tests can assert the
   * byte-identical-spawn invariant (argv allowlist, slot overlay env path,
   * QWEN_CODE_NO_RELAUNCH).
   */
  readonly onSpawnInput?: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly env: Readonly<Record<string, string | undefined>> | undefined;
  }) => void;
  /**
   * ru-code (warm engine failure modes): per-child script override, keyed by
   * 1-based spawn index. Lets a pool test give SPECIFIC children a failure
   * personality (e.g. the two boot-prewarmed spares crash at initialize while
   * later spawns are healthy). Returned fields shallow-merge over the base
   * script; `undefined` keeps the base script untouched.
   */
  readonly perSpawnScript?: (spawnIndex: number) => Partial<FakeAcpScript> | undefined;
  /**
   * ru-code (warm engine failure modes): hands the test each child's raw
   * transport controls, keyed by 1-based spawn index — an EXTERNAL kill switch.
   * Lets a test make a PARKED warm spare die on its own (`exit(1)`) at a moment
   * the test controls, reproducing an idle crash (OOM kill, uncaught exception)
   * of a pooled child that has no session attached.
   */
  readonly onSpawnControls?: (spawnIndex: number, controls: FakeAcpTransportControls) => void;
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
        const spawnIndex = spawnCount;
        observers?.onSpawn?.();
        // ru-code (warm engine failure modes): this child's effective script —
        // the base script with the per-spawn override merged on top.
        const effectiveScript: FakeAcpScript = {
          ...script,
          ...observers?.perSpawnScript?.(spawnIndex),
        };
        // client→server (the agent reads this) and server→client (the client
        // reads handle.stdout from this). `Cause.Done<void>` is the
        // clean-completion type used by effect-acp's own in-memory stdio.
        const clientToServer = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const serverToClient = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const exitDeferred = yield* Deferred.make<
          ChildProcessSpawner.ExitCode,
          PlatformError.PlatformError
        >();

        let exited = false;
        const controls: FakeAcpTransportControls = {
          // malformed frame → client AcpProtocolParseError (C1)
          writeRaw: (bytes) =>
            Queue.offer(serverToClient, encoder.encode(bytes)).pipe(Effect.asVoid),
          // EOF + failed exit status → client AcpTransportError (C4). The
          // process itself lives (broken pipe ≠ death) — stdin stays open.
          closeTransport: Queue.end(serverToClient).pipe(
            Effect.andThen(Deferred.fail(exitDeferred, brokenPipeError)),
            Effect.asVoid,
          ),
          // Process DEATH: EOF + exit status `code` → client
          // AcpProcessExitedError (B1). Both pipes end — a dead process can
          // neither write NOR READ, so the agent stops serving requests and
          // script hooks stop firing, exactly like a real child.
          exit: (code) =>
            Effect.sync(() => {
              exited = true;
            }).pipe(
              Effect.andThen(Queue.end(serverToClient)),
              Effect.andThen(Queue.end(clientToServer)),
              Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code))),
              Effect.asVoid,
            ),
        };

        // ru-code (warm engine failure modes): external per-child kill switch.
        observers?.onSpawnControls?.(spawnIndex, controls);

        // ru-code (warm engine failure modes): boot-time stdout pollution —
        // raw bytes land in front of the host's ndjson parser before the
        // agent's first frame (see the `preludeStdout` doc in fakeAcpCore).
        if (effectiveScript.preludeStdout !== undefined) {
          yield* Queue.offer(serverToClient, encoder.encode(effectiveScript.preludeStdout));
        }

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

        yield* runFakeAcpAgent(agentStdio, effectiveScript, controls).pipe(
          // The agent fiber may end abnormally when we tear the transport down;
          // that is the scenario under test, not a harness failure.
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(layerScope),
        );

        // ru-code (warm engine): one disposal per child — `onDispose` fires
        // once whether the reap came from an explicit forceKill or from the
        // scope finalizer below; `onKill` additionally fires only when the
        // child was STILL ALIVE (killing an exited pid is an ESRCH no-op on
        // the real spawner).
        let disposed = false;
        const performKill = Effect.sync(() => {
          if (!disposed) {
            disposed = true;
            if (!exited) {
              exited = true;
              observers?.onKill?.();
            }
            observers?.onDispose?.();
          }
        }).pipe(
          Effect.andThen(Queue.end(serverToClient)),
          Effect.andThen(Queue.end(clientToServer)),
          Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(137))),
          Effect.asVoid,
          Effect.ignore,
        );
        // ru-code (warm engine): the REAL node spawner spawns via
        // Effect.acquireRelease — closing the spawn scope kills the child.
        // Mirror that so scope-driven teardowns (warm-pool discard/evict/
        // drain) kill fake children exactly like production.
        yield* Effect.addFinalizer(() => performKill);

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawnCount),
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.sync(() => !exited),
          // Adapter forceKill (SIGKILL): EOF + non-zero exit so the in-flight
          // prompt fails into the finalizer AND the child-exit watcher fires.
          kill: () => performKill,
          unref: Effect.succeed(Effect.void),
          // Writes to a dead child's stdin are dropped (EPIPE-like) — the
          // ended queue must not defect the writer.
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Queue.offer(clientToServer, bytes).pipe(Effect.asVoid, Effect.ignore),
          ),
          stdout: Stream.fromQueue(serverToClient),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      });

      return ChildProcessSpawner.make((command) => {
        // ru-code (warm engine): expose the exact spawn recipe to tests.
        if (observers?.onSpawnInput && ChildProcess.isStandardCommand(command)) {
          observers.onSpawnInput({
            command: command.command,
            args: command.args,
            cwd: command.options.cwd,
            env: command.options.env,
          });
        }
        return spawnFakeChild;
      });
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
