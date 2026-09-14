// ru-code (cli-reload): test infra co-located with the specs that use it (fork rule R10).
//
// The fake ACP spawner answers EVERY spawn with an ACP-speaking child, but a text-generation
// run is `node <cliJs> -p <prompt> … --output-format json` — a one-shot that writes JSON and
// exits. Feeding it the ACP fake would park it until the 180 s text-gen timeout, so the
// reload's D3 coverage needs a spawner that tells the two apart:
//
//   · `--acp` in argv   → the real fake ACP child (unchanged behaviour for every other spec);
//   · `-p` in argv      → a PARKED one-shot whose stdout/exit the spec completes by hand.
//
// Parked is the point: the reload must SIGKILL a text-generation child that is still running
// (research A-G3 — these children are in no journal and `stopAll` never reached them), and a
// child that already exited would prove nothing.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer, type FakeAcpSpawnerObservers } from "./fakeAcpSpawner.ts";

const encoder = new TextEncoder();

/** One parked `-p` child, as the spec drives it. */
export interface ParkedTextGenChild {
  readonly index: number;
  /** Finish the run: stdout `output`, then exit with `exitCode` (default 0). */
  readonly complete: (output: string, exitCode?: number) => Effect.Effect<void>;
  /** True until the child exits or is killed. */
  readonly isLive: () => boolean;
  /** True once a kill signal reached it while it was still alive. */
  readonly wasKilled: () => boolean;
}

export interface TextGenSpawnObserver {
  /** Every `-p` child the CLI spawned, in spawn order. */
  readonly children: ParkedTextGenChild[];
  readonly spawnCount: () => number;
  readonly killCount: () => number;
  /** Fires the instant a `-p` child is created — the ORDER oracle the priority specs need. */
  readonly onSpawn?: () => void;
}

export const makeTextGenSpawnObserver = (onSpawn?: () => void): TextGenSpawnObserver => {
  const children: ParkedTextGenChild[] = [];
  return {
    children,
    spawnCount: () => children.length,
    killCount: () => children.filter((child) => child.wasKilled()).length,
    ...(onSpawn ? { onSpawn } : {}),
  };
};

const isTextGenCommand = (command: ChildProcess.Command): boolean =>
  ChildProcess.isStandardCommand(command) && command.args.includes("-p");

/**
 * A spawner that routes `--acp` spawns to the fake ACP child and `-p` spawns to a parked
 * one-shot recorded in `textGen`. Everything else about the ACP path is untouched — the fake
 * ACP layer is built inside, so its observers behave exactly as in every other spec.
 */
export const cliReloadSpawnerLayer = (
  script: FakeAcpScript,
  acpObservers: FakeAcpSpawnerObservers,
  textGen: TextGenSpawnObserver,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const acpContext = yield* Layer.build(fakeAcpSpawnerLayer(script, acpObservers));
      const acpSpawner = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
        Effect.provide(acpContext),
      );

      const spawnParkedTextGen = Effect.gen(function* () {
        const exitDeferred = yield* Deferred.make<
          ChildProcessSpawner.ExitCode,
          PlatformError.PlatformError
        >();
        const stdoutDeferred = yield* Deferred.make<string>();
        let live = true;
        let killed = false;
        const settle = (output: string, exitCode: number) =>
          Effect.suspend(() => {
            if (!live) return Effect.void;
            live = false;
            return Deferred.succeed(stdoutDeferred, output).pipe(
              Effect.andThen(
                Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(exitCode)),
              ),
              Effect.asVoid,
            );
          });
        // The real spawner's kill is a process-group SIGKILL that awaits the exit; mirror
        // both halves — the exit resolves, so the run's `exitCode` read completes.
        const performKill = Effect.suspend(() => {
          if (live) killed = true;
          return settle("", 137);
        });
        const child: ParkedTextGenChild = {
          index: textGen.children.length + 1,
          complete: (output, exitCode = 0) => settle(output, exitCode),
          isLive: () => live,
          wasKilled: () => killed,
        };
        textGen.children.push(child);
        textGen.onSpawn?.();
        // Scope close kills, exactly like the node spawner's acquireRelease.
        yield* Effect.addFinalizer(() => performKill);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1_000 + child.index),
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.sync(() => live),
          kill: () => performKill,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.fromEffect(Deferred.await(stdoutDeferred)).pipe(
            Stream.map((text) => encoder.encode(text)),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      });

      return ChildProcessSpawner.make((command) =>
        isTextGenCommand(command) ? spawnParkedTextGen : acpSpawner.spawn(command),
      );
    }),
  );

/**
 * The `--output-format json` envelope a real `-p` run writes on success: an ARRAY of
 * messages whose `result` entry carries the model's text (QwenTextGeneration.ts:111-125
 * `extractQwenResultText`).
 */
export const textGenJsonOutput = (result: string): string =>
  JSON.stringify([{ type: "result", result }]);
