// ru-code: the Pixso assistant hello-RPC round trip (phase-1 wiring proof).
//
// Drives the REAL exported seams end to end: the host layer (PixsoAssistantHostLayer
// over a test ServerConfig) yields the package service, the REAL handler builder
// produces the ws handler map, the handler runs, and the result survives the wire
// codec (PanelSnapshot encode→decode — what the rpc transport does). Also guards the
// two fail-fast invariants ws.ts relies on: every declared RPC has a handler AND a
// scope row (a method missing either would abort the ws layer at build).

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import {
  emptyPanelSnapshot,
  PanelSnapshot,
  PIXSO_ASSISTANT_METHODS,
  pixsoAssistantRpcs,
} from "@smart-tools/t3-code-pixso-mcp-assistant/contracts";
import { PixsoAssistant } from "@smart-tools/t3-code-pixso-mcp-assistant/server";

import { ServerConfig } from "../../../config.ts";
import { PixsoAssistantHostLayer } from "../../pixso-assistant/ports.ts";
import {
  buildPixsoAssistantRpcHandlers,
  PIXSO_ASSISTANT_RPC_SCOPES,
  type ObservePixsoAssistantRpc,
  type ObservePixsoAssistantRpcStream,
} from "../../pixso-assistant/rpcHandlers.ts";

const passThroughObserve: ObservePixsoAssistantRpc = (_method, effect) => effect;
const passThroughObserveStream: ObservePixsoAssistantRpcStream = (_method, stream) => stream;
const encodeSnapshot = Schema.encodeEffect(PanelSnapshot);
const decodeSnapshot = Schema.decodeUnknownEffect(PanelSnapshot);

const makeTestLayer = () =>
  PixsoAssistantHostLayer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pixso-hello-" })),
    Layer.provideMerge(NodeServices.layer),
  );

describe("pixso-assistant snapshot RPC (hello round trip)", () => {
  it.effect("serves the snapshot through the real handler map and wire codec", () =>
    Effect.gen(function* () {
      const pixsoAssistant = yield* PixsoAssistant;
      const handlers = buildPixsoAssistantRpcHandlers({
        pixsoAssistant,
        observePixsoAssistantRpc: passThroughObserve,
        observePixsoAssistantRpcStream: passThroughObserveStream,
      });
      const snapshot = yield* handlers[PIXSO_ASSISTANT_METHODS.pixsoAssistantSnapshot]({});
      // The transport boundary: encode as the rpc layer would, decode as the client would.
      const encoded = yield* encodeSnapshot(snapshot);
      const decoded = yield* decodeSnapshot(encoded);
      assert.deepStrictEqual(decoded, emptyPanelSnapshot);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("creates the feature dir under stateDir (the one host port)", () =>
    Effect.gen(function* () {
      // Force the layer to build (the port mkdirs on construction), then inspect disk.
      yield* PixsoAssistant;
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = yield* fileSystem.exists(path.join(config.stateDir, "pixso-assistant"));
      assert.isTrue(exists);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it("declares a handler and a scope row for every assistant RPC (ws fail-fast invariants)", () => {
    const declaredMethods = pixsoAssistantRpcs.map((rpc) => rpc._tag).sort();
    const mappedMethods = Object.values(PIXSO_ASSISTANT_METHODS).sort();
    const scopedMethods = Object.keys(PIXSO_ASSISTANT_RPC_SCOPES).sort();
    assert.deepStrictEqual(declaredMethods, mappedMethods);
    assert.deepStrictEqual(scopedMethods, mappedMethods);
  });

  it("scopes check as Operate — it records state and dials the socket (D-L1)", () => {
    const scopes = new Map(Object.entries(PIXSO_ASSISTANT_RPC_SCOPES));
    assert.strictEqual(
      scopes.get(PIXSO_ASSISTANT_METHODS.pixsoAssistantCheck),
      AuthOrchestrationOperateScope,
    );
    // …and the read-only siblings did NOT get flipped along with it.
    assert.strictEqual(
      scopes.get(PIXSO_ASSISTANT_METHODS.pixsoAssistantSnapshot),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      scopes.get(PIXSO_ASSISTANT_METHODS.pixsoAssistantCard),
      AuthOrchestrationReadScope,
    );
  });

  it("uses the host namespace idiom — no reserved `server.` prefix (D-L16)", () => {
    for (const method of Object.values(PIXSO_ASSISTANT_METHODS)) {
      assert.isFalse(method.startsWith("server."), `${method} keeps the reserved prefix`);
    }
    assert.strictEqual(
      PIXSO_ASSISTANT_METHODS.pixsoAssistantScanSubscribe,
      "subscribePixsoScan",
      "the stream uses the bare subscribeX form",
    );
  });

  it.effect("builds ONE PixsoAssistant under a shared MemoMap (server.ts and ws.ts share it)", () =>
    Effect.gen(function* () {
      // ws.ts and server.ts provide the SAME module-level layer reference; layer
      // memoization is what keeps that to one job/store instance rather than two
      // competing scanners over the same store directory.
      const scope = yield* Effect.scope;
      const memoMap = Layer.makeMemoMapUnsafe();
      const provided = makeTestLayer();
      const first = yield* Layer.buildWithMemoMap(provided, memoMap, scope);
      const second = yield* Layer.buildWithMemoMap(provided, memoMap, scope);
      assert.strictEqual(Context.get(first, PixsoAssistant), Context.get(second, PixsoAssistant));
    }).pipe(Effect.scoped),
  );

  it("wires the package's bilingual resolver at the server seam (D-L2)", async () => {
    // ports.ts calls configurePixsoAssistantLocale(getLocale) at module load; importing the
    // module above is what performs it. Assert the seam exists rather than re-testing the
    // package's own resolver (covered by the package suite).
    const portsSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../pixso-assistant/ports.ts", import.meta.url), "utf8"),
    );
    assert.include(portsSource, "configurePixsoAssistantLocale(getLocale)");
  });
});
