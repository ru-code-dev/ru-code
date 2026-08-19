// ru-code: WIRE proof for session-start auth + per-turn setModel. Builds the REAL
// QwenAcpSessionRuntime via `makeQwenAcpRuntime` (so the QwenAcpSupport auth
// resolution runs) over the queue-backed fake ACP agent (real ndJSON-RPC stdio,
// no process), and captures the exact bytes sent:
//   - `authenticate.methodId` at session start == resolveDefaultAuthMethod(settings)
//     (this is what qwen's `session/new`→`ensureAuthenticated` requires).
//   - `session/set_config_option` { configId:"model", value } — the value setModel
//     transmits verbatim (the adapter feeds it the `${slug}(${authMethod})` encoding).
// Calling `runtime.setModel(...)` drives the whole start handshake
// (initialize → authenticate → session/new) and THEN the config write, so one call
// exercises both captures. Fails if the auth resolution or setModel plumbing drifts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { makeQwenAcpRuntime } from "../../../qwen/QwenAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "../../../qwen/acp/QwenAcpSessionRuntime.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decode = Schema.decodeSync(QwenSettings);

interface WireCapture {
  authMethodId?: string;
  readonly configOptions: Array<{ configId: string; value: string | boolean }>;
}

// Drive the REAL runtime over the queue-backed fake agent; `use` runs with the
// live runtime, `capture` is populated by the fake as the wire flows.
const withWireRuntime = (
  settings: Record<string, unknown>,
  // `use` may fail (setModel returns an AcpError channel); Effect.orDie below seals
  // it, so the returned effect satisfies it.effect's Effect<void, never> contract.
  use: (
    runtime: AcpSessionRuntimeShape,
    capture: WireCapture,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>,
): Effect.Effect<void> => {
  const capture: WireCapture = { configOptions: [] };
  const script: FakeAcpScript = {
    onPrompt: (steps) => steps.respondOk(),
    onAuthenticate: (methodId) => {
      capture.authMethodId = methodId;
    },
    onSetConfigOption: (configId, value) => {
      capture.configOptions.push({ configId, value });
    },
  };
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeQwenAcpRuntime({
      childProcessSpawner,
      qwenSettings: decode(settings),
      cliJs: "/opt/cli.js",
      cwd: "/tmp/qwen-wire",
      clientInfo: { name: "t3-code", version: "0.0.0" },
    });
    // Start the session (initialize → authenticate → session/new) — this is what
    // the adapter does before the first turn; it populates the authenticate capture.
    yield* runtime.start();
    yield* use(runtime, capture);
  }).pipe(
    Effect.provide(fakeAcpSpawnerLayer(script)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // A runtime construction failure is a test defect; it.effect wants Effect<_, never>.
    Effect.orDie,
  );
};

const modelValue = (capture: WireCapture) =>
  capture.configOptions.find((option) => option.configId === "model")?.value;

describe("qwen auth + setModel wire", () => {
  it.effect("custom profile → session-start authenticate uses openai", () =>
    withWireRuntime({ profile: "custom" }, (runtime, capture) =>
      Effect.gen(function* () {
        yield* runtime.setModel("qwen3-coder-plus(openai)");
        expect(capture.authMethodId).toBe("openai");
      }),
    ),
  );

  it.effect("stock qwen profile → session-start authenticate uses qwen-oauth", () =>
    withWireRuntime({ profile: "qwen" }, (runtime, capture) =>
      Effect.gen(function* () {
        yield* runtime.setModel("m(qwen-oauth)");
        expect(capture.authMethodId).toBe("qwen-oauth");
      }),
    ),
  );

  it.effect("per-instance defaultAuthMethod override wins for session-start auth", () =>
    withWireRuntime({ profile: "qwen", defaultAuthMethod: "openai" }, (runtime, capture) =>
      Effect.gen(function* () {
        yield* runtime.setModel("m(openai)");
        expect(capture.authMethodId).toBe("openai");
      }),
    ),
  );

  it.effect("setModel transmits the encoded value verbatim as configId 'model'", () =>
    withWireRuntime({ profile: "qwen" }, (runtime, capture) =>
      Effect.gen(function* () {
        yield* runtime.setModel("custom-x(anthropic)");
        expect(modelValue(capture)).toBe("custom-x(anthropic)");
      }),
    ),
  );
});
