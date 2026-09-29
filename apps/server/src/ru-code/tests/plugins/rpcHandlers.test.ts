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
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

import { requiredScopeForRpcMethod } from "../../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../../config.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { PluginHost, PluginHostLayer } from "../../plugins/PluginHost.ts";
import { SHIPPED_PLUGINS_DIR_ENV_VAR } from "../../plugins/paths.ts";
import {
  buildPluginRpcHandlers,
  PLUGIN_RPC_SCOPES,
  tracePluginRpc,
  type ObservePluginRpc,
  type ObservePluginRpcStream,
} from "../../plugins/rpcHandlers.ts";

/**
 * ru-code (V2-21): pin the SHIPPED root OFF for this file.
 *
 * `resolveShippedPluginsDir` probes `<module dir>/../../../dist/plugins` so `pnpm dev` picks up
 * `pnpm stage:plugins`' output — and under vitest this module IS the source file, so a developer
 * who has staged the real shipped set would otherwise have `analytics` and `catalogs` load into
 * every case below. The env var is the test-only override (see `paths.ts`); pointing it at a
 * folder that does not exist is how a test says "no shipped root". Restored afterwards because the
 * vitest worker is reused across files.
 */
const NO_SHIPPED_ROOT = `${import.meta.dirname}/__no-shipped-plugins__`;
let shippedRootBeforeSuite: string | undefined;
beforeAll(() => {
  shippedRootBeforeSuite = process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
  process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = NO_SHIPPED_ROOT;
});
afterAll(() => {
  if (shippedRootBeforeSuite === undefined) delete process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
  else process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = shippedRootBeforeSuite;
});

const manifestJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 2, ...overrides });

/** A plugin that answers `echo`, throws from `boom`, and reports its own id. */
const echoPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  rpc: {
    // The optional field, spelled the way the wire requires: ABSENT, never a key holding
    // \`undefined\` (S37). \`echo-raw\` below keeps the wrong spelling on purpose.
    "echo": async (payload, ctx) => ({
      ...(payload === undefined ? {} : { echoed: payload }),
      id: ctx.pluginId,
    }),
    "echo-raw": async (payload, ctx) => ({ echoed: payload, id: ctx.pluginId }),
    "boom": async () => {
      throw new Error("handler exploded");
    },
    // S69 (V2-58): a handler that PUBLISHES — the path from a plugin's own call to a tab's stream.
    "publish": async (payload, ctx) => {
      ctx.publish("rows", payload);
      return null;
    },
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

/** `<baseDir>/userdata`, where the plugin state — including `disabled.json` — lives. */
const stateDirOf = (baseDir: string) => `${baseDir}/userdata`;

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
const passThroughObserve: ObservePluginRpc = (_trace, effect) => effect;
/** ru-code S53 (V2-54): the stream half of the same wrapper — the scope check is exercised below. */
const passThroughObserveStream: ObservePluginRpcStream = (_method, stream) => stream;

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
  return (trace, effect) =>
    tracePluginRpc(
      trace,
      guard(trace.method).pipe(
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
    // S38 (V2-43) added the Settings ▸ Plugins pair. Still ONE generic invoke door: these two are
    // about which plugins RUN, which is the host's own question and not any plugin's.
    //
    // S69 (V2-58) added `plugin.state`, the one STREAM — and it is generic for the same reason
    // plus one more: a tab hosts every plugin, so it subscribes once and the frame says which
    // plugin a value belongs to. Still no method per plugin, and there never will be one. (V2-75
    // removed the notify transport's `plugin.notifications` and `plugin.state.read`.)
    expect(declared).toEqual([
      "plugin.invoke",
      "plugin.list",
      "plugin.setEnabled",
      "plugin.settings",
      "plugin.state",
    ]);
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
        observePluginRpcStream: passThroughObserveStream,
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
        observePluginRpcStream: passThroughObserveStream,
      });

      const result = yield* handlers[PLUGIN_METHODS.pluginInvoke]({
        pluginId: "good",
        method: "echo",
        payload: { a: 1, nested: { b: [1, 2, 3] } },
      });
      // S104 (V2-73): the answer is the handler's value in an envelope with the hub's position.
      expect(result.value).toEqual({ echoed: { a: 1, nested: { b: [1, 2, 3] } }, id: "good" });
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
        observePluginRpcStream: passThroughObserveStream,
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
        observePluginRpcStream: passThroughObserveStream,
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
        observePluginRpcStream: passThroughObserveStream,
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
        observePluginRpcStream: passThroughObserveStream,
      });

      expect(yield* operator[PLUGIN_METHODS.pluginList]({})).toHaveLength(1);
      expect(
        (yield* operator[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "good",
          method: "echo",
          payload: { a: 1 },
        })).value,
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
  rpc: {
    "touch": async (_payload, ctx) => {
      await ctx.storage.exec("INSERT INTO calls DEFAULT VALUES");
      const rows = await ctx.storage.query("SELECT COUNT(*) AS n FROM calls");
      return rows[0].n;
    },
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const readOnly = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: observeWithScopes([AuthOrchestrationReadScope]),
        observePluginRpcStream: passThroughObserveStream,
      });
      const operator = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: observeWithScopes([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
        observePluginRpcStream: passThroughObserveStream,
      });
      const touch = (handlers: ReturnType<typeof buildPluginRpcHandlers>) =>
        handlers[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "counter",
          method: "touch",
          payload: null,
        });

      expect(yield* reasonOf(touch(readOnly))).toBe("unauthorized");
      // First row written by the FIRST authorized call ⇒ the rejected one never ran.
      expect((yield* touch(operator)).value).toBe(1);
    }),
  );
});

// ── S69 (V2-58): a published value, from a plugin's handler to every tab ───

it.layer(NodeServices.layer)("plugin.state", (it) => {
  it.effect("a handler's publish reaches every tab's stream ONCE per change", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
        observePluginRpcStream: passThroughObserveStream,
      });
      const settle = Effect.yieldNow.pipe(Effect.replicateEffect(20), Effect.asVoid);
      const publish = (payload: unknown) =>
        handlers[PLUGIN_METHODS.pluginInvoke]({ pluginId: "good", method: "publish", payload });

      yield* publish({ n: 1 });
      const tabs = [[], []] as [Array<unknown>, Array<unknown>];
      for (const into of tabs) {
        yield* Stream.runForEach(handlers[PLUGIN_METHODS.pluginState]({}), (frame) =>
          Effect.sync(() => {
            into.push(frame);
          }),
        ).pipe(Effect.forkScoped);
      }
      yield* settle;

      yield* publish({ n: 1 }); // equal — nothing moves
      yield* publish({ n: 2 });
      yield* settle;

      for (const seen of tabs) {
        expect(seen).toEqual([
          {
            _tag: "snapshot",
            values: [{ pluginId: "good", name: "rows", value: { n: 1 } }],
            boot: expect.any(String),
            seq: 1,
          },
          { _tag: "value", pluginId: "good", name: "rows", value: { n: 2 }, floor: 2 },
        ]);
      }
    }),
  );

  // S104 (V2-73, option 1): the answer carries the hub's position when the handler RETURNED, so the
  // web host can hold the call until the tab holds every value published before it — here the
  // handler's own publish, the frame that used to lose the race to the answer.
  it.effect(
    "an invoke answer carries the hub's position, past every publish its handler made",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
        const host = yield* startHost(baseDir);
        const handlers = buildPluginRpcHandlers({
          pluginHost: host,
          observePluginRpc: passThroughObserve,
          observePluginRpcStream: passThroughObserveStream,
        });
        const first = yield* Stream.runHead(handlers[PLUGIN_METHODS.pluginState]({}));
        const at = first._tag === "Some" && first.value._tag === "snapshot" ? first.value : null;
        expect(at, "the snapshot names its position").not.toBeNull();

        const answer = yield* handlers[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "good",
          method: "publish",
          payload: { n: 1 },
        });
        expect(answer).toEqual({ value: null, boot: at?.boot, seq: (at?.seq ?? 0) + 1 });
        // An equal publish is not a change: the position does not move.
        const again = yield* handlers[PLUGIN_METHODS.pluginInvoke]({
          pluginId: "good",
          method: "publish",
          payload: { n: 1 },
        });
        expect(again).toEqual(answer);
      }),
  );

  it.effect("refuses the subscription without the read scope, as a PluginRpcError", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      // The scope wrapper ws.ts builds for the stream, reproduced the way `observeWithScopes`
      // reproduces the unary one: `authorizeStream` then the fold into the only declared error.
      const denied = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
        observePluginRpcStream: (method, stream) =>
          requiredScopeForRpcMethod(method) === AuthOrchestrationReadScope
            ? Stream.fail(
                new PluginRpcError({ reason: "unauthorized", detail: "missing read scope" }),
              )
            : stream,
      });
      const exit = yield* Effect.exit(Stream.runCollect(denied[PLUGIN_METHODS.pluginState]({})));
      expect(Exit.isFailure(exit)).toBe(true);
      // A tab without the scope must see a PLUGIN error it can switch on, not a transport shape.
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      expect((failure as { readonly reason?: string } | null)?.reason).toBe("unauthorized");
    }),
  );

  it.effect("round-trips the Rpc codec: the tagged frames", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = buildPluginRpcHandlers({
        pluginHost: host,
        observePluginRpc: passThroughObserve,
        observePluginRpcStream: passThroughObserveStream,
      });
      const client = yield* RpcTest.makeClient(PluginRpcTestGroup).pipe(
        Effect.provide(PluginRpcTestGroup.toLayer(handlers)),
      );
      yield* client[PLUGIN_METHODS.pluginInvoke]({
        pluginId: PluginId.make("good"),
        method: "publish",
        payload: { deep: [1, { two: null }] },
      });
      const first = yield* Stream.runHead(client[PLUGIN_METHODS.pluginState]({}));
      expect(first._tag === "Some" ? first.value : null).toEqual({
        _tag: "snapshot",
        values: [{ pluginId: "good", name: "rows", value: { deep: [1, { two: null }] } }],
        boot: expect.any(String),
        seq: 1,
      });
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
        observePluginRpcStream: passThroughObserveStream,
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
      expect(echoed).toEqual({
        value: { echoed: { a: 1, deep: { b: "two" } }, id: "good" },
        boot: expect.any(String),
        seq: 0,
      });

      // A no-argument call: the web port omits the key entirely when the plugin passed nothing,
      // and the plugin's handler must see `undefined`.
      const bare = yield* client[PLUGIN_METHODS.pluginInvoke]({
        pluginId: PluginId.make("good"),
        method: "echo",
      });
      expect(bare.value).toEqual({ id: "good" });
      expect(Object.hasOwn(bare.value as object, "echoed"), "the optional key is ABSENT").toBe(
        false,
      );

      // S37, and the reason this assertion is HERE rather than in a unit file: until S37 this case
      // read `{ echoed: undefined, id: "good" }` and passed, because `RpcTest.makeClient` drives
      // the handlers WITHOUT the JSON codec a real socket puts in front of them. On the wire
      // `Schema.Unknown` is lowered to `Schema.Json`, `encodeExit` refuses a key holding
      // `undefined`, and the caller is handed an untyped defect — the owner's «Нет соединения с
      // сервером» over a board whose scan had just succeeded. The host now refuses it first, with
      // a reason and the path.
      const raw = yield* Effect.result(
        client[PLUGIN_METHODS.pluginInvoke]({
          pluginId: PluginId.make("good"),
          method: "echo-raw",
        }),
      );
      expect(Result.isFailure(raw) ? raw.failure.reason : "<succeeded>").toBe("invalid-answer");
      expect(Result.isFailure(raw) ? (raw.failure.detail ?? "") : "").toContain(
        "answered with undefined at answer.echoed",
      );

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

// ru-code S38 (V2-43): the Settings ▸ Plugins pair, through the real handlers and the real host.
it.layer(NodeServices.layer)("plugin.settings / plugin.setEnabled (V2-43)", (it) => {
  const handlersFor = (host: PluginHost["Service"]) =>
    buildPluginRpcHandlers({
      pluginHost: host,
      observePluginRpc: passThroughObserve,
      observePluginRpcStream: passThroughObserveStream,
    });

  it.effect("lists every scanned plugin with its root, its state and both switches", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        good: echoPlugin("good"),
        junk: { "plugin.json": "{oops" },
      });
      const host = yield* startHost(baseDir);
      const rows = yield* handlersFor(host)[PLUGIN_METHODS.pluginSettings]({});
      expect(
        rows.map((row) => [row.id, row.root, row.state, row.enabledSaved, row.enabledRunning]),
      ).toEqual([
        ["good", "user", "loaded", true, true],
        ["junk", "user", "skipped", true, true],
      ]);
      // S38 step 11: the row names the FOLDER — for the one that did not decode too, which is
      // exactly the row a user opens when they want to know where to look.
      const path = yield* Path.Path;
      expect(rows.map((row) => row.dir)).toEqual([
        path.join(baseDir, "plugins", "good"),
        path.join(baseDir, "plugins", "junk"),
      ]);
    }),
  );

  it.effect("a switch is written, answered with fresh rows, and survives the next boot", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const rows = yield* handlersFor(host)[PLUGIN_METHODS.pluginSetEnabled]({
        pluginId: "good",
        enabled: false,
      });
      // SAVED is off, RUNNING is still on: nothing is torn down under the user, and the page has
      // exactly the two facts it needs to say "restart the app to apply".
      expect(rows.map((row) => [row.id, row.enabledSaved, row.enabledRunning])).toEqual([
        ["good", false, true],
      ]);

      // The next boot of this base dir acts on it.
      const rebooted = yield* startHost(baseDir);
      expect(yield* rebooted.list).toMatchObject([
        { id: "good", state: "skipped", error: "disabled by the operator" },
      ]);
      const after = yield* handlersFor(rebooted)[PLUGIN_METHODS.pluginSettings]({});
      expect(after.map((row) => [row.enabledSaved, row.enabledRunning])).toEqual([[false, false]]);
    }).pipe(Effect.scoped),
  );

  it.effect("rapid toggles are last-writer-wins, and the file is never half-written", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const handlers = handlersFor(host);
      for (const enabled of [false, true, false, true, false]) {
        yield* handlers[PLUGIN_METHODS.pluginSetEnabled]({ pluginId: "good", enabled });
      }
      const rows = yield* handlers[PLUGIN_METHODS.pluginSettings]({});
      expect(rows.map((row) => row.enabledSaved)).toEqual([false]);
      // ONE entry per id, in exactly one list — the property that makes the above true.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const raw = yield* fs.readFileString(
        path.join(stateDirOf(baseDir), "plugins", "disabled.json"),
      );
      expect(raw).toContain('"good"');
      expect(raw.match(/"good"/g)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  // ru-code S40 F1 (REVIEW): two switches in flight at once — the Plugins settings page disables
  // only the row it is waiting on, so a user who flips a second plugin before the first answer
  // comes back puts two `plugin.setEnabled` calls on the wire together. `writePluginSwitch` is an
  // unsynchronised read-modify-write over one whole file, so the second write is built on the
  // state the first read BEFORE it wrote — and the first user's switch is gone from the file that
  // decides the next boot. The user sees their switch flip back on by itself.
  it.effect("S40 F1: two switches flipped at once are BOTH recorded", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        alpha: echoPlugin("alpha"),
        beta: echoPlugin("beta"),
      });
      const host = yield* startHost(baseDir);
      const handlers = handlersFor(host);
      yield* Effect.all(
        [
          handlers[PLUGIN_METHODS.pluginSetEnabled]({ pluginId: "alpha", enabled: false }),
          handlers[PLUGIN_METHODS.pluginSetEnabled]({ pluginId: "beta", enabled: false }),
        ],
        { concurrency: "unbounded" },
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Read as TEXT and matched, exactly as the rapid-toggle case above does: the file is the
      // one the next boot reads, and both ids have to be in it.
      const raw = yield* fs.readFileString(
        path.join(stateDirOf(baseDir), "plugins", "disabled.json"),
      );
      expect([raw.includes('"alpha"'), raw.includes('"beta"')]).toEqual([true, true]);
      // And the page is told the truth: neither switch may read back as still on.
      const rows = yield* handlers[PLUGIN_METHODS.pluginSettings]({});
      expect(rows.map((row) => [row.id, row.enabledSaved])).toEqual([
        ["alpha", false],
        ["beta", false],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("an unknown id is a typed error and writes NOTHING", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
      const host = yield* startHost(baseDir);
      const detail = yield* detailOf(
        handlersFor(host)[PLUGIN_METHODS.pluginSetEnabled]({ pluginId: "ghost", enabled: false }),
      );
      expect(detail).toBe("ghost");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(stateDirOf(baseDir), "plugins", "disabled.json"))).toBe(
        false,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("disabling EVERY plugin is allowed — the app is the app, not its plugins", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: echoPlugin("good"), other: echoPlugin("other") });
      const host = yield* startHost(baseDir);
      const handlers = handlersFor(host);
      yield* handlers[PLUGIN_METHODS.pluginSetEnabled]({ pluginId: "good", enabled: false });
      const rows = yield* handlers[PLUGIN_METHODS.pluginSetEnabled]({
        pluginId: "other",
        enabled: false,
      });
      expect(rows.every((row) => !row.enabledSaved)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

// ru-code S38 step 10 (owner, 2026-09-19): the trace says WHICH plugin and WHICH call.
//
// `plugin.invoke` is ONE string for every call any plugin ever makes, so `[plugins] rpc start
// { method: "plugin.invoke" }` answered "a plugin called something" and nothing else. The support
// question these two lines exist for is "what did this plugin do, and how long did it take".
describe("the plugin rpc trace (S38 step 10)", () => {
  /** Every `[plugins] rpc …` line the wrapper wrote, as `(text, fields)`. */
  interface TraceLine {
    readonly text: string;
    readonly fields: Record<string, unknown>;
  }

  const captured = (): {
    readonly lines: TraceLine[];
    readonly layer: Layer.Layer<never>;
  } => {
    const lines: TraceLine[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      const parts = Array.isArray(message) ? message : [message];
      const text = String(parts[0] ?? "");
      if (!text.startsWith("[plugins] rpc ")) return;
      const fields = parts[1];
      lines.push({
        text,
        fields:
          typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : {},
      });
    });
    return {
      lines,
      // DEBUG, or the two lines never reach the logger: they are `logDebug`, and the default
      // minimum level is above it.
      layer: Layer.mergeAll(
        Logger.layer([logger], { mergeWithExisting: false }),
        Layer.succeed(References.MinimumLogLevel, "Debug"),
      ),
    };
  };

  const startOf = (lines: ReadonlyArray<TraceLine>) =>
    lines.find((line) => line.text === "[plugins] rpc start")?.fields ?? {};
  const endOf = (lines: ReadonlyArray<TraceLine>) =>
    lines.find((line) => line.text === "[plugins] rpc end")?.fields ?? {};

  it.layer(NodeServices.layer)("an invoke", (it) => {
    it.effect(
      "names the plugin and the call on BOTH lines, with an outcome and an elapsed ms",
      () => {
        const capture = captured();
        return Effect.gen(function* () {
          const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
          const host = yield* startHost(baseDir);
          const handlers = buildPluginRpcHandlers({
            pluginHost: host,
            observePluginRpc: (trace, effect) => tracePluginRpc(trace, effect),
            observePluginRpcStream: passThroughObserveStream,
          });

          yield* handlers[PLUGIN_METHODS.pluginInvoke]({
            pluginId: "good",
            method: "echo",
            payload: { a: 1 },
          }).pipe(Effect.provide(capture.layer));

          expect(startOf(capture.lines)).toMatchObject({ plugin: "good", call: "echo" });
          // The method is NOT repeated once the plugin is named: it would be the literal
          // `plugin.invoke` on every one of these lines.
          expect(startOf(capture.lines)["method"]).toBeUndefined();
          const end = endOf(capture.lines);
          expect(end).toMatchObject({ plugin: "good", call: "echo", outcome: "success" });
          expect(Number.isFinite(end["ms"]), `ms is a number — got ${String(end["ms"])}`).toBe(
            true,
          );
          expect(end["ms"] as number).toBeGreaterThanOrEqual(0);
          // A success carries no reason — and the EXACT field set is the proof that nothing else
          // rode along: not the payload, not a detail, not the plugin's answer.
          expect(Object.keys(end).toSorted()).toEqual(["call", "ms", "outcome", "plugin"]);
        }).pipe(Effect.scoped);
      },
    );

    it.effect("a typed failure adds its REASON — the word only, never the detail", () => {
      const capture = captured();
      return Effect.gen(function* () {
        const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
        const host = yield* startHost(baseDir);
        const handlers = buildPluginRpcHandlers({
          pluginHost: host,
          observePluginRpc: (trace, effect) => tracePluginRpc(trace, effect),
          observePluginRpcStream: passThroughObserveStream,
        });

        yield* Effect.result(
          handlers[PLUGIN_METHODS.pluginInvoke]({
            pluginId: "good",
            method: "nope",
            payload: {},
          }).pipe(Effect.provide(capture.layer)),
        );

        const end = endOf(capture.lines);
        expect(end).toMatchObject({ plugin: "good", call: "nope", outcome: "failure" });
        expect(end["reason"]).toBe("unknown-method");
        // `detail` is `good.nope` here; the trace must not carry it.
        expect(end["detail"]).toBeUndefined();
      }).pipe(Effect.scoped);
    });

    it.effect(
      "a host-level RPC names the METHOD and no plugin — there is no one plugin to name",
      () => {
        const capture = captured();
        return Effect.gen(function* () {
          const baseDir = yield* makeBaseDir({ good: echoPlugin("good") });
          const host = yield* startHost(baseDir);
          const handlers = buildPluginRpcHandlers({
            pluginHost: host,
            observePluginRpc: (trace, effect) => tracePluginRpc(trace, effect),
            observePluginRpcStream: passThroughObserveStream,
          });

          yield* handlers[PLUGIN_METHODS.pluginList]({}).pipe(Effect.provide(capture.layer));

          expect(startOf(capture.lines)).toEqual({ method: "plugin.list" });
          const end = endOf(capture.lines);
          expect(end["method"]).toBe("plugin.list");
          expect(end["plugin"]).toBeUndefined();
          expect(end["call"]).toBeUndefined();
          expect(end["outcome"]).toBe("success");
          expect(Number.isFinite(end["ms"])).toBe(true);
        }).pipe(Effect.scoped);
      },
    );
  });
});
