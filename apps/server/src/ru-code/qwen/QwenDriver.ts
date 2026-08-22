/**
 * QwenDriver — `ProviderDriver` for the qwen CLI runtime.
 *
 * Spawns `qwen --acp` (as `node <cliJs> --acp`) and drives it through the ACP
 * infrastructure. Modelled on CursorDriver but with no enrichment probe; model
 * discovery is live (session-start advertisements + model-error corrections)
 * via QwenModelDiscoveryStore, republished through the snapshot-refresh watcher.
 *
 * ru-code: the EFFECTIVE enablement is gated on startup CLI detection —
 * `enabled && ServerConfig.cliDetected`. When the qwen CLI is not detected the
 * instance materializes as a disabled provider (no spawn), so the app launches
 * cleanly with every provider off.
 *
 * @module QwenDriver
 */
import { QWEN_KIND } from "@ru-code/branding";
import { QwenSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

// ru-code: makeManagedServerProvider now also consumes BackgroundPolicy —
// declare it in QwenDriverEnv the same way the shipped OpenCodeDriver does
// (provider/Drivers/OpenCodeDriver.ts:80).
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { makeQwenTextGeneration } from "./QwenTextGeneration.ts";
import { ProviderDriverError } from "../../provider/Errors.ts";
import { makeQwenAdapter } from "./QwenAdapter.ts";
// ru-code: per-instance discovered-models store — feeds the snapshot's model
// list and is refreshed by the adapter's live discovery channels.
import { QwenModelDiscoveryStore } from "./discovery/QwenModelDiscoveryStore.ts";
import { serveQwenModels } from "./discovery/serveQwenModels.ts";
// ru-code: history reader for the restart-proof auto-compact circuit breaker.
import { QwenCompactionHistory } from "./compaction/QwenCompactionHistory.ts";
// ru-code: live server settings — the adapter's auto-compact trigger reads
// `autoCompactContext` at each turn end (no instance rebuild on toggle).
import { ServerSettingsService } from "../../serverSettings.ts";
import { readAutoCompactContext } from "./autoCompactSetting.ts";
// ru-code: resolve the instance's effective CLI identity (profile + settings + preflight).
import { resolveCliProfileSettings } from "./profileResolver.ts";
import { buildInitialQwenProviderSnapshot, checkQwenProviderStatus } from "./QwenProvider.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../../provider/makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../../provider/ProviderDriver.ts";
import type { ServerProviderDraft } from "../../provider/providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../../provider/providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make(QWEN_KIND);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

// qwen is installed manually (no npm package, no homebrew, no native update
// command) — its binary path is configured via `QwenSettings.binaryPath`.
// Without an upstream version source there is nothing to advise about, so the
// resolver returns manual-only capabilities and we omit `enrichSnapshot`.
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type QwenDriverEnv =
  | BackgroundPolicy.BackgroundPolicy // ru-code: makeManagedServerProvider dependency
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | QwenCompactionHistory // ru-code: compaction-history reader (circuit breaker)
  | QwenModelDiscoveryStore // ru-code: discovered-models persistence
  | ServerConfig
  | ServerSettingsService; // ru-code: live autoCompactContext setting

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const QwenDriver: ProviderDriver<QwenSettings, QwenDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Qwen",
    supportsMultipleInstances: true,
  },
  configSchema: QwenSettings,
  defaultConfig: (): QwenSettings => decodeQwenSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // ru-code: resolved cli.js + detection flag, threaded from the startup preflight.
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      // ru-code: gate effective enablement on startup CLI detection.
      const effectiveEnabled = enabled && serverConfig.cliDetected;
      const effectiveConfig = { ...config, enabled: effectiveEnabled } satisfies QwenSettings;
      // ru-code: resolve profile → { bin, dir, name, artifact } (settings override the
      // profile default; a null profile default falls back to the boot preflight).
      const resolved = resolveCliProfileSettings(effectiveConfig, {
        cliJs: serverConfig.cliJs,
        cliConfigDir: serverConfig.cliConfigDir,
      });
      // ru-code: instance name defaults to the profile label when unset.
      const effectiveDisplayName = displayName ?? resolved.name;
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName: effectiveDisplayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: resolved.bin,
        env: processEnv,
      });

      // ru-code: live model discovery — the adapter WRITES (session-start
      // advertisements, model-error corrections), the snapshot builders READ,
      // and the watcher below refreshes the published snapshot on changes so
      // the picker updates without recreating the instance.
      const modelDiscoveryStore = yield* QwenModelDiscoveryStore;
      const getDiscoveredModels = modelDiscoveryStore.get(instanceId);

      // ru-code: live setting reader for the adapter's auto-compact trigger —
      // read per turn end, so toggling it applies immediately (settings-file
      // read errors degrade to "off" for that check).
      const serverSettings = yield* ServerSettingsService;
      const getAutoCompactContext = readAutoCompactContext(serverSettings.getSettings);
      const compactionHistory = yield* QwenCompactionHistory;

      const adapter = yield* makeQwenAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        modelDiscoveryStore,
        getAutoCompactContext,
        getThreadCompactionState: compactionHistory.getThreadCompactionState,
      });

      const textGeneration = yield* makeQwenTextGeneration(
        resolved.bin,
        effectiveConfig,
        processEnv,
        {
          getServedModels: getDiscoveredModels.pipe(
            Effect.map((discoveredModels) => serveQwenModels(effectiveConfig, discoveredModels)),
          ),
        },
      );

      const checkProvider = checkQwenProviderStatus(
        resolved.bin,
        effectiveConfig,
        resolved.name,
        processEnv,
        getDiscoveredModels,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<QwenSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          // ru-code: pass the resolved CLI path so a rebuilt instance reuses this process's
          // version verdict for that path instead of starting from an unknown version.
          buildInitialQwenProviderSnapshot(
            settings,
            resolved.name,
            getDiscoveredModels,
            resolved.bin,
          ).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Qwen snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // ru-code: republish the snapshot when THIS instance's discovered set
      // changes (session-start advertisement / model-error correction). The
      // refresh re-runs checkProvider, which reads the store — so the picker
      // gets the new list live, with no instance teardown. Fiber dies with the
      // instance scope; failures are logged and swallowed (the periodic
      // refresh interval is the safety net).
      yield* modelDiscoveryStore.changes.pipe(
        Stream.filter((changedInstanceId) => changedInstanceId === instanceId),
        Stream.runForEach(() =>
          snapshot.refresh.pipe(
            Effect.tapCause((cause) =>
              Effect.logError("[qwen-model-discovery] snapshot refresh failed", {
                instanceId,
                cause,
              }),
            ),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName: effectiveDisplayName,
        accentColor,
        enabled: effectiveEnabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
