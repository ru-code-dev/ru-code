// ru-code: the plugin RPC seam, end to end through the REAL exported pieces.
//
// What this file is for. `plugin.invoke` is the one door between a ws client and
// code the host never saw before, so the things worth pinning are the ones a
// refactor could quietly change: which scope each method costs, that a failure
// arrives as a CLOSED `PluginRpcError.reason` rather than a leaked exception, and
// that the values on both sides survive the wire codec.
//
// Everything below drives the real seams — `PluginHostLayer` over a real fixture
// folder, the real `buildPluginRpcHandlers`, the real `PLUGIN_RPC_SCOPES` and the
// real `requiredScopeForRpcMethod` from the shared table. The one thing rebuilt
// here rather than imported is ws.ts's `authorizeEffect` closure (it closes over a
// live session and cannot be reached from a test); it is reproduced byte-for-byte
// in `observeWithScopes` so the auth-folding path is exercised, not assumed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  PLUGIN_METHODS,
  pluginRpcs,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { PluginId, PluginRpcError, WebManifestList } from "@smart-tools/plugin-sdk/contracts";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { PluginHost, PluginHostLayer } from "./PluginHost.ts";
import {
  buildPluginRpcHandlers,
  PLUGIN_RPC_SCOPES,
  tracePluginRpc,
  type ObservePluginRpc,
} from "./rpcHandlers.ts";

const manifestJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, ...overrides });

/** A plugin that answers `echo`, throws from `boom`, and reports its own id. */
const echoPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  activate(host) {
    host.registerRpc("echo", async (payload) => ({ echoed: payload, id: host.id }));
    host.registerRpc("boom", async () => {
      throw new Error("handler exploded");
    });
  },
};
`,
});

const makeBaseDir = (plugins: Readonly<Record<string, Readonly<Record<string, string>>>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-rpc-" }),
    );
    for (const [id, files] of Object.entries(plugins)) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(baseDir, "plugins", id, rel);
        yield* Effect.orDie(fs.makeDirectory(path.dirname(abs), { recursive: true }));
        yield* Effect.orDie(fs.writeFileString(abs, content));
      }
    }
    return baseDir;
  });

const startHost = (baseDir: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      PluginHostLayer.pipe(
        Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
        // ru-code (A22): `PluginHostLayer` self-provides `ProjectionProjectRepositoryLive` for
        // `host.projects` (O2-a), so it needs a `SqlClient` the way every read-model consumer does.
        // `server.ts` / `ws.ts` already have one ambient; a unit test gets an in-memory one. The
        // database is EMPTY on purpose — no `projection_projects` table — so every test here also
        // exercises the degraded path (`listLive` logs and answers `[]`, never rejecting into
        // plugin code). A test that needs real projects seeds the table itself.
        Layer.provide(NodeSqliteClient.layerMemory()),
      ),
    );
    const host = Context.get(context, PluginHost);
    yield* host.start;
    return host;
  });

/** No auth, no tracing — for the cases that are about dispatch, not scopes. */
const passThroughObserve: ObservePluginRpc = (_method, effect) => effect;

/**
 * ws.ts's wrapper, rebuilt over an explicit scope list.
 *
 * Same three moves in the same order as `observePluginRpc` in `ws.ts`: consult the
 * SHARED scope table (`requiredScopeForRpcMethod`, not a local copy), fail with
 * `EnvironmentAuthorizationError` when the session lacks it, then fold that into
 * `PluginRpcError({ reason: "unauthorized" })` — the only error these RPCs declare.
 * The trace stays OUTSIDE the authorize step, as it does in ws.ts.
 */
const observeWithScopes = (scopes: ReadonlyArray<AuthEnvironmentScope>): ObservePluginRpc => {
  // `andThen`, so a rejected call never runs the effect it guards — the property
  // ws.ts's `authorizeEffect` has, and the reason the trace sits outside it.
  const guard = (method: string): Effect.Effect<void, EnvironmentAuthorizationError> =>
    Effect.suspend(() => {
      const requiredScope = requiredScopeForRpcMethod(method);
      return scopes.includes(requiredScope)
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              message: `The authenticated token is missing required scope: ${requiredScope}.`,
              requiredScope,
            }),
          );
    });
  return (method, effect) =>
    tracePluginRpc(
      method,
      guard(method).pipe(
        Effect.andThen(effect),
        Effect.catchTag("EnvironmentAuthorizationError", (error) =>
          Effect.fail(new PluginRpcError({ reason: "unauthorized", detail: error.message })),
        ),
      ),
    );
};

const reasonOf = (effect: Effect.Effect<unknown, PluginRpcError>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => (Result.isFailure(result) ? result.failure.reason : "<succeeded>")),
  );

const detailOf = (effect: Effect.Effect<unknown, PluginRpcError>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => (Result.isFailure(result) ? (result.failure.detail ?? "") : "")),
  );

const encodeUnknown = Schema.encodeUnknownEffect(Schema.Unknown);
const encodeManifestList = Schema.encodeEffect(WebManifestList);
const decodeManifestList = Schema.decodeUnknownEffect(WebManifestList);

describe("plugin RPC contract (no host needed)", () => {
  it("declares a scope row for every plugin RPC, and no row for anything else", () => {
    const declared = Object.values(PLUGIN_METHODS).sort();
    expect(declared).toEqual(["plugin.invoke", "plugin.list"]);
    expect(Object.keys(PLUGIN_RPC_SCOPES).sort()).toEqual(declared);
  });

  it("is registered in WsRpcGroup exactly once each — the D3 'edited once' claim", () => {
    const tags = [...WsRpcGroup.requests.keys()];
    for (const method of Object.values(PLUGIN_METHODS)) {
      expect(tags.filter((tag) => tag === method)).toHaveLength(1);
    }
    // Nothing else in the whole ws surface belongs to the plugin system: one
    // generic door, not a method per plugin.
    expect(tags.filter((tag) => tag.startsWith("plugin.")).sort()).toEqual(
      Object.values(PLUGIN_METHODS).sort(),
    );
  });

  it("costs read for list and operate for invoke", () => {
    // The asymmetry IS the decision: a plugin handler is arbitrary code that may
    // write, and nothing in a method name says otherwise.
    expect(requiredScopeForRpcMethod(PLUGIN_METHODS.pluginList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(PLUGIN_METHODS.pluginInvoke)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("keeps the invoke payload's plugin id inside the PluginId charset", () => {
    const invokeRpc = WsRpcGroup.requests.get(PLUGIN_METHODS.pluginInvoke);
    expect(invokeRpc).toBeDefined();
    const decode = Schema.decodeUnknownExit(invokeRpc!.payloadSchema);
    // A traversal-shaped id never becomes a decoded payload, so it can never reach
    // the host's status table (or, through it, a filesystem path).
    for (const pluginId of ["../evil", "Demo", "a/b", "", "x".repeat(64)]) {
      expect(decode({ pluginId, method: "echo", payload: {} })._tag).toBe("Failure");
    }
    expect(decode({ pluginId: "demo", method: "echo", payload: { a: 1 } })._tag).toBe("Success");
    // An empty method name is refused before dispatch, not after.
    expect(decode({ pluginId: "demo", method: "", payload: null })._tag).toBe("Failure");
    // `host.invoke("m")` with no argument: JSON drops `undefined`, so the key is
    // simply ABSENT on the wire. A required `payload` would reject every such call.
    expect(decode({ pluginId: "demo", method: "echo" })._tag).toBe("Success");
    expect(decode({ pluginId: "demo", method: "echo", payload: null })._tag).toBe("Success");
  });
});

it.layer(NodeServices.layer)("plugin RPC handlers", (it) => {
  it.effect("plugin.list serves the host's status table through the wire codec", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        good: echoPlugin("good"),
        junk: { "plugin.json": "{oops" },
      });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
      });

      const listed = yield* handlers[PLUGIN_METHODS.pluginList]({});
      // Encode as the rpc layer would, decode as the client would.
      const roundTripped = yield* decodeManifestList(yield* encodeManifestList(listed));
      expect(roundTripped.map((status) => [status.id, status.state])).toEqual([
        ["good", "loaded"],
        // The plugins that did NOT load are the half a caller needs in order to
        // explain an empty panel, so they are carried, not filtered.
        ["junk", "skipped"],
      ]);
    }),
  );

  it.effect("plugin.invoke dispatches to the plugin's own handler and returns its value", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
      });

      const result = yield* handlers[PLUGIN_METHODS.pluginInvoke]({
        pluginId: "good",
        method: "echo",
        payload: { a: 1, nested: { b: [1, 2, 3] } },
      });
      expect(result).toEqual({ echoed: { a: 1, nested: { b: [1, 2, 3] } }, id: "good" });
      // `Schema.Unknown` on the success side must not flatten the object on the way
      // out — this is the whole reason a plugin can define its own contract.
      const encoded = yield* encodeUnknown(result);
      expect(encoded).toEqual(result);
    }),
  );

  it.effect("every host failure arrives as a closed PluginRpcError reason", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bad: {
          "plugin.json": manifestJson("bad", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { activate() { throw new Error("nope"); } };`,
        },
        good: echoPlugin("good"),
      });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
      });
      const invoke = (pluginId: string, method: string) =>
        handlers[PLUGIN_METHODS.pluginInvoke]({ pluginId, method, payload: null });

      expect(yield* reasonOf(invoke("missing", "echo"))).toBe("unknown-plugin");
      expect(yield* reasonOf(invoke("good", "nope"))).toBe("unknown-method");
      expect(yield* reasonOf(invoke("bad", "echo"))).toBe("plugin-disabled");
      expect(yield* reasonOf(invoke("good", "boom"))).toBe("plugin-failed");
    }),
  );

  it.effect("a throwing handler reports its message and nothing else", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
      });

      const detail = yield* detailOf(
        handlers[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "good",
          method: "boom",
          payload: null,
        }),
      );
      // The plugin author's message, verbatim — that is what an author can act on.
      expect(detail).toBe("handler exploded");
      // …and NOT the stack, which would ship the host's absolute filesystem layout
      // to any client that can reach the socket.
      expect(detail).not.toContain(baseDir);
      expect(detail).not.toContain("at ");
      expect(detail).not.toContain(".mjs");
    }),
  );

  it.effect("a read-scoped session may list but may not invoke", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const readOnly = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: observeWithScopes([AuthOrchestrationReadScope]),
      });

      // Read scope is enough for the list…
      const listed = yield* readOnly[PLUGIN_METHODS.pluginList]({});
      expect(listed.map((status) => status.id)).toEqual(["good"]);

      // …and not enough for the door that runs plugin code.
      const invoked = readOnly[PLUGIN_METHODS.pluginInvoke]({
        pluginId: "good",
        method: "echo",
        payload: { a: 1 },
      });
      expect(yield* reasonOf(invoked)).toBe("unauthorized");
      expect(yield* detailOf(invoked)).toContain(AuthOrchestrationOperateScope);
    }),
  );

  it.effect("an operate-scoped session may do both", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const operator = buildPluginRpcHandlers({
        pluginHost: host,
        // A real session carries both; operate alone must still not lock the read out
        // of its own feature, hence both rows are exercised.
        observePluginRpc: observeWithScopes([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      });

      expect(yield* operator[PLUGIN_METHODS.pluginList]({})).toHaveLength(1);
      expect(
        yield* operator[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "good",
          method: "echo",
          payload: { a: 1 },
        }),
      ).toEqual({ echoed: { a: 1 }, id: "good" });
    }),
  );

  it.effect("an unauthorized invoke never reaches the plugin", () =>
    Effect.gen(function* () {
      // The proof is observable, not structural: the plugin counts its calls in its
      // own storage, so a handler that ran despite the scope check would leave a row.
      const baseDir = yield* makeBaseDir({
        counter: {
          "plugin.json": manifestJson("counter", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  migrations: [{ id: "001", sql: "CREATE TABLE calls (id INTEGER PRIMARY KEY)" }],
  activate(host) {
    host.registerRpc("touch", async () => {
      await host.storage.exec("INSERT INTO calls DEFAULT VALUES");
      const rows = await host.storage.query("SELECT COUNT(*) AS n FROM calls");
      return rows[0].n;
    });
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const readOnly = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: observeWithScopes([AuthOrchestrationReadScope]),
      });
      const operator = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: observeWithScopes([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      });
      const touch = (handlers: ReturnType<typeof buildPluginRpcHandlers>) =>
        handlers[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "counter",
          method: "touch",
          payload: null,
        });

      expect(yield* reasonOf(touch(readOnly))).toBe("unauthorized");
      // First row written by the FIRST authorized call ⇒ the rejected one never ran.
      expect(yield* touch(operator)).toBe(1);
    }),
  );
});

// ── the wire, for real ───────────────────────────────────────────────────────
//
// `RpcTest.makeClient` drives a generated CLIENT against real handlers through the
// normal Rpc machinery (requests, responses, error channel) without opening a
// socket. Doing it against the whole `WsRpcGroup` would demand handlers for every
// one of its ~190 methods, so the group here is built from `pluginRpcs` alone —
// the SAME two definitions `rpc.ts` spreads into `WsRpcGroup`, so what is
// exercised is the shipped contract, not a copy of it.
//
// This is where the schema choices are proven rather than asserted: a branded
// `PluginId` decoded from the wire, an arbitrary object surviving `Schema.Unknown`
// in BOTH directions, and `PluginRpcError` arriving as a typed failure with its
// reason intact.
const PluginRpcTestGroup = RpcGroup.make(...pluginRpcs);

it.layer(NodeServices.layer)("plugin RPCs over the Rpc transport", (it) => {
  it.effect("a client round-trips list, invoke and a typed failure", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
      });
      const client = yield* RpcTest.makeClient(PluginRpcTestGroup).pipe(
        Effect.provide(PluginRpcTestGroup.toLayer(handlers)),
      );

      const listed = yield* client[PLUGIN_METHODS.pluginList]({});
      expect(listed.map((status) => [status.id, status.state])).toEqual([["good", "loaded"]]);

      const echoed = yield* client[PLUGIN_METHODS.pluginInvoke]({
        // Branded at the call site, exactly as a decoded wire payload would be.
        pluginId: PluginId.make("good"),
        method: "echo",
        payload: { a: 1, deep: { b: "two" } },
      });
      expect(echoed).toEqual({ echoed: { a: 1, deep: { b: "two" } }, id: "good" });

      // A no-argument call: the web port omits the key entirely when the plugin
      // passed nothing, and the plugin's handler must see `undefined`.
      const bare = yield* client[PLUGIN_METHODS.pluginInvoke]({
        pluginId: PluginId.make("good"),
        method: "echo",
      });
      expect(bare).toEqual({ echoed: undefined, id: "good" });

      // The failure crosses as `PluginRpcError`, not as a defect and not as a
      // transport error — that is what lets a caller branch on `reason`.
      const failure = yield* Effect.result(
        client[PLUGIN_METHODS.pluginInvoke]({
          pluginId: PluginId.make("good"),
          method: "nope",
          payload: null,
        }),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure._tag).toBe("PluginRpcError");
        expect(failure.failure.reason).toBe("unknown-method");
        expect(failure.failure.detail).toBe("good.nope");
      }
    }),
  );
});
