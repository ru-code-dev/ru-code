/**
 * QwenAcpSupport — ACP session runtime factory for the qwen CLI.
 *
 * Spawns `node <cliJs> [launchArgs] [--allowed-mcp-server-names …] --acp` and
 * wraps the result in a {@link QwenAcpSessionRuntime} layer. The session-start
 * auth method is resolved per instance (override or profile default).
 *
 * @module QwenAcpSupport
 */
import { type QwenSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { CLI_ENV_VAR_PREFIX, resolveCliProfile } from "@ru-code/branding";
import {
  ACP_SERVER_NO_SSL,
  MCP_ENGINE_USE_OVERLAY,
  NO_MCP_SERVER_SENTINEL,
} from "@ru-code/qwen/constants";
import { buildCliSpawn } from "@ru-code/qwen/spawn";
import { resolveDefaultAuthMethod } from "./profileResolver.ts";
import {
  QwenAcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./acp/QwenAcpSessionRuntime.ts";

type QwenAcpRuntimeSettings = Pick<
  QwenSettings,
  "launchArgs" | "homePath" | "profile" | "defaultAuthMethod"
>;

/**
 * ru-code: opaque spawn-time settings the adapter forwards verbatim. Produced by
 * the MCP overlay engine but kept provider-neutral here: `settingsOverlayPath` is
 * any highest-precedence settings file; `allowedMcpServers` is the MCP server
 * allowlist. Both independent + optional.
 */
export interface QwenAcpSettingsOverlay {
  readonly settingsOverlayPath?: string;
  readonly allowedMcpServers?: ReadonlyArray<string>;
}

export interface QwenAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly qwenSettings: QwenAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  // ru-code: resolved cli.js (ServerConfig.cliJs). Spawned as `node <cliJs> --acp`.
  readonly cliJs: string;
  // ru-code: forwarded verbatim into the spawn (env + launch arg). Absent ⇒ today's behaviour.
  readonly settingsOverlay?: QwenAcpSettingsOverlay;
}

/**
 * Parse `launchArgs` into an array of tokens. Simple whitespace splitting —
 * does not handle quoting.
 */
function parseLaunchArgs(launchArgs: string | undefined): ReadonlyArray<string> {
  const trimmed = launchArgs?.trim();
  if (!trimmed || trimmed.length === 0) {
    return [];
  }
  return trimmed.split(/\s+/);
}

/**
 * ru-code: the `--allowed-mcp-server-names` argument pair for an allowlist.
 *
 * Shared by every qwen spawn that should honour the overlay's allowlist (ACP sessions, warm
 * slots, one-shot text generation). An empty/absent list yields the sentinel rather than no
 * flag, because the CLI treats a missing flag as "no filter" and connects everything.
 */
export function buildAllowedMcpServerArgs(
  allowedMcpServers: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const names = (allowedMcpServers ?? []).filter((name) => name.trim().length > 0);
  return [
    "--allowed-mcp-server-names",
    names.length > 0 ? names.join(",") : NO_MCP_SERVER_SENTINEL,
  ];
}

export function buildQwenAcpSpawnInput(
  cliJs: string,
  // ru-code: the spawn only needs launchArgs/homePath — narrower than the runtime
  // settings (which also carry profile/defaultAuthMethod for auth resolution).
  qwenSettings: Pick<QwenSettings, "launchArgs" | "homePath"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  settingsOverlay?: QwenAcpSettingsOverlay,
): AcpSpawnInput {
  const env: NodeJS.ProcessEnv = { ...environment };
  // ru-code: qwen re-spawns itself as a child unless this is set (relaunch
  // wrapper, qwen-code relaunch.ts). One process ⇒ half the boot cost/memory
  // and our SIGKILL hits the real agent instead of the wrapper.
  env[`${CLI_ENV_VAR_PREFIX}_NO_RELAUNCH`] = "true";
  if (ACP_SERVER_NO_SSL) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  // ru-code: a highest-precedence settings file overlaid onto qwen's own config.
  // Gated on MCP_ENGINE_USE_OVERLAY so the documented kill-switch actually disables
  // overlay injection (and the server allowlist below) when off.
  if (MCP_ENGINE_USE_OVERLAY && settingsOverlay?.settingsOverlayPath) {
    env[`${CLI_ENV_VAR_PREFIX}_SYSTEM_SETTINGS_PATH`] = settingsOverlay.settingsOverlayPath;
  }
  // ru-code: restrict qwen to exactly the overlay's MCP servers. The flag is ALWAYS passed while
  // the engine is on — an empty allowlist means "no MCP", which is expressed by the sentinel and
  // NOT by omitting the flag (omitting it disables the filter, so the CLI connects every server
  // the user configured; see NO_MCP_SERVER_SENTINEL). Engine off ⇒ no flag at all, so the
  // kill-switch leaves qwen's own MCP configuration untouched.
  const allowMcpArgs = MCP_ENGINE_USE_OVERLAY
    ? buildAllowedMcpServerArgs(settingsOverlay?.allowedMcpServers)
    : [];
  // ru-code: `node <cliJs> [launchArgs] [--allowed-mcp-server-names …] --acp`
  // directly — no shell, no PATH lookup.
  const spawn = buildCliSpawn(cliJs, [
    ...parseLaunchArgs(qwenSettings?.launchArgs),
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

export const makeQwenAcpRuntime = (
  input: QwenAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope | Crypto.Crypto> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      QwenAcpSessionRuntime.layer({
        ...input,
        spawn: buildQwenAcpSpawnInput(
          input.cliJs,
          input.qwenSettings,
          input.cwd,
          input.environment,
          input.settingsOverlay,
        ),
        // ru-code: session-start auth = per-instance override or the profile default
        // (custom → openai, stock qwen → qwen-oauth). qwen's `session/new` requires
        // it (ensureAuthenticated throws authRequired otherwise).
        authMethodId: input.qwenSettings
          ? resolveDefaultAuthMethod(input.qwenSettings)
          : resolveCliProfile(undefined).defaultAuthMethod,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(QwenAcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
