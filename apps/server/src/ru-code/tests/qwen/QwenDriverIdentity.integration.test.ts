// ru-code: driver-identity integration proof (feature #10 / S10). The pure
// QwenDriver.test covers the static shape and defaultConfig; QwenProvider.extra covers
// the snapshot BUILDERS. This drives the real `QwenDriver.create(...)` IO — the full
// ChildProcessSpawner/Crypto/FileSystem/Path/ProviderEventLoggers/ServerConfig stack
// with only the version probe canned — and proves the produced ProviderInstance +
// its managed snapshot carry the stamped identity (instanceId / driver kind / accent),
// which `withInstanceIdentity` applies via `stampIdentity` on the initial snapshot.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { QWEN_KIND } from "@ru-code/branding";
import { ProviderDriverKind, ProviderInstanceId, QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../../background/HostPowerMonitor.ts";
import * as ServerConfig from "../../../config.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../../provider/Layers/ProviderEventLoggers.ts";
import { QwenDriver } from "../../qwen/QwenDriver.ts";
import { QwenModelDiscoveryStore } from "../../qwen/discovery/QwenModelDiscoveryStore.ts";
import { QwenCompactionHistory } from "../../qwen/compaction/QwenCompactionHistory.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const QWEN = ProviderDriverKind.make(QWEN_KIND);
const INSTANCE_ID = ProviderInstanceId.make("qwen");
const ACCENT = "#a1b2c3";

// A spawner whose `cli --version` probe is canned so the background snapshot refresh
// resolves instead of trying to launch a real binary.
const versionSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(Stream.make("qwen 1.2.3\n")),
      stderr: Stream.encodeText(Stream.make("")),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

// layerTest builds against FileSystem/Path/Crypto, so feed NodeServices INTO it
// (provideMerge re-exports NodeServices' FileSystem/Path/Crypto to create()'s effect).
const infrastructureLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-driver-identity-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// ru-code: fixture rot — QwenDriver.create reaches makeManagedServerProvider,
// which now also consumes BackgroundPolicy (F4a, decisions row 22/26 fix
// round). HostPowerMonitor.make() needs no external deps (no initial
// snapshot given), so a bare Layer.effect is enough for this test.
const backgroundPolicyLayer = BackgroundPolicy.layer.pipe(
  Layer.provide(
    Layer.merge(
      Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
      ServerSettingsService.layerTest(),
    ),
  ),
);

const layer = Layer.mergeAll(
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, versionSpawner),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  // ru-code: QwenDriver.create consumes the discovery store (models list), the
  // live settings reader (auto-compact) and the compaction-history reader
  // (circuit breaker); real layers over the test ServerConfig's temp stateDir.
  QwenModelDiscoveryStore.layer().pipe(Layer.provideMerge(infrastructureLayer)),
  ServerSettingsService.layerTest(),
  QwenCompactionHistory.layerTest(),
  backgroundPolicyLayer,
);

it.effect(
  "qwen S10 driver identity: create stamps instanceId / driver / accent on the snapshot",
  () =>
    Effect.gen(function* () {
      const instance = yield* QwenDriver.create({
        instanceId: INSTANCE_ID,
        displayName: undefined,
        accentColor: ACCENT,
        environment: [],
        enabled: true,
        config: decodeQwenSettings({}),
      });

      // Instance-level identity.
      assert.strictEqual(instance.instanceId, INSTANCE_ID);
      assert.strictEqual(instance.driverKind, QWEN);
      assert.strictEqual(instance.accentColor, ACCENT);
      // displayName defaults to the resolved profile label when unset.
      assert.isDefined(instance.displayName);

      // Managed snapshot identity — stampIdentity was applied to the initial snapshot.
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.instanceId, INSTANCE_ID);
      assert.strictEqual(snapshot.driver, QWEN);
      assert.strictEqual(snapshot.accentColor, ACCENT);
      assert.strictEqual(snapshot.continuation?.groupKey, `${QWEN}:instance:${INSTANCE_ID}`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
