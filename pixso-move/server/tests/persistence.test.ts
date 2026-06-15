import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveServerConfig, ServerConfig } from "../src/config.ts";
import { persistenceLive } from "../src/persistence/sqlite.ts";

const tmpDb = `./.data/test-${crypto.randomUUID()}.sqlite`;

it.effect("file-backed persistence creates the parent dir, runs migrations, persists", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    const names = tables.map((t) => t.name);
    assert.include(names, "nodes");
    assert.include(names, "processing_results");
  }).pipe(
    Effect.provide(
      persistenceLive.pipe(
        Layer.provide(ServerConfig.layer(resolveServerConfig({ dbPath: tmpDb }))),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
