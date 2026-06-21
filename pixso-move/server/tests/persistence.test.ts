import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveServerConfig, ServerConfig } from "../src/config.ts";
import { persistenceLive } from "../src/persistence/sqlite.ts";

// Build persistence over a fresh file path under a not-yet-existing parent dir, so the test
// exercises directory creation. The unique suffix comes from the Effect Crypto service.
const persistenceWithFreshDb = Layer.unwrap(
  Effect.gen(function* () {
    const uuid = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
    const tmpDb = `./.data/test-${uuid}.sqlite`;
    return persistenceLive.pipe(
      Layer.provide(ServerConfig.layer(resolveServerConfig({ dbPath: tmpDb }))),
      Layer.provide(NodeServices.layer),
    );
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("file-backed persistence creates the parent dir, runs migrations, persists", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    const names = tables.map((t) => t.name);
    assert.include(names, "nodes");
    assert.include(names, "processing_results");
  }).pipe(Effect.provide(persistenceWithFreshDb)),
);
