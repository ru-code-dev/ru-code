// @effect-diagnostics nodeBuiltinImport:off
// ru-code: test fixture — a throwaway idle child process, so the kill/liveness
// helpers can be exercised against a REAL pid (never qwen / the app itself).
// `withSleeper` acquire-releases the process (force-killed on scope close, so a
// failing assertion never leaks it); `awaitPidDead` polls liveness via Effect.

import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { isProcessAlive } from "@ru-code/daemon/signal";

/** Spawn an idle node process that stays alive until signalled. */
const spawnSleeper = (): NodeChildProcess.ChildProcess => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000000)"], {
    stdio: "ignore",
  });
  // unref the handle so it never keeps the test worker's event loop alive (the
  // worker would otherwise hang on exit waiting for this child). We still kill it
  // explicitly in the release; unref only detaches it from ref-counting.
  child.unref();
  return child;
};

/**
 * Run `use` with the pid of a freshly-spawned idle process; the process is
 * force-killed when the surrounding scope closes (so a failing test never leaks it).
 */
export const withSleeper = <A, E, R>(
  use: (pid: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(spawnSleeper), (child) =>
    Effect.sync(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }),
  ).pipe(
    Effect.flatMap((child) =>
      child.pid === undefined ? Effect.die(new Error("sleeper failed to spawn")) : use(child.pid),
    ),
  );

/**
 * A STUBBORN sleeper — simulates a qwen child that refuses to release: it traps
 * SIGTERM (no-op handler) and only dies to SIGKILL. Prints "ready" once the trap
 * is installed; the acquire WAITS for it, so a test can never signal the child
 * during boot (where the default SIGTERM action would still kill it).
 */
const spawnStubbornSleeper = (): NodeChildProcess.ChildProcess => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000000)'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  child.unref();
  return child;
};

const awaitChildReady = (child: NodeChildProcess.ChildProcess): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    child.stdout?.once("data", () => resume(Effect.void));
    child.once("exit", () => resume(Effect.void)); // died during boot — let the test's liveness asserts fail loudly
  });

/** Like {@link withSleeper}, but the child ignores SIGTERM (see above). */
export const withStubbornSleeper = <A, E, R>(
  use: (pid: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(spawnStubbornSleeper), (child) =>
    Effect.sync(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }),
  ).pipe(
    Effect.flatMap((child) =>
      child.pid === undefined
        ? Effect.die(new Error("stubborn sleeper failed to spawn"))
        : awaitChildReady(child).pipe(Effect.andThen(use(child.pid))),
    ),
  );

/** A real loopback TCP listener on an ephemeral port; closed when the scope closes. */
export const withLoopbackListener = <A, E, R>(
  use: (port: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.die(new Error("listener has no port"))
        : use(address.port);
    }),
  );

/** An ephemeral port that is guaranteed CLOSED (taken, then released). */
export const closedLoopbackPort = (): Effect.Effect<number> =>
  Effect.callback<number>((resume) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = address === null || typeof address === "string" ? 0 : address.port;
      probe.close(() => resume(Effect.succeed(found)));
    });
  });

/** Resolve once `pid` is gone (or give up after ~2s). True if it died. */
export const awaitPidDead = (pid: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(yield* isProcessAlive(pid))) {
        return true;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
    return !(yield* isProcessAlive(pid));
  });
