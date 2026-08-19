/**
 * ru-code: QwenProvider — status probe and snapshot builder for the qwen CLI.
 *
 * Performs a lightweight binary presence check via `CLI --version` to
 * determine installation status. Does not attempt ACP initialization or
 * prompting as part of the routine probe — that would be expensive with
 * local models.
 *
 * Models come from the instance's brand profile (built-ins) plus the user's
 * custom models (see qwenModelsForSettings); each carries the auth method it
 * dispatches with. The slug is sent to qwen at setModel as `${slug}(${authType})`.
 *
 * @module QwenProvider
 */
import type {
  QwenSettings,
  ServerProviderModel,
  ServerProviderState,
  ServerProviderAuth,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// ru-code: route through the spawn-policy helper so
// ru-code: CLI is launched as `node <cliJs> …` directly. See
// ru-code: qwen/spawn.ts buildCliSpawn.
import { buildCliSpawn } from "@ru-code/qwen/spawn";
import { APP_NAME } from "@ru-code/branding";
import type { DiscoveredQwenModel } from "./discovery/QwenModelDiscoveryStore.ts";
import { serveQwenModels } from "./discovery/serveQwenModels.ts";
import { CLI_VERSION_PROBE_TIMEOUT_MS } from "@ru-code/qwen/constants";
import { haltOnExit } from "@ru-code/qwen/haltOnExit";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  type CommandResult,
  type ServerProviderDraft,
} from "../../provider/providerSnapshot.ts";

// ru-code: presentation carries the resolved profile label; per-instance identity
// (displayName/accent) is stamped over the snapshot by the driver.
// allowsFullAccess:false locks the composer's full-access runtime mode for qwen
// (its yolo mode bypasses the L4 PermissionManager rules the server relies on).
const cliPresentation = (displayName: string) =>
  ({ displayName, showInteractionModeToggle: true, allowsFullAccess: false }) as const;

/**
 * ru-code: live reader of the instance's discovered models — the driver binds
 * it to `QwenModelDiscoveryStore.get(instanceId)`; tests pass
 * `Effect.succeed([])`. Read at EVERY snapshot build so refreshes serve
 * discovery updates without recreating the instance.
 */
export type GetDiscoveredQwenModels = Effect.Effect<ReadonlyArray<DiscoveredQwenModel>>;

/**
 * ru-code: the models advertised by a Qwen snapshot. Assembly is the pure
 * `serveQwenModels` decision (discovered-set-is-authoritative + custom append);
 * this wrapper only supplies the live discovered set.
 */
const qwenModelsForSettings = (
  settings: QwenSettings,
  getDiscoveredModels: GetDiscoveredQwenModels,
): Effect.Effect<ReadonlyArray<ServerProviderModel>> =>
  Effect.map(getDiscoveredModels, (discoveredModels) =>
    serveQwenModels(settings, discoveredModels),
  );

export interface QwenVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export function parseQwenVersionOutput(result: CommandResult, cliLabel: string): QwenVersionResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const version = parseGenericCliVersion(combined);

  if (result.code !== 0) {
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: version
        ? `Detected ${cliLabel} CLI version ${version}, but the command exited with code ${result.code}.`
        : `${cliLabel} CLI is installed, but the command failed with an unexpected error.`,
    };
  }

  return {
    version,
    status: "ready",
    auth: { status: "unknown" },
  };
}

export function buildInitialQwenProviderSnapshot(
  cliSettings: QwenSettings,
  cliLabel: string,
  getDiscoveredModels: GetDiscoveredQwenModels = Effect.succeed([]),
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    if (!cliSettings.enabled) {
      return buildServerProvider({
        presentation: cliPresentation(cliLabel),
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${cliLabel} is disabled in ${APP_NAME} settings.`,
        },
      });
    }

    return buildServerProvider({
      presentation: cliPresentation(cliLabel),
      enabled: true,
      checkedAt,
      models: yield* qwenModelsForSettings(cliSettings, getDiscoveredModels),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Checking ${cliLabel} availability…`,
      },
    });
  });
}

const runQwenVersionCommand = (cliJs: string, environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // ru-code: `node <cliJs> --version` directly — no shell, no PATH lookup.
    const resolved = buildCliSpawn(cliJs, ["--version"]);
    const command = ChildProcess.make(resolved.command, [...resolved.args], {
      env: environment,
      shell: resolved.shell,
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout.pipe(haltOnExit(child.exitCode))),
        collectStreamAsString(child.stderr.pipe(haltOnExit(child.exitCode))),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkQwenProviderStatus = Effect.fn("checkQwenProviderStatus")(function* (
  cliJs: string,
  cliSettings: QwenSettings,
  cliLabel: string,
  environment: NodeJS.ProcessEnv = process.env,
  getDiscoveredModels: GetDiscoveredQwenModels = Effect.succeed([]),
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = yield* qwenModelsForSettings(cliSettings, getDiscoveredModels);

  if (!cliSettings.enabled) {
    return buildServerProvider({
      presentation: cliPresentation(cliLabel),
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${cliLabel} is disabled in ${APP_NAME} settings.`,
      },
    });
  }

  const versionProbe = yield* runQwenVersionCommand(cliJs, environment).pipe(
    Effect.timeoutOption(CLI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: cliPresentation(cliLabel),
      enabled: cliSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `${cliLabel} CLI is not installed or not on PATH.`
          : `Could not run the ${cliLabel} CLI check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    // ru-code: cold-start of qwen CLI (Node ESM + heavy import graph)
    // regularly approaches the 3 s budget. Treat a slow `--version` as a
    // soft signal — the binary is installed (spawn succeeded), only the
    // version string is unknown. Log to server, keep the provider usable.
    // The previous `status: "error"` + UI message are commented below in
    // case we want to surface this again later.
    yield* Effect.logDebug("cli-version-probe-timeout", {
      timeoutMs: CLI_VERSION_PROBE_TIMEOUT_MS,
    });
    return buildServerProvider({
      presentation: cliPresentation(cliLabel),
      enabled: cliSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        // status: "error",
        auth: { status: "unknown" },
        // message: `${CLI_NAME} CLI is installed, but the `${CLI_BINARY_NAME} --version` command did not finish in time.`,
      },
    });
  }

  const parsed = parseQwenVersionOutput(versionProbe.success.value, cliLabel);
  return buildServerProvider({
    presentation: cliPresentation(cliLabel),
    enabled: cliSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsed.version,
      status: parsed.status,
      auth: parsed.auth,
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
});
