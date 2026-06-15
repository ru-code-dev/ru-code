import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DEFAULT_PORT, resolveServerConfig, ServerConfig } from "../src/config.ts";

it.effect("layer provides the resolved config", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    assert.equal(config.port, 9999);
    assert.equal(config.host, "0.0.0.0");
  }).pipe(Effect.provide(ServerConfig.layer(resolveServerConfig({ port: 9999, host: "0.0.0.0" })))),
);

it.effect("layerTest defaults to an in-memory db and applies overrides", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    assert.equal(config.dbPath, ":memory:");
    assert.equal(config.host, "1.2.3.4");
  }).pipe(Effect.provide(ServerConfig.layerTest({ host: "1.2.3.4" }))),
);

it("resolveServerConfig merges over the defaults", () => {
  assert.equal(resolveServerConfig({}).port, DEFAULT_PORT);
  assert.equal(resolveServerConfig({ port: 1 }).port, 1);
});
