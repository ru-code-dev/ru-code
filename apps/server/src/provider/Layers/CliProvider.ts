/**
 * CliProvider — status probe and snapshot builder for Cli Code CLI.
 *
 * Performs a lightweight binary presence check via `CLI --version` to
 * determine installation status. Does not attempt ACP initialization or
 * prompting as part of the routine probe — that would be expensive with
 * local models.
 *
 * Cli Code ships with its model bundled: there is no model discovery or
 * model switching. A single synthetic `"default"` model entry is emitted
 * so the UI model picker has a valid selection target; the adapter ignores
 * the slug entirely.
 *
 * @module CliProvider
 */
import type {
  CliSettings,
  ServerProviderModel,
  ServerProviderState,
  ServerProviderAuth,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// ru-fork: route through the spawn-policy helper so
// ru-fork: CLI is launched as `node <cliJs> …` directly. See
// ru-fork/spawn/policy.ts buildCliSpawn.
import { buildCliSpawn } from "../../ru-fork/spawn/policy.ts";
import { APP_NAME } from "@ru-fork/branding";
import { CLI_BINARY_NAME, CLI_NAME } from "../../config.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const VERSION_TIMEOUT_MS = 8_000;

const CLI_PRESENTATION = {
  displayName: CLI_NAME,
  showInteractionModeToggle: true,
} as const;

/**
 * The two models advertised by every Cli snapshot. The `slug` is sent
 * verbatim to qwen as its model config value on each turn (see
 * CliAdapter.sendTurn → AcpSessionRuntime.setModel). The first entry is
 * the default selection in the picker.
 */
const CLI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    shortName: "🐬 Plus",
    isCustom: false,
    capabilities: null,
    // ru-fork: context window (tokens). Adjust to real model limits.
    contextWindowTokens: 100_000,
  },
  {
    slug: "qwen3-coder-flash",
    name: "Qwen3 Coder Flash",
    shortName: "🚀 Flash",
    isCustom: false,
    capabilities: null,
    // ru-fork: context window (tokens). Adjust to real model limits.
    contextWindowTokens: 20_000,
  },
];

export interface CliVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export function parseCliVersionOutput(result: CommandResult): CliVersionResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const version = parseGenericCliVersion(combined);

  if (result.code !== 0) {
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: version
        ? `Обнаружен ${CLI_NAME} CLI версии ${version}, но команда завершилась с кодом ${result.code}.`
        : `${CLI_NAME} CLI установлен, но команда завершилась с непредвиденной ошибкой.`,
    };
  }

  return {
    version,
    status: "ready",
    auth: { status: "unknown" },
  };
}

export function buildInitialCliProviderSnapshot(
  cliSettings: CliSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    if (!cliSettings.enabled) {
      return buildServerProvider({
        presentation: CLI_PRESENTATION,
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${CLI_NAME} отключён в настройках ${APP_NAME}.`,
        },
      });
    }

    return buildServerProvider({
      presentation: CLI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CLI_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Проверка доступности ${CLI_NAME}...`,
      },
    });
  });
}

const runCliVersionCommand = (
  cliJs: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // ru-fork: `node <cliJs> --version` directly — no shell, no PATH lookup.
    const resolved = buildCliSpawn(cliJs, ["--version"]);
    const command = ChildProcess.make(resolved.command, [...resolved.args], {
      env: environment,
      shell: resolved.shell,
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkCliProviderStatus = Effect.fn("checkCliProviderStatus")(function* (
  cliJs: string,
  cliSettings: CliSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!cliSettings.enabled) {
    return buildServerProvider({
      presentation: CLI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${CLI_NAME} отключён в настройках ${APP_NAME}.`,
      },
    });
  }

  const versionProbe = yield* runCliVersionCommand(cliJs, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLI_PRESENTATION,
      enabled: cliSettings.enabled,
      checkedAt,
      models: CLI_MODELS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `${CLI_NAME} CLI (\`${CLI_BINARY_NAME}\`) не установлен или не найден в PATH.`
          : `Не удалось выполнить проверку ${CLI_NAME} CLI: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    // ru-fork: cold-start of cli-code (Node ESM + heavy import graph)
    // regularly approaches the 8 s budget. Treat a slow `--version` as a
    // soft signal — the binary is installed (spawn succeeded), only the
    // version string is unknown. Log to server, keep the provider usable.
    // The previous `status: "error"` + UI message are commented below in
    // case we want to surface this again later.
    yield* Effect.logWarning("cli-version-probe-timeout", {
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    return buildServerProvider({
      presentation: CLI_PRESENTATION,
      enabled: cliSettings.enabled,
      checkedAt,
      models: CLI_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        // status: "error",
        auth: { status: "unknown" },
        // message: `${CLI_NAME} CLI установлен, но команда `${CLI_BINARY_NAME} --version` не завершилась вовремя.`,
      },
    });
  }

  const parsed = parseCliVersionOutput(versionProbe.success.value);
  return buildServerProvider({
    presentation: CLI_PRESENTATION,
    enabled: cliSettings.enabled,
    checkedAt,
    models: CLI_MODELS,
    probe: {
      installed: true,
      version: parsed.version,
      status: parsed.status,
      auth: parsed.auth,
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
});
