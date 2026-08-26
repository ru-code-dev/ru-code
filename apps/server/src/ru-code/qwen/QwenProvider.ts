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
import { APP_NAME, cliArgAssignments } from "@ru-code/branding";
import { buildCliEnv } from "./profileResolver.ts";
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
import { getCachedVersionProbe, setCachedVersionProbe } from "./versionProbeCache.ts";

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

/** A line that is nothing but a version, e.g. `0.13.1` or `v0.13.1`. */
const VERSION_ONLY_LINE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * ru-code: the version the CLI reported, read the way the CLI actually writes it.
 *
 * `--version` is yargs' built-in: it prints the version alone on STDOUT and exits 0, before any
 * MCP/auth/extension work happens. Crashes take the other path — a stack trace or error text on
 * STDERR with a non-zero exit. So stdout is the trustworthy channel, and a line that is only a
 * version is the trustworthy shape. Scanning both channels for the first `x.y.z` (the previous
 * behaviour) could pick a number out of an error message, e.g. "requires Node 20.11.1".
 */
function parseReportedVersion(result: CommandResult): string | null {
  for (const channel of [result.stdout, result.stderr]) {
    for (const rawLine of channel.split("\n")) {
      const match = VERSION_ONLY_LINE.exec(rawLine.trim());
      if (match?.[1]) return match[1];
    }
  }
  // Nothing clean: fall back to the loose scan, stdout first so error text cannot win.
  return parseGenericCliVersion(result.stdout) ?? parseGenericCliVersion(result.stderr);
}

export function parseQwenVersionOutput(result: CommandResult, cliLabel: string): QwenVersionResult {
  const version = parseReportedVersion(result);

  // ru-code: a parsed version proves the CLI ran and identified itself. A non-zero exit
  // alongside it comes from unrelated shutdown noise (an MCP server, a credential check, a
  // node-pty race — all of which print on stderr and exit non-zero); it says nothing about
  // whether the CLI is usable, so it must not degrade the provider. Without a version a
  // non-zero exit is the only signal we have, and it is reported.
  if (version === null && result.code !== 0) {
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: `${cliLabel} CLI is installed, but the command failed with an unexpected error.`,
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
  // ru-code: the resolved CLI path, so an instance rebuilt after this process already probed
  // that path starts from the known verdict instead of an unknown version.
  cliJs?: string,
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

    // ru-code: the CLI's presence is already established (the boot preflight found it — that
    // detection is what enables this provider at all), so the pre-probe snapshot reports
    // `ready` with the version still unknown. It must NOT be a `warning`: the model picker
    // enables an instance only while `status === "ready"`, so a "checking…" warning greys the
    // provider out for the whole probe — which is longest on exactly the slow machines. A
    // path already probed in this process is served from the cache, so the unknown-version
    // window happens at most once per path per launch.
    const cached = cliJs === undefined ? undefined : getCachedVersionProbe(cliJs);
    return buildServerProvider({
      presentation: cliPresentation(cliLabel),
      enabled: true,
      checkedAt,
      models: yield* qwenModelsForSettings(cliSettings, getDiscoveredModels),
      probe: {
        installed: true,
        version: cached?.version ?? null,
        status: cached?.status ?? "ready",
        auth: cached?.auth ?? { status: "unknown" },
        ...(cached?.message ? { message: cached.message } : {}),
      },
    });
  });
}

/** The snapshot a version verdict produces — shared by the fresh, cached and timed-out paths. */
function buildQwenProviderFromVersion(
  parsed: QwenVersionResult,
  input: {
    readonly cliSettings: QwenSettings;
    readonly cliLabel: string;
    readonly checkedAt: string;
    readonly models: ReadonlyArray<ServerProviderModel>;
  },
): ServerProviderDraft {
  return buildServerProvider({
    presentation: cliPresentation(input.cliLabel),
    enabled: input.cliSettings.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: true,
      version: parsed.version,
      status: parsed.status,
      auth: parsed.auth,
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
}

const runQwenVersionCommand = (
  cliJs: string,
  // ru-code: the instance's resolved CLI profile dir — the registry's HOME row. A probe run
  // without it reads the wrong profile and reports a version for an install we are not using.
  homeDir: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // ru-code: `node <cliJs> --version [shared flags]` directly — no shell, no PATH lookup.
    // The registry's shared flags ride along UNCONDITIONALLY here (no MCP kill-switch gate): a
    // version probe is never an MCP client, and without the allowlist flag the CLI connects and
    // awaits every configured server before yargs can print the version.
    const resolved = buildCliSpawn(cliJs, ["--version", ...cliArgAssignments()]);
    const command = ChildProcess.make(resolved.command, [...resolved.args], {
      env: buildCliEnv(environment, { homeDir }),
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
  // ru-code: the instance's resolved CLI profile dir — the registry's HOME row.
  homeDir: string,
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

  // ru-code: one probe per CLI path per process — see versionProbeCache.
  const remembered = getCachedVersionProbe(cliJs);
  if (remembered !== undefined) {
    return buildQwenProviderFromVersion(remembered, {
      cliSettings,
      cliLabel,
      checkedAt,
      models,
    });
  }

  const versionProbe = yield* runQwenVersionCommand(cliJs, homeDir, environment).pipe(
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
    // ru-code: the spawn succeeded, so the CLI is installed — it just did not finish printing
    // its version inside the (generous, minute-long) budget. That is a real signal about the
    // machine now, not the cold-start noise a 3 s budget used to produce, so it is surfaced —
    // but as `ready` with an explanatory message, never a warning: the model picker enables an
    // instance only while `status === "ready"`, and a slow `--version` must not cost the user
    // their provider. Remembered so the wait is paid at most once per path per launch.
    yield* Effect.logDebug("cli-version-probe-timeout", {
      timeoutMs: CLI_VERSION_PROBE_TIMEOUT_MS,
    });
    const timedOut: QwenVersionResult = {
      version: null,
      status: "ready",
      auth: { status: "unknown" },
      message: `${cliLabel} CLI is installed; its version check did not finish within ${Math.round(CLI_VERSION_PROBE_TIMEOUT_MS / 1_000)} seconds. This machine may be slow.`,
    };
    setCachedVersionProbe(cliJs, timedOut);
    return buildQwenProviderFromVersion(timedOut, { cliSettings, cliLabel, checkedAt, models });
  }

  const parsed = parseQwenVersionOutput(versionProbe.success.value, cliLabel);
  setCachedVersionProbe(cliJs, parsed);
  return buildQwenProviderFromVersion(parsed, { cliSettings, cliLabel, checkedAt, models });
});
