// ru-code: pins the port-scan opt-in gate — the guarantee that reinstalled/upgraded users
// have scanning OFF and that OFF means ZERO child processes:
//   1. schema decode-default: any settings blob without the field decodes to disabled;
//   2. gate semantics: no settings service in context ⇒ disabled (fail-closed), the setting's
//      live value otherwise;
//   3. the wired scanner: with the gate closed, `scan()` returns [] and the process runner is
//      NEVER invoked — proven with a runner fake that fails the test if called.

import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import * as PortScanner from "../../../preview/PortScanner.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import { layerTest as serverSettingsLayerTest } from "../../../serverSettings.ts";
import { capturePortScanGate } from "../../platform-compat/portScanGate.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("preview.portScanEnabled schema default", () => {
  it("an empty settings blob (fresh/reinstalled install) decodes to DISABLED", () => {
    expect(decodeServerSettings({}).preview.portScanEnabled).toBe(false);
  });

  it("a pre-upgrade settings blob without the field decodes to DISABLED", () => {
    const legacyBlob = { confirmThreadDelete: true, mcp: { autobindDefaults: true } };
    expect(decodeServerSettings(legacyBlob).preview.portScanEnabled).toBe(false);
  });
});

describe("capturePortScanGate", () => {
  it.effect("no settings service at capture time ⇒ disabled (fail-closed)", () =>
    Effect.gen(function* () {
      const gate = yield* capturePortScanGate;
      expect(yield* gate).toBe(false);
    }),
  );

  it.effect("reflects the setting value captured from the construction context", () =>
    Effect.gen(function* () {
      const enabledGate = yield* capturePortScanGate.pipe(
        Effect.provide(serverSettingsLayerTest({ preview: { portScanEnabled: true } })),
      );
      expect(yield* enabledGate).toBe(true);
      const disabledGate = yield* capturePortScanGate.pipe(
        Effect.provide(serverSettingsLayerTest({ preview: { portScanEnabled: false } })),
      );
      expect(yield* disabledGate).toBe(false);
    }),
  );
});

/** Fails the test on ANY spawn attempt — proves "disabled" means zero child processes. */
const explodingProcessRunner = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.die(
        new Error(`port scan gate leaked a spawn: ${input.command} ${input.args.join(" ")}`),
      ),
  }),
);

const scanThroughDiscovery = Effect.gen(function* () {
  const discovery = yield* Effect.service(PortScanner.PortDiscovery);
  return yield* discovery.scan();
});

/**
 * Records every spawn attempt instead of dying on it. `retain` reaches the scanner through
 * `pollTick`, which wraps its body in `Effect.catchCause(logWarning)` — a dying runner would be
 * SWALLOWED there and the test would pass while leaking. Asserting on the recorded list is the
 * only proof that survives that catch.
 */
const recordingProcessRunner = (spawns: Array<string>) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.suspend(() => {
          spawns.push(`${input.command} ${input.args.join(" ")}`);
          return Effect.die(new Error(`port scan gate leaked a spawn: ${input.command}`));
        }),
    }),
  );

describe("PortDiscovery.scan with the gate closed", () => {
  it.effect("returns [] and never spawns anything (no settings service = disabled)", () =>
    Effect.gen(function* () {
      expect(yield* scanThroughDiscovery).toEqual([]);
    }).pipe(
      Effect.provide(
        PortScanner.layer.pipe(
          Layer.provide(explodingProcessRunner),
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
          Layer.provide(Net.layer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    ),
  );

  it.effect("returns [] and never spawns with the setting explicitly OFF", () =>
    Effect.gen(function* () {
      expect(yield* scanThroughDiscovery).toEqual([]);
    }).pipe(
      Effect.provide(
        PortScanner.layer.pipe(
          Layer.provide(explodingProcessRunner),
          Layer.provide(serverSettingsLayerTest({ preview: { portScanEnabled: false } })),
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
          Layer.provide(Net.layer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    ),
  );

  // ru-code: `scan()` above is only ONE of the two ways into the guarded scanner. Retaining the
  // poll loop runs an immediate `pollTick`, which reaches it through `scanSnapshot` — that path
  // was previously covered by reading the call graph rather than by executing it.
  it.effect("retaining the poll loop never spawns with the gate closed", () =>
    Effect.gen(function* () {
      const spawns: Array<string> = [];
      yield* Effect.gen(function* () {
        const discovery = yield* Effect.service(PortScanner.PortDiscovery);
        yield* discovery.retain;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          PortScanner.layer.pipe(
            Layer.provide(recordingProcessRunner(spawns)),
            Layer.provide(serverSettingsLayerTest({ preview: { portScanEnabled: false } })),
            Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
            Layer.provide(Net.layer),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );
      expect(spawns).toEqual([]);
    }),
  );
});
