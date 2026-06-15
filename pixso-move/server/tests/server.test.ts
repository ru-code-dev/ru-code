import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveServerConfig, ServerConfig } from "../src/config.ts";
import { makeServerLayer } from "../src/server.ts";
import { FakeAcpRunnerLive } from "./fakeAcpRunner.ts";

const PORT = 17789;
const key = "dz_alice";
const body = { designerId: key, rootName: "Card", nodesJson: '{"id":"1"}', preview: "iVBOR" };

// Integration: builds the real server layer (HTTP listener + logger + stores +
// persistence), binds a port, and round-trips a request over a real socket.
it.effect("real server ingests and lists over HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(makeServerLayer);
      const base = `http://127.0.0.1:${PORT}`;

      const ingest = yield* Effect.promise(() =>
        fetch(`${base}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-designer-id": key },
          body: JSON.stringify(body),
        }),
      );
      assert.equal(ingest.status, 200);

      const list = yield* Effect.promise(() =>
        fetch(`${base}/nodes`, { headers: { "x-designer-id": key } }),
      );
      assert.equal(list.status, 200);
      assert.equal(((yield* Effect.promise(() => list.json())) as unknown[]).length, 1);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer(resolveServerConfig({ port: PORT, dbPath: ":memory:" })),
        FakeAcpRunnerLive,
      ),
    ),
  ),
);
