// ru-code delta coverage: src/config.ts
//
// Covers the fork-added ServerConfig fields `cliJs` / `cliConfigDir` /
// `cliDetected` (the qwen CLI detection result threaded into the runtime
// config) and their test-mode defaults set by `layerTest` (config.ts:178).

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../../config.ts";

it.layer(NodeServices.layer)("config.ts ru-code cli detection fields", (it) => {
  it.effect("layerTest resolves cliDetected=true with cli paths derived from baseDir", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;

      // ru-code test default: qwen treated as detected so the provider is
      // enabled without spawning a real CLI.
      assert.strictEqual(config.cliDetected, true);
      // cliConfigDir is the synthetic CLI home = the test baseDir.
      assert.strictEqual(config.cliConfigDir, config.baseDir);
      // cliJs is a synthetic `<baseDir>/cli.js` path.
      assert.strictEqual(config.cliJs, `${config.baseDir}/cli.js`);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-config-delta-" })),
    ),
  );

  it.effect("the three cli fields are always present on the decoded config shape", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;

      assert.property(config, "cliJs");
      assert.property(config, "cliConfigDir");
      assert.property(config, "cliDetected");
      assert.isString(config.cliJs);
      assert.isString(config.cliConfigDir);
      assert.isBoolean(config.cliDetected);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-config-delta-shape-" }),
      ),
    ),
  );
});
