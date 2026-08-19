// ru-code: integration proof of the served-models pipe INTO text generation —
// QwenDriver.create wires `getServedModelSlugs` (QwenModelDiscoveryStore →
// serveQwenModels → slugs) into makeQwenTextGeneration, whose dispatch resolver
// picks the model for a `qwen -p` run. QwenTextGeneration.test covers the
// resolver with injected slug lists; this test drives the REAL driver stack
// (real discovery-store layer over a temp stateDir) so a broken store read or a
// miswired option would surface here: the dispatched `--model` must equal what
// the store serves, and an empty served set must drop into CLI-defaults mode.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ModelSelection, ProviderInstanceId, QwenSettings } from "@t3tools/contracts";
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
const decodeModelSelection = Schema.decodeSync(ModelSelection);

const INSTANCE_ID = ProviderInstanceId.make("qwen");

// Stock-qwen profile: its built-in model list is EMPTY and no custom models are
// configured, so serveQwenModels serves exactly the discovery store's content —
// nothing can mask the store→textgen pipe under test.
const STOCK_QWEN_SETTINGS = decodeQwenSettings({ profile: "qwen" });

// Persisted shape of one discovered model, as the adapter's live discovery
// writes it (see the QwenModelDiscoveryStore tests).
const DISCOVERED_MODEL = {
  slug: "team/alpha-coder",
  authMethod: "openai",
  name: "Alpha Coder",
  nTokens: 32_000,
};

// "not selected" — an empty persisted selection must resolve to the FIRST served model.
const EMPTY_MODEL_SELECTION = decodeModelSelection({ instanceId: "qwen", model: "" });
// A stale persisted slug: with nothing served it must NOT reach the CLI.
const STALE_MODEL_SELECTION = decodeModelSelection({
  instanceId: "qwen",
  model: "deleted/ghost",
});

/** Qwen's `--output-format json` success envelope for a `-p` text-generation run. */
const TITLE_ENVELOPE = JSON.stringify([{ type: "result", result: "Заголовок треда" }]);

const cannedHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.encodeText(Stream.make("")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

/**
 * A spawner serving the whole driver stack: text-generation runs (argv contains
 * `-p`) get the canned success envelope AND their argv recorded; every other
 * spawn (the snapshot version probe) gets a plausible `--version` reply.
 */
const makeTextgenCapturingSpawner = () => {
  const textgenArgvs: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const isTextgenRun = command._tag === "StandardCommand" && command.args.includes("-p");
    if (isTextgenRun) {
      textgenArgvs.push([command.command, ...command.args]);
    }
    return Effect.succeed(cannedHandle(isTextgenRun ? TITLE_ENVELOPE : "qwen 1.2.3\n"));
  });
  return { textgenArgvs, spawner };
};

// Same construction as QwenDriverIdentity.integration.test: real layers over a
// per-test temp stateDir; the discovery-store layer instance provided here is
// the SAME one QwenDriver.create reads from.
const makeDriverStackLayer = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  temporaryDirPrefix: string,
) => {
  const infrastructureLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: temporaryDirPrefix,
  }).pipe(Layer.provideMerge(NodeServices.layer));
  return Layer.mergeAll(
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    QwenModelDiscoveryStore.layer().pipe(Layer.provideMerge(infrastructureLayer)),
    ServerSettingsService.layerTest(),
    QwenCompactionHistory.layerTest(),
    // ru-code: fixture rot — QwenDriver.create reaches makeManagedServerProvider,
    // which now also consumes BackgroundPolicy (F4a, decisions row 22/26 fix
    // round). HostPowerMonitor.make() needs no external deps.
    BackgroundPolicy.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
          ServerSettingsService.layerTest(),
        ),
      ),
    ),
    // LAST so it overrides the real spawner NodeServices re-exports through the
    // store's infrastructure layer — every spawn in the test must hit the canned one.
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
};

const createDriverInstance = QwenDriver.create({
  instanceId: INSTANCE_ID,
  displayName: undefined,
  accentColor: undefined,
  environment: [],
  enabled: true,
  config: STOCK_QWEN_SETTINGS,
});

const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

describe("QwenDriver → textGeneration served-models pipe (integration)", () => {
  it.effect(
    "model seeded in the REAL store dispatches as --model (first-served resolution)",
    () => {
      const { textgenArgvs, spawner } = makeTextgenCapturingSpawner();
      return Effect.gen(function* () {
        // Seed the store the driver will read — the same layer instance.
        const modelDiscoveryStore = yield* QwenModelDiscoveryStore;
        yield* modelDiscoveryStore.applyAdvertisement(INSTANCE_ID, [DISCOVERED_MODEL]);

        const instance = yield* createDriverInstance;
        const generated = yield* instance.textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "первый вопрос",
          modelSelection: EMPTY_MODEL_SELECTION,
        });
        assert.strictEqual(generated.title, "Заголовок треда");

        // Exactly one -p run, dispatched with the slug the store serves.
        assert.strictEqual(textgenArgvs.length, 1);
        const argv = textgenArgvs[0]!;
        assert.strictEqual(flagValue(argv, "--model"), "team/alpha-coder");
        assert.isDefined(flagValue(argv, "--auth-type"));
        assert.strictEqual(flagValue(argv, "--output-format"), "json");
      }).pipe(
        Effect.scoped,
        Effect.provide(makeDriverStackLayer(spawner, "ru-code-textgen-served-seeded-")),
      );
    },
  );

  it.effect("empty store + no custom models omits --model/--auth-type (CLI defaults mode)", () => {
    const { textgenArgvs, spawner } = makeTextgenCapturingSpawner();
    return Effect.gen(function* () {
      const instance = yield* createDriverInstance;
      yield* instance.textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "первый вопрос",
        modelSelection: STALE_MODEL_SELECTION,
      });

      assert.strictEqual(textgenArgvs.length, 1);
      const argv = textgenArgvs[0]!;
      assert.isFalse(argv.includes("--model"));
      assert.isFalse(argv.includes("--auth-type"));
      // The run itself still happens with the json transport.
      assert.strictEqual(flagValue(argv, "--output-format"), "json");
    }).pipe(
      Effect.scoped,
      Effect.provide(makeDriverStackLayer(spawner, "ru-code-textgen-served-empty-")),
    );
  });
});
