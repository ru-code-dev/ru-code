import * as AcpClient from "effect-acp/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { AcpRunError, type AcpRunnerShape } from "../types.ts";
import { accumulateDelta } from "./collect.ts";
import {
  authenticateParams,
  initializeParams,
  mapStopReason,
  newSessionParams,
  promptBlocks,
} from "./handshake.ts";
import { AcpRunner } from "./runner.ts";

/**
 * The real ACP runner — the one un-unit-testable file (real child-process spawn glue), hence
 * `*.integration.ts` and coverage-excluded. Every decision it makes lives in a pure, tested
 * helper (handshake / collect): this file only assembles them against a live qwen process.
 *
 * Session-per-job: each `run` spawns `node <cliJs> --acp`, initializes → authenticates →
 * creates a session → prompts, accumulating the agent's text deltas, and returns the text +
 * stop reason. Any failure or defect collapses to a single {@link AcpRunError}.
 */
export interface AcpRunnerOptions {
  readonly cliJs: string;
  readonly cwd: string;
  readonly authMethodId: string;
  readonly cliHome?: string;
  readonly noSsl?: boolean;
}

const buildEnv = (options: AcpRunnerOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  if (options.cliHome) env.CLI_HOME = options.cliHome;
  if (options.noSsl) env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return env;
};

export const makeAcpRunnerLayer = (
  options: AcpRunnerOptions,
): Layer.Layer<AcpRunner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    AcpRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const env = buildEnv(options);

      const run: AcpRunnerShape["run"] = (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(process.execPath, [options.cliJs, "--acp"], {
                cwd: options.cwd,
                env: { ...process.env, ...env },
                shell: false,
              }),
            );
            const context = yield* Layer.build(AcpClient.layerChildProcess(child));
            const acp = yield* Effect.service(AcpClient.AcpClient).pipe(Effect.provide(context));
            const buffer = yield* Ref.make("");
            yield* acp.handleSessionUpdate((notification) =>
              Ref.update(buffer, (current) => accumulateDelta(current, notification)),
            );
            yield* acp.agent.initialize(initializeParams());
            yield* acp.agent.authenticate(authenticateParams(options.authMethodId));
            const session = yield* acp.agent.createSession(newSessionParams(options.cwd));
            const response = yield* acp.agent.prompt({
              sessionId: session.sessionId,
              prompt: promptBlocks(input.prompt),
            });
            return { text: yield* Ref.get(buffer), stopReason: mapStopReason(response) };
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new AcpRunError({ message: Cause.pretty(cause) })),
          ),
        );

      return { run };
    }),
  );
