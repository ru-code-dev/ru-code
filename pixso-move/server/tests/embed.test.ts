import { assert, describe, it } from "@effect/vitest";
import { DesignerId } from "@pixso-move/contracts";
import { Processor } from "@pixso-move/processor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { corsLayer } from "../src/http/cors.ts";
import { routesLayer } from "../src/http/routes.ts";
import { SqlitePersistenceMemory } from "../src/persistence/sqlite.ts";
import { NodeStore } from "../src/services/nodeStore.ts";
import { NodeStoreLive } from "../src/services/nodeStoreLive.ts";
import { ProcessorLive } from "../src/services/processorLive.ts";
import { ResultStore } from "../src/services/resultStore.ts";
import { ResultStoreLive } from "../src/services/resultStoreLive.ts";
import { FAKE_ACP_TEXT, FakeAcpRunnerLive } from "./fakeAcpRunner.ts";
import { jsonRequest } from "./http/harness.ts";

// The configured designer (see @pixso-move/processor config.ts).
const CONFIGURED = DesignerId.make("dz_c07a93f7-2505-4e60-94af-17a2cc068b79");

// Stores + embedded processor (fake runner) over a fresh in-memory DB — one runtime.
const storesLive = Layer.mergeAll(NodeStoreLive, ResultStoreLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const appServices = ProcessorLive.pipe(
  Layer.provideMerge(storesLive),
  Layer.provide(FakeAcpRunnerLive),
);

describe("processor embed", () => {
  it.effect("processes a configured designer's node to done with the runner's text", () =>
    Effect.gen(function* () {
      const nodeStore = yield* NodeStore;
      const resultStore = yield* ResultStore;
      const processor = yield* Processor;
      const { nodeId } = yield* nodeStore.insert({
        designerId: CONFIGURED,
        rootName: "Card",
        nodesJson: "{}",
        preview: "x",
      });
      yield* processor.runTickOnce;
      const results = yield* resultStore.listByNode(CONFIGURED, nodeId);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "done");
      assert.equal(results[0]!.resultTag, "html-css");
      assert.equal(results[0]!.result, FAKE_ACP_TEXT);
    }).pipe(Effect.provide(appServices)),
  );

  it.effect("stores an unconfigured designer's node but reconciles nothing", () =>
    Effect.gen(function* () {
      const nodeStore = yield* NodeStore;
      const resultStore = yield* ResultStore;
      const processor = yield* Processor;
      const designerId = DesignerId.make("dz_unknown");
      const { nodeId } = yield* nodeStore.insert({
        designerId,
        rootName: "X",
        nodesJson: "{}",
        preview: "x",
      });
      yield* processor.runTickOnce;
      assert.equal((yield* resultStore.listByNode(designerId, nodeId)).length, 0);
    }).pipe(Effect.provide(appServices)),
  );

  it.effect("a failing notify never breaks ingest (still 200)", () =>
    Effect.gen(function* () {
      const failingProcessor = Layer.succeed(Processor, {
        start: Effect.void,
        notify: Effect.die("notify boom"),
        stop: Effect.void,
        runTickOnce: Effect.void,
      });
      const app = Layer.mergeAll(routesLayer, corsLayer).pipe(
        Layer.provideMerge(storesLive),
        Layer.provideMerge(failingProcessor),
      );
      const { handler } = HttpRouter.toWebHandler(app);
      const response = yield* Effect.promise(() =>
        handler(
          jsonRequest("POST", "/ingest", "dz_z", {
            designerId: "dz_z",
            rootName: "C",
            nodesJson: "{}",
            preview: "x",
          }),
        ),
      );
      assert.equal(response.status, 200);
    }),
  );
});
