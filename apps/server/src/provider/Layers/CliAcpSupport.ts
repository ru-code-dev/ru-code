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
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ACP_SERVER_NO_SSL, CLI_AUTH_METHOD_ID } from "../../config.ts";
import { buildCliSpawn } from "../../ru-fork/spawn/policy.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "../acp/AcpSessionRuntime.ts";

type CliAcpRuntimeSettings = Pick<CliSettings, "launchArgs" | "homePath">;

/**
 * ru-fork: opaque spawn-time settings the adapter forwards verbatim. Produced by
 * the MCP overlay engine (see ru-fork/mcp/McpOverlay.ts) but kept provider-neutral
 * here: `settingsOverlayPath` is any highest-precedence settings file;
 * `allowedMcpServers` is the qwen MCP server allowlist. Both independent + optional.
 */
export interface CliAcpSettingsOverlay {
  readonly settingsOverlayPath?: string;
  readonly allowedMcpServers?: ReadonlyArray<string>;
}

export interface CliAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cliSettings: CliAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  // ru-fork: resolved cli.js (ServerConfig.cliJs). Spawned as `node <cliJs> --acp`.
  readonly cliJs: string;
  // ru-fork: forwarded verbatim into the spawn (env + launch arg). Absent ⇒ today's behaviour.
  readonly settingsOverlay?: CliAcpSettingsOverlay;
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
  cliJs: string,
  cliSettings: CliAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  settingsOverlay?: CliAcpSettingsOverlay,
): AcpSpawnInput {
  const env: NodeJS.ProcessEnv = { ...environment };
  const homePath = cliSettings?.homePath?.trim();
  if (homePath) {
    env.CLI_HOME = homePath;
  }
  if (ACP_SERVER_NO_SSL) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  // ru-fork: a highest-precedence settings file overlaid onto qwen's own config.
  if (settingsOverlay?.settingsOverlayPath) {
    env.QWEN_CODE_SYSTEM_SETTINGS_PATH = settingsOverlay.settingsOverlayPath;
  }
  // ru-fork: restrict qwen to exactly the overlay's MCP servers (omit ⇒ no filter).
  const allowedMcpServers = settingsOverlay?.allowedMcpServers ?? [];
  const allowMcpArgs =
    allowedMcpServers.length > 0
      ? ["--allowed-mcp-server-names", allowedMcpServers.join(",")]
      : [];
  // ru-fork: `node <cliJs> [launchArgs] [--allowed-mcp-server-names …] --acp`
  // directly — no shell, no PATH lookup.
  const spawn = buildCliSpawn(cliJs, [
    ...parseLaunchArgs(cliSettings?.launchArgs),
    ...allowMcpArgs,
    "--acp",
  ]);
  return {
    command: spawn.command,
    args: [...spawn.args],
    cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export const makeCliAcpRuntime = (
  input: CliAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope | Crypto.Crypto> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCliAcpSpawnInput(
          input.cliJs,
          input.cliSettings,
          input.cwd,
          input.environment,
          input.settingsOverlay,
        ),
        authMethodId: CLI_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
