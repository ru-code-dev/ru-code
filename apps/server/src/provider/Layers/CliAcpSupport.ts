/**
 * CliAcpSupport — ACP session runtime factory for Cli Code CLI.
 *
 * Spawns `CLI --acp` (with optional extra launch args) and wraps the
 * result in an {@link AcpSessionRuntime} layer. Auth method is `"openai"`
 * for the initial implementation (matches Cli Code's default).
 *
 * @module CliAcpSupport
 */
import { type CliSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ACP_SERVER_NO_SSL, CLI_AUTH_METHOD_ID, CLI_BINARY_NAME } from "../../config.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "../acp/AcpSessionRuntime.ts";

type CliAcpRuntimeSettings = Pick<CliSettings, "launchArgs" | "homePath">;

export interface CliAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cliSettings: CliAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Parse `launchArgs` into an array of tokens.
 * Simple whitespace splitting — does not handle quoting.
 */
function parseLaunchArgs(launchArgs: string | undefined): ReadonlyArray<string> {
  const trimmed = launchArgs?.trim();
  if (!trimmed || trimmed.length === 0) {
    return [];
  }
  return trimmed.split(/\s+/);
}

export function buildCliAcpSpawnInput(
  cliSettings: CliAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const env: NodeJS.ProcessEnv = { ...environment };
  const homePath = cliSettings?.homePath?.trim();
  if (homePath) {
    env.CLI_HOME = homePath;
  }
  if (ACP_SERVER_NO_SSL) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  return {
    command: CLI_BINARY_NAME,
    args: [...parseLaunchArgs(cliSettings?.launchArgs), "--acp"],
    cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export const makeCliAcpRuntime = (
  input: CliAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCliAcpSpawnInput(input.cliSettings, input.cwd, input.environment),
        authMethodId: CLI_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
