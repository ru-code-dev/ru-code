import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { resolveServerConfig, ServerConfig } from "../src/config.ts";
import { makeServerLayer } from "../src/server.ts";
import { FakeAcpRunnerLive } from "./fakeAcpRunner.ts";

const PORT = 17789;
const key = "dz_alice";
const body = { designerId: key, rootName: "Card", nodesJson: '{"id":"1"}', preview: "iVBOR" };

// Integration: builds the real server layer (HTTP listener + logger + stores +
// persistence), binds a port, and round-trips a request over a real socket via HttpClient.
it.effect("real server ingests and lists over HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(makeServerLayer);
      const base = `http://127.0.0.1:${PORT}`;
      const client = yield* HttpClient.HttpClient;

      const ingestRequest = yield* HttpClientRequest.post(`${base}/ingest`, {
        headers: { "x-designer-id": key },
      }).pipe(HttpClientRequest.bodyJson(body));
      const ingest = yield* client.execute(ingestRequest);
      assert.equal(ingest.status, 200);

      const list = yield* client.get(`${base}/nodes`, { headers: { "x-designer-id": key } });
      assert.equal(list.status, 200);
      const nodes = yield* HttpClientResponse.schemaBodyJson(Schema.Array(Schema.Unknown))(list);
      assert.equal(nodes.length, 1);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer(resolveServerConfig({ port: PORT, dbPath: ":memory:" })),
        FakeAcpRunnerLive,
        NodeHttpClient.layerUndici,
      ),
    ),
  ),
);
