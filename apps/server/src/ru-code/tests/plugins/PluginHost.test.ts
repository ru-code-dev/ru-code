// ru-code: the plugin host's contract — isolation, RPC, storage and migrations.
//
// The through-line of every case is guardrail 8: whatever a plugin does, the
// blast radius is that plugin. A throwing `activate`, a rejecting handler, a
// broken migration and a nonsense default export are all recorded as a status
// and the plugin NEXT to it still loads and still answers `invoke`.
//
// Fixtures are real folders with real `.mjs` entries, imported through the real
// `loadPluginModule` — the same computed-specifier `import()` that ships in
// `dist/bin.mjs`. `<baseDir>/plugins/<id>` is used directly (no
// `RU_CODE_PLUGINS_DIR`) so the layout under test is the production one.
//
// node:sqlite is read directly at the end of the migration cases: asserting
// through the same client that wrote the rows would not prove the file on disk
// is the one the plugin was given.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Result from "effect/Result";

import * as ServerConfig from "../../../config.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import type { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";

import {
  normalizeServerPlugin,
  PluginHost,
  PluginHostLayer,
  sanitizeStatusError,
  statusErrorFromCause,
  toPluginProject,
} from "../../plugins/PluginHost.ts";
import { PLUGIN_DB_FILENAME, SHIPPED_PLUGINS_DIR_ENV_VAR } from "../../plugins/paths.ts";
import { PLUGIN_MIGRATIONS_TABLE } from "../../plugins/storage.ts";

type Files = Readonly<Record<string, string>>;

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

/** `disabled.json`, as the operator would hand-write it. */
const disabledListJson = (ids: ReadonlyArray<string>) => JSON.stringify({ disabled: ids });

/** V2-43: the same file with BOTH switches, as the Settings section writes it. */
const switchesJson = (switches: {
  readonly disabled?: ReadonlyArray<string>;
  readonly enabled?: ReadonlyArray<string>;
}) =>
  JSON.stringify({
    disabled: switches.disabled ?? [],
    ...(switches.enabled === undefined ? {} : { enabled: switches.enabled }),
  });

/** A fresh `<baseDir>` with `plugins/<id>/…` written under it. */
const makeBaseDir = (plugins: Readonly<Record<string, Files>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-host-" }),
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

/** Build a PluginHost over `baseDir` and run its scan. */
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

/**
 * A payload-shaped SHIPPED root: `<tmp>/plugins/<id>/…`, the same shape
 * `versions/<v>/plugins/<id>` has in a real install.
 *
 * Separate from {@link makeBaseDir} on purpose — the two roots are different directories with
 * different lifetimes, and a fixture that shared one would prove nothing about precedence.
 */
const makeShippedDir = (plugins: Readonly<Record<string, Files>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-shipped-" }),
    );
    const shipped = path.join(root, "plugins");
    for (const [id, files] of Object.entries(plugins)) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(shipped, id, rel);
        yield* Effect.orDie(fs.makeDirectory(path.dirname(abs), { recursive: true }));
        yield* Effect.orDie(fs.writeFileString(abs, content));
      }
    }
    yield* Effect.orDie(fs.makeDirectory(shipped, { recursive: true }));
    return shipped;
  });

/**
 * The same host, but with the SHIPPED root pointed at `shippedDir`.
 *
 * The env var is read inside `Layer.build`, so it is set for exactly that window and restored
 * immediately — the file-level pin above is what every other case in this file sees.
 */
const startHostWithShipped = (baseDir: string, shippedDir: string) =>
  Effect.gen(function* () {
    const context = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
        process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = shippedDir;
        return previous;
      }),
      () =>
        Layer.build(
          PluginHostLayer.pipe(
            Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
            Layer.provide(NodeSqliteClient.layerMemory()),
          ),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
          else process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = previous;
        }),
    );
    const host = Context.get(context, PluginHost);
    yield* host.start;
    return host;
  });

/**
 * ru-code (A16): the same, over a config the test may amend first.
 *
 * `layerTest` hard-codes `cliDetected: true` (tests do not spawn the real CLI), so the ONE branch
 * `host.paths.cliConfigDir` exists for — "there is no CLI here" — is unreachable without this.
 */
const startHostWithConfig = (
  baseDir: string,
  patch: (config: ServerConfig.ServerConfig["Service"]) => ServerConfig.ServerConfig["Service"],
) =>
  Effect.gen(function* () {
    const base = yield* Effect.provide(
      ServerConfig.ServerConfig,
      ServerConfig.layerTest(baseDir, baseDir),
    );
    const context = yield* Layer.build(
      PluginHostLayer.pipe(
        Layer.provide(ServerConfig.layer(patch(base))),
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

const stateDirOf = (baseDir: string) => `${baseDir}/userdata`;

const readMigrationIds = (dbPath: string): ReadonlyArray<string> => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(`SELECT id FROM ${PLUGIN_MIGRATIONS_TABLE} ORDER BY id`)
      .all()
      .map((row) => String((row as { id: unknown }).id));
  } finally {
    db.close();
  }
};

/** Which databases the plugin's own connection knows — `["main"]` unless something ATTACHed. */
const databaseList = (dbPath: string): ReadonlyArray<string> => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("PRAGMA database_list")
      .all()
      .map((row) => String((row as { name: unknown }).name));
  } finally {
    db.close();
  }
};

const tableNames = (dbPath: string): ReadonlyArray<string> => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master ORDER BY name")
      .all()
      .map((row) => String((row as { name: unknown }).name));
  } finally {
    db.close();
  }
};

/** Reports back what the host put on its `ServerCtx` — the v2 seam, not a registration call. */
const pathsPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  rpc: {
    "paths": async (_payload, ctx) => ctx.paths,
    "cli-config-dir": async (_payload, ctx) => ctx.paths.cliConfigDir,
    "data-dir": async (_payload, ctx) => ctx.paths.dataDir,
    "projects": async (_payload, ctx) => ctx.projects.list(),
    "plugin-id": async (_payload, ctx) => ctx.pluginId,
  },
};
`,
});

/** Handlers that answer with every value class the wire has an opinion about (S37). */
const answersPlugin = {
  "plugin.json": manifestJson("answers", { server: "server/index.mjs" }),
  "server/index.mjs": `
const deep = (levels) => {
  let node = { depth: levels };
  for (let i = 0; i < levels; i += 1) node = { next: node };
  return node;
};
export default {
  rpc: {
    "nan": async () => ({ sessions: [{ id: "a", avgTokens: 1 }, { id: "b", avgTokens: Number.NaN }] }),
    "undefined-key": async () => ({ agentUsage: { Explore: { apiCalls: 1, lastError: undefined } } }),
    "date": async () => ({ at: new Date(0) }),
    "map": async () => ({ byId: new Map() }),
    "rows": async () => ({ rows: [1, 2, 3] }),
    "empty-object": async () => ({}),
    "empty-string": async () => "",
    "zero": async () => 0,
    "null": async () => null,
    "nothing": async () => {},
    "deep": async () => deep(2000),
    "big": async () => ({ rows: Array.from({ length: 20000 }, (_, i) => ({ i, name: "row-" + i })) }),
    "boom-json-data": async () => {
      throw Object.assign(new Error("over quota"), { data: { kind: "quota-exceeded", limit: 3 } });
    },
    "boom-nan-data": async () => {
      throw Object.assign(new Error("over quota"), { data: { count: Number.NaN } });
    },
  },
};
`,
};

const okPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  activate(ctx) {
    ctx.log.info("activated");
  },
  rpc: {
    "echo": async (payload, ctx) => ({ echoed: payload, id: ctx.pluginId }),
    "boom": async () => {
      throw new Error("handler exploded");
    },
    // v2 (V2-7): a handler may attach STRUCTURED data to its failure.
    "boom-structured": async () => {
      throw Object.assign(new Error("quota"), { data: { kind: "quota-exceeded", limit: 3 } });
    },
  },
};
`,
});

describe("normalizeServerPlugin", () => {
  it("keeps every seam the default export declares", () => {
    const activate = () => {};
    const deactivate = () => {};
    const rpc = { ping: async () => "pong" };
    const session = { fingerprint: async () => "fp" };
    const plugin = normalizeServerPlugin({
      activate,
      deactivate,
      rpc,
      session,
      migrations: [{ id: "a", sql: "SELECT 1" }],
    });
    expect(plugin?.activate).toBe(activate);
    expect(plugin?.deactivate).toBe(deactivate);
    expect(plugin?.rpc).toBe(rpc);
    expect(plugin?.session).toBe(session);
    expect(plugin?.migrations).toHaveLength(1);
  });

  it("accepts a bare function as `activate` — the smallest possible plugin", () => {
    const activate = () => {};
    expect(normalizeServerPlugin(activate)?.activate).toBe(activate);
  });

  it("accepts a plugin with NO lifecycle at all: v2 has no required member", () => {
    // v1 refused this — `activate` was mandatory — so a plugin that only answers RPCs had to
    // ship an empty `activate() {}`. Under the seam model that is exactly backwards.
    const plugin = normalizeServerPlugin({ rpc: { ping: async () => "pong" } });
    expect(plugin?.rpc).toBeDefined();
    expect(plugin?.activate).toBeUndefined();
  });

  it("drops a seam of the wrong shape instead of taking the plugin down", () => {
    const plugin = normalizeServerPlugin({ rpc: "yes", session: 3, migrations: "later" });
    expect(plugin).not.toBeNull();
    expect(plugin?.rpc).toBeUndefined();
    expect(plugin?.session).toBeUndefined();
    expect(plugin?.migrations).toBeUndefined();
  });

  it("rejects a default export that is neither an object nor a function", () => {
    for (const value of [undefined, null, 42, "activate"]) {
      expect(normalizeServerPlugin(value)).toBeNull();
    }
  });
});

describe("statusErrorFromCause (A7 finding L4)", () => {
  // `PluginStatus.error` is served by `GET /plugins/manifests.json` — unauthenticated, with
  // `access-control-allow-origin: *`. Anyone who can reach the port reads this string, so it
  // must be the failure's MESSAGE and nothing else: no stack frames, no host paths.
  const withStack = (): Error => {
    const error = new Error("activate exploded");
    error.stack = [
      "Error: activate exploded",
      "    at activate (/mnt/mac/Users/Zach/plugins/demo/server/index.mjs:3:11)",
      "    at PluginHost (/mnt/mac/Users/Zach/apps/server/src/ru-code/plugins/PluginHost.ts:340:9)",
    ].join("\n");
    return error;
  };

  it("keeps the message and drops the stack trace and the absolute paths", () => {
    const sanitized = statusErrorFromCause(Cause.die(withStack()));
    expect(sanitized).toBe("activate exploded");
    expect(sanitized).not.toContain("/mnt/");
    expect(sanitized).not.toContain("at ");
  });

  it("takes the FIRST line of a defect that is not an Error, and never empties out", () => {
    expect(statusErrorFromCause(Cause.die("boom\n    at x (/mnt/mac/secret.mjs:1:1)"))).toBe(
      "boom",
    );
    expect(statusErrorFromCause(Cause.die(""))).toBe("plugin activation failed");
  });
});

it.layer(NodeServices.layer)("PluginHost", (it) => {
  it.effect("a plugin whose activate throws is failed and its sibling still loads", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bad: {
          "plugin.json": manifestJson("bad", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { activate() { throw new Error("activate exploded"); } };`,
        },
        good: okPlugin("good"),
      });
      const host = yield* startHost(baseDir);
      const statuses = yield* host.list;

      expect(statuses.map((status) => [status.id, status.state])).toEqual([
        ["bad", "failed"],
        ["good", "loaded"],
      ]);
      expect(statuses[0]?.error).toContain("activate exploded");
      // A7 finding L4: whatever put this string there, it reaches an unauthenticated
      // endpoint — no stack frames, no path of this machine's.
      expect(statuses[0]?.error).not.toContain(baseDir);
      expect(statuses[0]?.error).not.toMatch(/\n\s*at /);
      expect(yield* host.invoke("good", "echo", { n: 1 })).toEqual({
        echoed: { n: 1 },
        id: "good",
      });
    }),
  );

  it.effect("a server entry that throws on import fails without touching its neighbour", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        broken: {
          "plugin.json": manifestJson("broken", { server: "server/index.mjs" }),
          "server/index.mjs": `throw new Error("import exploded");`,
        },
        good: okPlugin("good"),
      });
      const host = yield* startHost(baseDir);
      const statuses = yield* host.list;
      expect(statuses[0]?.state).toBe("failed");
      expect(statuses[0]?.error).toContain("import exploded");
      expect(statuses[0]?.error).not.toContain(baseDir);
      expect(statuses[0]?.error).not.toMatch(/\n\s*at /);
      expect(statuses[1]?.state).toBe("loaded");
    }),
  );

  it.effect("a default export that is not an object or a function is failed", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        shapeless: {
          "plugin.json": manifestJson("shapeless", { server: "server/index.mjs" }),
          "server/index.mjs": `export default 42;`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("failed");
      expect((yield* host.list)[0]?.error).toContain("not a plugin");
    }),
  );

  it.effect("an object with no seam at all LOADS — v2 has no required member", () =>
    Effect.gen(function* () {
      // v1 failed this with "not a plugin definition" because `activate` was mandatory. Under the
      // seam model an export with no seams contributes nothing, which is not the same as broken.
      const baseDir = yield* makeBaseDir({
        seamless: {
          "plugin.json": manifestJson("seamless", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { nope: true };`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("loaded");
    }),
  );

  it.effect("a bare function default export is accepted as activate", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bare: {
          "plugin.json": manifestJson("bare", { server: "server/index.mjs" }),
          "server/index.mjs": `export default (ctx) => { ctx.log.info("bare " + ctx.pluginId); };`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("loaded");
    }),
  );

  it.effect(
    "a plugin with rpc and NO activate loads and answers (v2: every seam is optional)",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir({
          rpconly: {
            "plugin.json": manifestJson("rpconly", { server: "server/index.mjs" }),
            "server/index.mjs": `export default { rpc: { ping: async () => "pong" } };`,
          },
        });
        const host = yield* startHost(baseDir);
        expect((yield* host.list)[0]?.state).toBe("loaded");
        expect(yield* host.invoke("rpconly", "ping", undefined)).toBe("pong");
      }),
  );

  it.effect("a web-only plugin is loaded with hasServer false", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        webonly: {
          "plugin.json": manifestJson("webonly", { web: "web/index.mjs", styles: "web/s.css" }),
          "web/index.mjs": `export default {};`,
          "web/s.css": `:root { --x: 1; }`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]).toMatchObject({
        id: "webonly",
        state: "loaded",
        hasWeb: true,
        hasServer: false,
        // ru-code (A5, A4 finding M3): the entry PATH, not just `hasWeb` — the
        // web loader used to hard-code `web/index.mjs` and 404 on anything else.
        web: "web/index.mjs",
        styles: "web/s.css",
      });
    }),
  );

  // ru-code (A9 finding LOW-3): the status is what the BROWSER can fetch. A plugin
  // whose server half failed keeps its `web`/`styles` in the manifest, but
  // `resolvePluginDir` refuses it, so both entry points 404 — advertising them was
  // a promise the asset route does not keep.
  it.effect("a failed plugin advertises no web half, even though its manifest has one", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bad: {
          "plugin.json": manifestJson("bad", {
            server: "server/index.mjs",
            web: "web/index.mjs",
            styles: "web/s.css",
          }),
          "server/index.mjs": `export default { activate() { throw new Error("nope"); } };`,
          "web/index.mjs": `export default {};`,
          "web/s.css": `:root { --x: 1; }`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.manifestsForWeb)[0];
      expect(status).toMatchObject({ id: "bad", state: "failed", hasWeb: false });
      expect(status?.web).toBeUndefined();
      expect(status?.styles).toBeUndefined();
      // …and the route the web loader would have hit is indeed closed.
      expect(yield* host.resolvePluginDir("bad")).toBeUndefined();
    }),
  );

  it.effect("a malformed folder is reported as skipped, never dropped", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ junk: { "plugin.json": "{oops" } });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]).toMatchObject({ id: "junk", state: "skipped" });
    }),
  );

  it.effect("invoke reports unknown plugin, unknown method, disabled plugin, failing handler", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bad: {
          "plugin.json": manifestJson("bad", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { activate() { throw new Error("nope"); } };`,
        },
        good: okPlugin("good"),
      });
      const host = yield* startHost(baseDir);

      const reasonOf = (effect: Effect.Effect<unknown, { readonly reason: string }>) =>
        Effect.result(effect).pipe(
          Effect.map((result) =>
            Result.isFailure(result) ? result.failure.reason : "<succeeded>",
          ),
        );

      expect(yield* reasonOf(host.invoke("missing", "echo", null))).toBe("unknown-plugin");
      expect(yield* reasonOf(host.invoke("good", "nope", null))).toBe("unknown-method");
      expect(yield* reasonOf(host.invoke("bad", "echo", null))).toBe("plugin-disabled");
      expect(yield* reasonOf(host.invoke("good", "boom", null))).toBe("plugin-failed");

      const failure = yield* Effect.result(host.invoke("good", "boom", null));
      expect(Result.isFailure(failure) ? failure.failure.detail : "").toContain("handler exploded");
    }),
  );

  // ru-code S40 gap 1 (REVIEW): a WEB-ONLY plugin whose web half calls `ctx.invoke`.
  //
  // A manifest with no `server` is `loaded` with `hasServer: false`, and nothing in the SDK stops
  // its web half from calling `ctx.invoke` — a plugin that grows a server half later, or an author
  // who copied the demo's panel without its server entry, does exactly that. The status table has
  // a `loaded` row for the id while `loaded` (the activated plugins) has none, so the `invoke`
  // guard has to answer off the SECOND table: `unknown-method`, typed, with the host intact and
  // its neighbour still answering.
  it.effect("a web-only plugin's invoke is unknown-method, not a crash", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        paint: {
          "plugin.json": manifestJson("paint", { web: "web/index.mjs" }),
          "web/index.mjs": "export default {};",
        },
        good: okPlugin("good"),
      });
      const host = yield* startHost(baseDir);
      const statuses = yield* host.list;
      expect(statuses.map((status) => [status.id, status.state, status.hasServer])).toEqual([
        ["good", "loaded", true],
        ["paint", "loaded", false],
      ]);
      const failure = yield* Effect.result(host.invoke("paint", "anything", null));
      expect(Result.isFailure(failure) ? failure.failure.reason : "<succeeded>").toBe(
        "unknown-method",
      );
      expect(Result.isFailure(failure) ? failure.failure.detail : "").toBe("paint.anything");
      // The neighbour is untouched.
      expect(yield* host.invoke("good", "echo", 1)).toEqual({ echoed: 1, id: "good" });
    }),
  );

  // ru-code S37 (rule 37, "boundaries validate"). The wire carries JSON and only JSON: the answer's
  // `value` in `plugin.invoke` is `Schema.Unknown` (S104), which effect lowers to `Schema.Json`, and the
  // RPC server encodes the exit against it BEFORE the frame is written. A value that is not a
  // JSON value therefore dies inside the protocol as an untyped `Die` defect — the plugin's web
  // half gets a rejection with no `reason`, and the page blames the socket for a call the server
  // answered. So the host checks first, for EVERY plugin, and answers with its own typed error
  // naming the exact path. effect's own message cannot: its predicate is one whole-tree walk, so
  // it always says `["value"]`.
  it.effect("an answer the wire cannot carry is a TYPED error naming the path, not a defect", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ answers: answersPlugin });
      const host = yield* startHost(baseDir);

      const failed = (method: string) =>
        Effect.result(host.invoke("answers", method, null)).pipe(
          Effect.map((result) =>
            Result.isFailure(result)
              ? `${result.failure.reason}|${result.failure.detail ?? ""}`
              : "<succeeded>",
          ),
        );

      // A NaN buried in the third row — the S37 shape, on the owner's own data.
      expect(yield* failed("nan")).toBe(
        "invalid-answer|answers.nan answered with NaN at answer.sessions[1].avgTokens",
      );
      // The producer that actually shipped: an `optional` field spelled as a present key.
      expect(yield* failed("undefined-key")).toBe(
        "invalid-answer|answers.undefined-key answered with undefined at answer.agentUsage.Explore.lastError",
      );
      // …and the two the package's own encode was believed to catch.
      expect(yield* failed("date")).toBe(
        "invalid-answer|answers.date answered with a Date at answer.at",
      );
      expect(yield* failed("map")).toBe(
        "invalid-answer|answers.map answered with a Map at answer.byId",
      );
    }),
  );

  it.effect("a valid answer is untouched, whatever its shape", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ answers: answersPlugin });
      const host = yield* startHost(baseDir);

      // Rule 35: the empty value, the absent value, the deep value, the big value.
      expect(yield* host.invoke("answers", "rows", null)).toEqual({ rows: [1, 2, 3] });
      expect(yield* host.invoke("answers", "empty-object", null)).toEqual({});
      expect(yield* host.invoke("answers", "empty-string", null)).toBe("");
      expect(yield* host.invoke("answers", "zero", null)).toBe(0);
      expect(yield* host.invoke("answers", "null", null)).toBeNull();
      // A handler that returns nothing still answers `null` (the `?? null` above this check).
      expect(yield* host.invoke("answers", "nothing", null)).toBeNull();
      // Depth is the host's problem, not vitest's: walk it rather than deep-comparing it
      // (`toMatchObject` recurses, and the point here is that the HOST's check did not).
      let node = yield* host.invoke("answers", "deep", null);
      let levels = 0;
      while (typeof node === "object" && node !== null && "next" in node) {
        node = (node as { readonly next: unknown }).next;
        levels += 1;
      }
      expect(levels).toBe(2_000);
      expect(node).toEqual({ depth: 2_000 });
      const big = yield* host.invoke("answers", "big", null);
      expect((big as { readonly rows: ReadonlyArray<unknown> }).rows).toHaveLength(20_000);
    }),
  );

  it.effect("the invalid answer is logged at DEBUG with the plugin, the method and the path", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ answers: answersPlugin });
      const host = yield* startHost(baseDir);
      const captured: Array<string> = [];
      const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
        captured.push(`${String(logLevel)} ${JSON.stringify(message)}`);
      });

      yield* Effect.result(host.invoke("answers", "nan", null)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Logger.layer([capture], { mergeWithExisting: false }),
            Layer.succeed(References.MinimumLogLevel, "Debug"),
          ),
        ),
      );

      const line = captured.find((entry) => entry.includes("invoke answer is not JSON"));
      expect(line, captured.join("\n")).toBeDefined();
      // DEBUG, not error: a plugin bug is not the operator's incident, and the plugin is told.
      expect(line).toContain("Debug");
      expect(line).toContain("answer.sessions[1].avgTokens");
      expect(line).toContain("answers");
      expect(line).toContain("nan");
      expect(line).toContain("NaN");
    }),
  );

  // v2 (V2-7) + S37: the structured `data` a handler attaches rides the same `Schema.Unknown`
  // field, so it is held to the same rule — and it costs the FIELD, never the error.
  it.effect("a thrown error's structured data is taken only when it is JSON", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ answers: answersPlugin });
      const host = yield* startHost(baseDir);

      const dataOf = (method: string) =>
        Effect.result(host.invoke("answers", method, null)).pipe(
          Effect.map((result) => (Result.isFailure(result) ? result.failure.data : "<succeeded>")),
        );

      expect(yield* dataOf("boom-json-data")).toEqual({ kind: "quota-exceeded", limit: 3 });
      // It used to arrive as `{ count: null }` — `JSON.parse(JSON.stringify(...))` is not the
      // wire's rule, and a payload the plugin's two halves disagree about looked fine.
      expect(yield* dataOf("boom-nan-data")).toBeUndefined();
      // …and the plugin still gets its reason and its sentence.
      const failure = yield* Effect.result(host.invoke("answers", "boom-nan-data", null));
      expect(Result.isFailure(failure) ? failure.failure.reason : "").toBe("plugin-failed");
      expect(Result.isFailure(failure) ? failure.failure.detail : "").toContain("over quota");
    }),
  );

  it.effect("start is idempotent", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ good: okPlugin("good") });
      const host = yield* startHost(baseDir);
      yield* host.start;
      expect(yield* host.list).toHaveLength(1);
    }),
  );

  it.effect("resolvePluginDir answers for loaded plugins only", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        // ru-code (A5, A4 finding L1): `bad` decodes fine — its directory IS in
        // the table — but its server half failed, so the asset route must not
        // keep serving its `web/**`. One state, one answer.
        bad: {
          "plugin.json": manifestJson("bad", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { activate() { throw new Error("nope"); } };`,
        },
        good: okPlugin("good"),
        junk: { "plugin.json": "{oops" },
      });
      const host = yield* startHost(baseDir);
      expect(yield* host.resolvePluginDir("good")).toBe(`${baseDir}/plugins/good`);
      expect(yield* host.resolvePluginDir("bad")).toBeUndefined();
      expect(yield* host.resolvePluginDir("junk")).toBeUndefined();
      expect(yield* host.resolvePluginDir("nope")).toBeUndefined();
    }),
  );
});

// ru-code (A5, A4 finding H1). A `catch` only helps a step that FINISHES.
// A4 reproduced the other half against the real built server: a plugin whose
// `activate()` never settles blocked boot completely — no runtime sentinel,
// `/healthz` never answered, `ru-code start` gave up with «Демон не запустился
// вовремя», an orphan node process kept the port, and the only recovery was
// deleting the folder from a shell. This is guardrail 8 for the hang case:
// that plugin is `failed`, the scan continues, the plugin next to it works.
//
// `it.live` and a 15 s wait, deliberately. `it.effect` runs on a TestClock,
// and driving that clock forward here is not merely awkward but WRONG: the
// scan's real dynamic `import()` and filesystem calls are not clock-driven, so
// any driver that advances virtual time on a real macrotask also burns the
// budget of the healthy plugin next door — measured, and it turned `good` into
// a second false timeout. The mechanism under test is a real wall-clock
// deadline, so the test pays real wall-clock seconds for it. The import and
// migration steps go through the SAME `timedStep` helper; one live case buys
// the proof for all three without paying 15 s three times.
it.live(
  "a plugin whose activate never settles times out and its sibling still loads",
  () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        // Directory order, so `good` is scanned FIRST: the assertion is not
        // only "hang failed" but "the scan was already past a healthy plugin
        // and went on to the next one after the timeout".
        good: okPlugin("good"),
        hang: {
          "plugin.json": manifestJson("hang", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { activate() { return new Promise(() => {}); } };`,
        },
        later: okPlugin("later"),
      });
      const host = yield* startHost(baseDir);

      const statuses = yield* host.list;
      expect(statuses.map((status) => [status.id, status.state])).toEqual([
        ["good", "loaded"],
        ["hang", "failed"],
        ["later", "loaded"],
      ]);
      expect(statuses[1]?.error).toBe("activate timed out after 15s");
      expect(yield* host.invoke("later", "echo", { n: 1 })).toEqual({
        echoed: { n: 1 },
        id: "later",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

// ── migrations (D10) ─────────────────────────────────────────────────────────

const migratingPlugin = (migrations: ReadonlyArray<{ id: string; sql: string }>) => ({
  "plugin.json": manifestJson("notes", { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  migrations: ${JSON.stringify(migrations)},
  rpc: {
    "add": async (body, ctx) => {
      await ctx.storage.exec("INSERT INTO notes (body) VALUES (?)", [body]);
      const rows = await ctx.storage.query("SELECT body FROM notes ORDER BY id");
      return rows.map((row) => row.body);
    },
    "bad-sql": async (_payload, ctx) => ctx.storage.query("SELECT * FROM nowhere"),
  },
};
`,
});

const MIGRATION_ONE = {
  id: "001-notes",
  sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
};
const MIGRATION_TWO = { id: "002-index", sql: "CREATE INDEX notes_body ON notes (body)" };

it.layer(NodeServices.layer)("PluginHost storage + migrations", (it) => {
  it.effect("migrations run once, in order, into the plugin's own file", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: migratingPlugin([MIGRATION_ONE, MIGRATION_TWO]),
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("loaded");

      const dbPath = `${stateDirOf(baseDir)}/plugins/notes/data.sqlite`;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false))).toBe(true);
      expect(readMigrationIds(dbPath)).toEqual(["001-notes", "002-index"]);

      // The app database is not on the plugin's write path (D2).
      expect(
        yield* fs
          .exists(`${stateDirOf(baseDir)}/state.sqlite`)
          .pipe(Effect.orElseSucceed(() => false)),
      ).toBe(false);

      // The storage handle really is bound to that file.
      expect(yield* host.invoke("notes", "add", "hello")).toEqual(["hello"]);
    }),
  );

  it.effect("a second start over the same data dir applies nothing new", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: migratingPlugin([MIGRATION_ONE, MIGRATION_TWO]),
      });
      const first = yield* startHost(baseDir);
      yield* first.invoke("notes", "add", "kept");

      const second = yield* startHost(baseDir);
      expect((yield* second.list)[0]?.state).toBe("loaded");

      const dbPath = `${stateDirOf(baseDir)}/plugins/notes/data.sqlite`;
      expect(readMigrationIds(dbPath)).toEqual(["001-notes", "002-index"]);
      // Re-running 001 would have failed ("table notes already exists"); the row
      // survived, which is the observable proof nothing re-ran.
      expect(yield* second.invoke("notes", "add", "added")).toEqual(["kept", "added"]);
    }),
  );

  it.effect("only a newly declared migration id runs on the next start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: migratingPlugin([MIGRATION_ONE]) });
      yield* startHost(baseDir);

      const dbPath = `${stateDirOf(baseDir)}/plugins/notes/data.sqlite`;
      expect(readMigrationIds(dbPath)).toEqual(["001-notes"]);

      // A new plugin version lands in the folder with one extra migration. The
      // entry file must change name too: Node caches an imported module by URL.
      const entry = "server/index-v2.mjs";
      const v2 = migratingPlugin([
        MIGRATION_ONE,
        MIGRATION_TWO,
        {
          id: "003-tag",
          sql: "ALTER TABLE notes ADD COLUMN tag TEXT",
        },
      ]);
      yield* Effect.orDie(
        fs.writeFileString(path.join(baseDir, "plugins/notes", entry), v2["server/index.mjs"]),
      );
      yield* Effect.orDie(
        fs.writeFileString(
          path.join(baseDir, "plugins/notes/plugin.json"),
          manifestJson("notes", { server: entry }),
        ),
      );

      const next = yield* startHost(baseDir);
      expect((yield* next.list)[0]?.state).toBe("loaded");
      expect(readMigrationIds(dbPath)).toEqual(["001-notes", "002-index", "003-tag"]);
    }),
  );

  it.effect("a failing migration disables that plugin and leaves nothing half-applied", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: migratingPlugin([
          MIGRATION_ONE,
          { id: "002-broken", sql: "CREATE TABLE ((( syntax error" },
          { id: "003-never", sql: "CREATE TABLE never_ran (id INTEGER)" },
        ]),
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];
      expect(status?.state).toBe("failed");
      expect(status?.error).toContain("002-broken");

      const dbPath = `${stateDirOf(baseDir)}/plugins/notes/data.sqlite`;
      expect(readMigrationIds(dbPath)).toEqual(["001-notes"]);
      expect(tableNames(dbPath)).not.toContain("never_ran");

      // Disabled means unreachable, not "half working".
      const result = yield* Effect.result(host.invoke("notes", "add", "x"));
      expect(Result.isFailure(result) ? result.failure.reason : "").toBe("plugin-disabled");
    }),
  );

  it.effect("a multi-statement migration applies every statement", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: migratingPlugin([
          {
            id: "001-multi",
            sql: `
              -- two objects in one migration body
              CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
              CREATE INDEX notes_body ON notes (body);
            `,
          },
        ]),
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("loaded");
      const names = tableNames(`${stateDirOf(baseDir)}/plugins/notes/data.sqlite`);
      expect(names).toContain("notes");
      expect(names).toContain("notes_body");
    }),
  );

  it.effect("a failing storage call rejects into the plugin, it does not disable the host", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ notes: migratingPlugin([MIGRATION_ONE]) });
      const host = yield* startHost(baseDir);
      const result = yield* Effect.result(host.invoke("notes", "bad-sql", null));
      expect(Result.isFailure(result) ? result.failure.reason : "").toBe("plugin-failed");
      // Still loaded, still answering.
      expect(yield* host.invoke("notes", "add", "fine")).toEqual(["fine"]);
    }),
  );
});

// ── A13 / A12 round 1 ────────────────────────────────────────────────────────

describe("sanitizeStatusError (A12 finding R1-M2)", () => {
  // `PluginStatus.error` is served by `GET /plugins/manifests.json` — unauthenticated, with
  // `access-control-allow-origin: *`. A7's L4 fix set the rule for the `Cause` branch only; the
  // ORDINARY branches passed Node's own message through, and Node's module errors are made of
  // absolute paths. In production the leaked string is `/home/<username>/.ru-code/plugins/…`:
  // the OS username plus the install layout, readable by any origin the browser visits.
  const PLUGINS_ROOT = "/home/zach/.ru-code/plugins";

  it("keeps the plugin-relative tail of a path inside the plugins dir", () => {
    expect(
      sanitizeStatusError(
        `failed to import server/index.mjs: Cannot find module '${PLUGINS_ROOT}/relmiss/server/nope.mjs' imported from ${PLUGINS_ROOT}/relmiss/server/index.mjs`,
        { pluginsRoot: PLUGINS_ROOT },
      ),
    ).toBe(
      "failed to import server/index.mjs: Cannot find module '<plugin>/relmiss/server/nope.mjs' imported from <plugin>/relmiss/server/index.mjs",
    );
  });

  it("erases an absolute path from anywhere else on the host", () => {
    expect(
      sanitizeStatusError(
        "failed to import server/index.mjs: Cannot find package 'effect' imported from /tmp/ru-code/a12/base/plugins/servereffect/server/index.mjs",
      ),
    ).toBe("failed to import server/index.mjs: Cannot find package 'effect' imported from <path>");
  });

  it("keeps the first line only, and leaves relative paths and URLs alone", () => {
    expect(sanitizeStatusError("boom\n    at activate (/home/zach/x.mjs:1:1)")).toBe("boom");
    expect(sanitizeStatusError("failed to import server/index.mjs: Unexpected end of input")).toBe(
      "failed to import server/index.mjs: Unexpected end of input",
    );
    expect(sanitizeStatusError("could not reach http://localhost:5733/plugins/x")).toBe(
      "could not reach http://localhost:5733/plugins/x",
    );
  });

  it("never answers with an empty string", () => {
    expect(sanitizeStatusError("   \n  ")).toBe("plugin failed to load");
  });

  // ── A12 round 2, finding R2-M1 ──────────────────────────────────────────────────────────────
  //
  // The first version's regex was ASCII-only and had no space in its class, so it replaced the
  // HEAD of a path and served the rest verbatim. The three shapes below are the auditor's, and
  // rows 1 and 2 are the DEFAULT install layout on Windows and macOS — i.e. the leak was the
  // normal case, not the exotic one. The round-1 regression test used a space-free `/tmp/…` dir,
  // which is why the suite stayed green.

  it("erases a Windows root whose username contains a space (R2-M1)", () => {
    const root = String.raw`C:\Users\John Smith\AppData\ru-code\plugins`;
    const sanitized = sanitizeStatusError(
      String.raw`failed to import server/index.mjs: Cannot find module '${root}\notes\server\x.mjs'`,
      { pluginsRoot: root },
    );
    expect(sanitized).toBe(
      String.raw`failed to import server/index.mjs: Cannot find module '<plugin>\notes\server\x.mjs'`,
    );
    expect(sanitized).not.toContain("John Smith");
  });

  it("erases a macOS root with a space in `Application Support` (R2-M1)", () => {
    const root = "/Users/z/Library/Application Support/ru-code/plugins";
    const sanitized = sanitizeStatusError(
      `failed to import server/index.mjs: Cannot find module '${root}/n/server/x.mjs'`,
      { pluginsRoot: root },
    );
    expect(sanitized).toBe(
      "failed to import server/index.mjs: Cannot find module '<plugin>/n/server/x.mjs'",
    );
    expect(sanitized).not.toContain("Library");
  });

  it("erases a non-ASCII home directory, roots given or not (R2-M1)", () => {
    const root = "/home/Захар/.ru-code/plugins";
    expect(
      sanitizeStatusError(`activate() failed: could not open ${root}/notes/x.json (ENOENT)`, {
        pluginsRoot: root,
      }),
    ).toBe("activate() failed: could not open <plugin>/notes/x.json (ENOENT)");
    // Even with NO root to erase, nothing path-shaped survives the residue sweep.
    const blind = sanitizeStatusError(
      `activate() failed: could not open ${root}/notes/x.json (ENOENT)`,
    );
    expect(blind).toBe("activate() failed: could not open <path> (ENOENT)");
    expect(blind).not.toContain("Захар");
  });

  it("erases the state dir, the base dir and the user's home by name (R2-M1)", () => {
    const sanitized = sanitizeStatusError(
      'migration "001" failed: unable to open database file /base/ru code/userdata/plugins/n/data.sqlite under /base/ru code',
      { baseDir: "/base/ru code", stateDir: "/base/ru code/userdata" },
    );
    expect(sanitized).toBe(
      'migration "001" failed: unable to open database file <state>/plugins/n/data.sqlite under <base>',
    );
  });

  // ── A16: the CLI config dir is now a root the host HANDS OUT ─────────────────────────────────
  //
  // `host.paths.cliConfigDir` tells a plugin where the CLI's tree is, so a plugin that scans it
  // will put that path into its own error messages — and `PluginStatus.error` is served
  // unauthenticated. The path is `{home}/.qwen`, i.e. it carries the OS username.
  it("erases the CLI config dir by name (A16)", () => {
    const cliConfigDir = "/home/zach/.qwen";
    const sanitized = sanitizeStatusError(
      `activate() failed: ENOENT: no such file or directory, scandir '${cliConfigDir}/projects'`,
      { cliConfigDir },
    );
    expect(sanitized).toBe(
      "activate() failed: ENOENT: no such file or directory, scandir '<cli-config>/projects'",
    );
    expect(sanitized).not.toContain("zach");
  });

  it("still prefers the most specific root when the CLI dir nests under another (A16)", () => {
    // The roots are sorted longest-first for exactly this: a CLI dir INSIDE the base dir must
    // claim its prefix before the shorter ancestor swallows it.
    const baseDir = "/home/zach/.ru-code";
    const cliConfigDir = "/home/zach/.ru-code/qwen";
    expect(
      sanitizeStatusError(`activate() failed: cannot read ${cliConfigDir}/projects/x`, {
        baseDir,
        cliConfigDir,
      }),
    ).toBe("activate() failed: cannot read <cli-config>/projects/x");
  });
});

it.layer(NodeServices.layer)("manifests.json never discloses a host path (R1-M2)", (it) => {
  it.effect("a Node module error reaches the status row with its paths replaced", () =>
    Effect.gen(function* () {
      // The auditor's `relmiss` fixture: a server entry importing a sibling that is not there.
      // Node's message names both files by ABSOLUTE path, and this row is served unauthenticated.
      const baseDir = yield* makeBaseDir({
        relmiss: {
          "plugin.json": manifestJson("relmiss", { server: "server/index.mjs" }),
          "server/index.mjs": `import "./nope.mjs";\nexport default { activate() {} };\n`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];

      expect(status?.state).toBe("failed");
      const error = status?.error ?? "";
      expect(error).toContain("failed to import server/index.mjs");
      expect(error).toContain("<plugin>");
      // BEFORE: the whole `<tmp>/base/plugins/relmiss/server/nope.mjs` was in here.
      expect(error).not.toContain(baseDir);
      // The plugin-relative tail is kept on purpose (`<plugin>/relmiss/server/index.mjs`); once it
      // is removed, nothing that looks like a filesystem path is left in the string at all.
      expect(error.replace(/<plugin>[\w.@~%+\-/]*/g, "")).not.toMatch(/\/[\w.@~%+-]+\//);
    }),
  );
});

/**
 * The auditor's own fixtures, as one plugin: `ATTACH DATABASE` reaching the app's event store, the
 * `PRAGMA` that enumerates attached files, a multi-statement `query`, a handler that resolves
 * `undefined`, and a handler that forgets `async`.
 */
const guardPlugin = {
  "plugin.json": manifestJson("probe", { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  migrations: [
    { id: "001", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" },
    // A12 round 3 (R3-M2 / R3-L2): the ARRAY form, and a table whose AUTOINCREMENT counter gives
    // this file a real \`sqlite_sequence\` to reset.
    {
      id: "002",
      sql: [
        "CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)",
        "INSERT INTO seq (body) VALUES ('x')",
      ],
    },
  ],
  rpc: {
    "attach": async (path, ctx) => {
      await ctx.storage.exec("ATTACH DATABASE '" + path + "' AS app");
      return ctx.storage.query("SELECT name FROM app.sqlite_master WHERE type='table' LIMIT 5");
    },
    "detach": async (_p, ctx) => ctx.storage.exec("DETACH DATABASE app"),
    "database-list": async (_p, ctx) => ctx.storage.query("PRAGMA database_list"),
    "attach-commented": async (path, ctx) =>
      ctx.storage.exec("-- share data\\n/* really */ ATTACH DATABASE '" + path + "' AS app"),
    "multi-query": async (_p, ctx) => ctx.storage.query("SELECT 1; SELECT 2"),
    "multi-exec": async (_p, ctx) => {
      await ctx.storage.exec("INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (2)");
      return ctx.storage.query("SELECT id FROM t ORDER BY id");
    },
    "user-version": async (_p, ctx) => ctx.storage.query("PRAGMA user_version"),
    "table-info": async (_p, ctx) =>
      (await ctx.storage.query("PRAGMA table_info(t)")).map((row) => row.name),
    "returns-undefined": async (_p, ctx) => {
      await ctx.storage.exec("DELETE FROM t");
    },
    "not-a-promise": () => ({ sync: true }),
    // A12 round 2 (R2-M2): the same pragmas under a SELECT, and a write to the schema table.
    "pragma-tvf": async (_p, ctx) => ctx.storage.query("SELECT * FROM pragma_database_list"),
    "pragma-tvf-call": async (_p, ctx) => ctx.storage.query("SELECT * FROM pragma_table_list()"),
    "schema-read": async (_p, ctx) =>
      (await ctx.storage.query("SELECT name FROM sqlite_master WHERE type='table'")).map(
        (row) => row.name,
      ),
    "schema-write": async (_p, ctx) => ctx.storage.exec("UPDATE sqlite_master SET sql = 'x'"),
    // A12 round 3 (R3-M1): the SAME pragmas, single-quoted — a legal table name in SQLite, and
    // the one spelling the round-2 guard blanked before it looked.
    "pragma-tvf-quoted": async (_p, ctx) =>
      ctx.storage.query("SELECT * FROM 'pragma_database_list'"),
    "pragma-tvf-view": async (_p, ctx) =>
      ctx.storage.exec("CREATE VIEW v_leak AS SELECT * FROM 'pragma_table_list'"),
    // …and a row that merely CONTAINS the word is still ordinary data.
    "store-the-word": async (_p, ctx) => {
      await ctx.storage.exec("INSERT INTO t (id) VALUES (7)");
      return ctx.storage.query("SELECT id FROM t WHERE id = 7 AND 'pragma_x' = 'pragma_x'");
    },
    // A12 round 3 (R3-L2): the one schema table SQLite lets an application write.
    "reset-sequence": async (_p, ctx) => {
      await ctx.storage.exec("DELETE FROM sqlite_sequence WHERE name = 'seq'");
      return ctx.storage.query("SELECT count(*) AS n FROM sqlite_sequence");
    },
  },
};
`,
};

const detailOf = (effect: Effect.Effect<unknown, PluginRpcError>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => (Result.isFailure(result) ? (result.failure.detail ?? "") : "<ok>")),
  );

it.layer(NodeServices.layer)("host.storage statement guard (A12 finding R1-H3)", (it) => {
  it.effect("refuses ATTACH — the app database stays out of reach", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);
      const appDb = `${stateDirOf(baseDir)}/state.sqlite`;

      expect(yield* detailOf(host.invoke("probe", "attach", appDb))).toContain(
        "storage: statement not allowed: ATTACH",
      );
      expect(yield* detailOf(host.invoke("probe", "detach", null))).toContain(
        "storage: statement not allowed: DETACH",
      );
      // Comments and whitespace do not hide the keyword: the guard runs on the SPLIT statements.
      expect(yield* detailOf(host.invoke("probe", "attach-commented", appDb))).toContain(
        "storage: statement not allowed: ATTACH",
      );

      // Nothing was attached — the connection still knows exactly one database, and the app's own
      // file was never created.
      expect(databaseList(`${stateDirOf(baseDir)}/plugins/probe/data.sqlite`)).toEqual(["main"]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(appDb).pipe(Effect.orElseSucceed(() => false))).toBe(false);
    }),
  );

  it.effect("refuses the pragmas that name files, and allows the small read-only set", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);

      expect(yield* detailOf(host.invoke("probe", "database-list", null))).toContain(
        "storage: statement not allowed: PRAGMA database_list",
      );
      expect(yield* host.invoke("probe", "user-version", null)).toEqual([{ user_version: 0 }]);
      expect(yield* host.invoke("probe", "table-info", null)).toEqual(["id"]);
    }),
  );

  it.effect("query takes one statement; exec may take several and runs all of them", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);

      expect(yield* detailOf(host.invoke("probe", "multi-query", null))).toContain(
        "storage: statement not allowed: 2 statements in one call",
      );
      // `node:sqlite` prepares only the first statement of a body, so `exec` used to drop the
      // rest silently; it now runs each of them, after checking each of them.
      expect(yield* host.invoke("probe", "multi-exec", null)).toEqual([{ id: 1 }, { id: 2 }]);
    }),
  );

  // ── A12 round 2, finding R2-M2 ──────────────────────────────────────────────────────────────
  it.effect("refuses the pragma_* table-valued functions, and keeps sqlite_ read-only", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);

      // BEFORE: this returned [{seq:0,name:"main",file:"<abs path to the plugin's data.sqlite>"}]
      // — the same pragma the keyword check refuses, reached through a SELECT.
      expect(yield* detailOf(host.invoke("probe", "pragma-tvf", null))).toContain(
        "storage: statement not allowed: pragma_database_list",
      );
      expect(yield* detailOf(host.invoke("probe", "pragma-tvf-call", null))).toContain(
        "storage: statement not allowed: pragma_table_list",
      );
      // Reading the schema is still allowed — it is the plugin's OWN schema.
      expect(yield* host.invoke("probe", "schema-read", null)).toContain("t");
      expect(yield* detailOf(host.invoke("probe", "schema-write", null))).toContain(
        "storage: statement not allowed: UPDATE sqlite_master",
      );
    }),
  );

  // ── A12 round 3, findings R3-M1 / R3-L2 ─────────────────────────────────────────────────────
  it.effect("refuses a SINGLE-QUOTED pragma_* table, and the VIEW that would park it", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);

      // BEFORE (over this same wire): "<ok>", returning
      // [{seq:0,name:"main",file:"<abs path to the plugin's data.sqlite>"}].
      expect(yield* detailOf(host.invoke("probe", "pragma-tvf-quoted", null))).toContain(
        "storage: statement not allowed: pragma_database_list",
      );
      // BEFORE: "<ok>" — and after it the whole schema lived in the plugin's own file, where a
      // statement containing no `pragma_` at all could read it back.
      expect(yield* detailOf(host.invoke("probe", "pragma-tvf-view", null))).toContain(
        "storage: statement not allowed: pragma_table_list",
      );
      // A value that merely says the word is still data.
      expect(yield* host.invoke("probe", "store-the-word", null)).toEqual([{ id: 7 }]);
      // R3-L2: resetting an AUTOINCREMENT counter in the plugin's own file is allowed — and the
      // array-form migration that created that counter applied (R3-M2, over the real wire).
      expect(yield* host.invoke("probe", "reset-sequence", null)).toEqual([{ n: 0 }]);
    }),
  );

  // ── A12 round 2, finding R2-M4 ──────────────────────────────────────────────────────────────
  it.effect("runs a migration whose body is a CREATE TRIGGER … BEGIN … END", () =>
    Effect.gen(function* () {
      // The auditor's `migtrigger` fixture, verbatim. BEFORE: state "failed", error
      // `migration "002" failed: Failed to prepare statement` — the splitter cut the trigger in
      // half at the `;` inside its body.
      const baseDir = yield* makeBaseDir({
        migtrigger: {
          "plugin.json": manifestJson("migtrigger", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  migrations: [
    { id: "001", sql: "CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)" },
    {
      id: "002",
      sql: "CREATE TRIGGER t_ins AFTER INSERT ON t BEGIN UPDATE t SET n = 1 WHERE id = new.id; END;",
    },
  ],
  rpc: {
    "insert": async (_p, ctx) => {
      await ctx.storage.exec("INSERT INTO t (id, n) VALUES ('a', 0)");
      return ctx.storage.query("SELECT n FROM t WHERE id = 'a'");
    },
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];
      expect(status?.error ?? "").toBe("");
      expect(status?.state).toBe("loaded");
      // The trigger did not just parse — it FIRED.
      expect(yield* host.invoke("migtrigger", "insert", null)).toEqual([{ n: 1 }]);
    }),
  );

  // ── A12 round 3, finding R3-M2 ──────────────────────────────────────────────────────────────
  it.effect("runs a trigger migration whose body uses `end` as a column, as an ARRAY", () =>
    Effect.gen(function* () {
      // The auditor's `migendalias` fixture. BEFORE (as one string): state "failed", error
      // `migration "002" failed: Failed to prepare statement` — the splitter read the `end` of
      // `SELECT new.end` as the body's terminator and cut the trigger in half. The array form
      // does not split at all, so there is nothing left to get wrong.
      const baseDir = yield* makeBaseDir({
        migendalias: {
          "plugin.json": manifestJson("migendalias", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  migrations: [
    {
      id: "001",
      sql: [
        "CREATE TABLE spans (id TEXT PRIMARY KEY, start INTEGER, end INTEGER)",
        "CREATE TABLE log (m INTEGER)",
      ],
    },
    {
      id: "002",
      sql: [
        "CREATE TRIGGER s_ins AFTER INSERT ON spans BEGIN INSERT INTO log (m) SELECT new.end; END",
      ],
    },
  ],
  rpc: {
    "insert": async (_p, ctx) => {
      await ctx.storage.exec("INSERT INTO spans (id, start, end) VALUES ('a', 1, 42)");
      return ctx.storage.query("SELECT m FROM log");
    },
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];
      expect(status?.error ?? "").toBe("");
      expect(status?.state).toBe("loaded");
      // The trigger did not just parse — it FIRED, with `end` as an ordinary column.
      expect(yield* host.invoke("migendalias", "insert", null)).toEqual([{ m: 42 }]);
    }),
  );

  it.effect("a migration that tries to ATTACH fails the migration, not the guard's silence", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        sneaky: {
          "plugin.json": manifestJson("sneaky", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  migrations: [{ id: "001-attach", sql: "ATTACH DATABASE 'other.sqlite' AS other" }],
  activate() {},
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];
      expect(status?.state).toBe("failed");
      expect(status?.error).toContain("storage: statement not allowed: ATTACH");
    }),
  );
});

it.layer(NodeServices.layer)("invoke result encoding (A12 findings R1-M3, R1-L11)", (it) => {
  it.effect("a handler that resolves undefined answers null instead of rejecting", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);
      // BEFORE: `Schema.Unknown` could not encode `undefined`, so the most natural write-only
      // handler rejected with "Expected JSON value" AFTER its DELETE had already run.
      expect(yield* host.invoke("probe", "returns-undefined", null)).toBeNull();
    }),
  );

  it.effect("a handler that forgets `async` is awaited, not blamed for a host internal", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ probe: guardPlugin });
      const host = yield* startHost(baseDir);
      // BEFORE: `detail: "internalCall(...).then is not a function"`.
      expect(yield* host.invoke("probe", "not-a-promise", null)).toEqual({ sync: true });
    }),
  );
});

// ru-code (A16, SDK 0.2.0): `host.paths` — the one new capability phase 2 needs.
//
// The value itself is trivial; what these pin is the two things a plugin cannot recover from if
// the host gets them wrong: the path must be the host's OWN answer (not something the plugin
// re-derives from env vars, which is what `qwen-cli-analytics`'s port doc forbids), and "no CLI
// here" must arrive as `null` rather than as a plausible-looking string — a plugin scanning `""`
// would enumerate the process's working directory and report an empty result instead of an error.
it.layer(NodeServices.layer)("host.paths (A16)", (it) => {
  it.effect("hands the plugin the host's own cliConfigDir", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths") });
      const host = yield* startHost(baseDir);
      // `layerTest` sets `cliConfigDir: baseDir`, `cliDetected: true`.
      // A22: `paths` gained `dataDir`, so the shape is asserted whole — a field silently
      // appearing or disappearing on this object is exactly what a plugin cannot see coming.
      expect(yield* host.invoke("paths", "paths", null)).toEqual({
        cliConfigDir: baseDir,
        dataDir: `${stateDirOf(baseDir)}/plugins/paths`,
      });
      expect(yield* host.invoke("paths", "cli-config-dir", null)).toBe(baseDir);
    }),
  );

  it.effect('is null — not "" — when the CLI was not detected at boot', () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths") });
      const host = yield* startHostWithConfig(baseDir, (config) => ({
        ...config,
        // What the real config carries on a machine with no qwen CLI (`config.ts`: "Empty/false
        // when the CLI is not present").
        cliJs: "",
        cliConfigDir: "",
        cliDetected: false,
      }));
      expect(yield* host.invoke("paths", "cli-config-dir", null)).toBeNull();
      expect(yield* host.invoke("paths", "paths", null)).toEqual({
        cliConfigDir: null,
        // A22: `dataDir` is NOT nullable and does not depend on the CLI at all — a plugin with no
        // qwen behind it still owns its own folder.
        dataDir: `${stateDirOf(baseDir)}/plugins/paths`,
      });
    }),
  );

  it.effect("keeps the CLI path out of the unauthenticated status row", () =>
    Effect.gen(function* () {
      // A plugin that fails while touching the tree the host pointed it at: the message names
      // `<cliConfigDir>/projects`, and `GET /plugins/manifests.json` serves it to any origin.
      const baseDir = yield* makeBaseDir({
        scanner: {
          "plugin.json": manifestJson("scanner", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  activate(host) {
    throw new Error("ENOENT: no such file or directory, scandir '" + host.paths.cliConfigDir + "/projects'");
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];

      expect(status?.state).toBe("failed");
      const error = status?.error ?? "";
      expect(error).toContain("ENOENT");
      // `layerTest` makes cliConfigDir === baseDir, which is a real temp path on this machine.
      expect(error).not.toContain(baseDir);
      expect(error).toContain("<");
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ru-code v2 — `ctx.paths.dataDir`, `ctx.projects` and the `session` seam (V2-5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

it.layer(NodeServices.layer)("host.paths.dataDir (A22)", (it) => {
  it.effect("is the folder that holds the plugin's own data.sqlite", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths") });
      const host = yield* startHost(baseDir);
      const dataDir = yield* host.invoke("paths", "data-dir", null);

      // The load-bearing relationship, and the reason the value is passed in rather than derived
      // a second time: the directory a plugin is told to write files into must be the SAME one
      // the host opened its database in, or a plugin's tree and its rows end up in two places.
      expect(dataDir).toBe(`${stateDirOf(baseDir)}/plugins/paths`);
      expect(`${String(dataDir)}/${PLUGIN_DB_FILENAME}`).toBe(
        `${stateDirOf(baseDir)}/plugins/paths/data.sqlite`,
      );
      // …and the host has already created it, so a plugin may write into it from `activate`.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* Effect.orDie(fs.exists(String(dataDir)))).toBe(true);
    }),
  );

  it.effect("is erased from the unauthenticated status row (A12 finding R1-M2)", () =>
    Effect.gen(function* () {
      // The whole reason this is pinned: `PluginStatus.error` is served by
      // `GET /plugins/manifests.json` with `access-control-allow-origin: *`, and a plugin that
      // fails while writing into the folder the host just pointed it at will put that absolute
      // path into the message. `dataDir` needs no root of its own — it lives under `stateDir`,
      // which the sanitizer already erases longest-first — but "already covered" is a claim, and
      // this is the assertion.
      const baseDir = yield* makeBaseDir({
        writer: {
          "plugin.json": manifestJson("writer", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  activate(ctx) {
    throw new Error("EACCES: permission denied, mkdir '" + ctx.paths.dataDir + "/skill-catalog'");
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      const status = (yield* host.list)[0];

      expect(status?.state).toBe("failed");
      const error = status?.error ?? "";
      expect(error).toContain("<state>/plugins/writer/skill-catalog");
      expect(error).not.toContain(baseDir);
      expect(error).not.toContain(NodeOS.homedir());
    }),
  );
});

it.layer(NodeServices.layer)("host.projects (A22, O2-a)", (it) => {
  it.effect("answers an empty list rather than rejecting when the read model is unavailable", () =>
    Effect.gen(function* () {
      // The in-memory SqlClient these tests provide has no `projection_projects` table, which is
      // the degraded case exactly: `host.projects` is promise-shaped, and a plugin that has to
      // try/catch "which projects exist" will not — so the honest answer is "none I can see",
      // which for a catalog plugin means global-only. A rejection here would surface inside
      // `activate()` as an unhandled rejection instead.
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths") });
      const host = yield* startHost(baseDir);
      expect(yield* host.invoke("paths", "projects", null)).toEqual([]);
    }),
  );

  it.effect(
    "maps a projection row to `{ id, name, cwd }`, with the project's own TITLE (V2-15)",
    () => {
      // The whole of what `ServerCtx.projects.list()` claims, as a pure function so the unit tier can
      // check it without a read model. `name` is the TITLE and not `basename(cwd)` — the derivation
      // the catalogs port had to use, which showed the folder for every renamed project (R3).
      expect(
        toPluginProject({ projectId: "p-1", title: "Renamed", workspaceRoot: "/tmp/folder-name" }),
      ).toEqual({ id: "p-1", name: "Renamed", cwd: "/tmp/folder-name" });
      return Effect.void;
    },
  );

  it.effect("hands the plugin its own id and nothing about any other plugin", () =>
    Effect.gen(function* () {
      // v2 narrowed `projects` to ONE method (`list`). `getCwd` went with it: a plugin that needs
      // one project's cwd filters the list, and a second lookup bought only a second failure mode.
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths"), ok: okPlugin("ok") });
      const host = yield* startHost(baseDir);
      expect(yield* host.invoke("paths", "plugin-id", null)).toBe("paths");
    }),
  );
});

/** The `PluginRpcError` an `invoke` rejected with, or `null` when it succeeded. */
const rejectionOf = (
  invoked: Effect.Effect<unknown, PluginRpcError>,
): Effect.Effect<PluginRpcError | null> =>
  Effect.result(invoked).pipe(
    Effect.map((outcome) => (Result.isFailure(outcome) ? outcome.failure : null)),
  );

it.layer(NodeServices.layer)("PluginRpcError.data (V2-7)", (it) => {
  it.effect("forwards a handler's STRUCTURED failure payload to the caller", () =>
    Effect.gen(function* () {
      // v1 gave a plugin one host-owned `reason` and a sentence, so both non-trivial plugins grew
      // a ~90-line module that encoded a failure kind into `Error.message` and parsed it back.
      const baseDir = yield* makeBaseDir({ ok: okPlugin("ok") });
      const host = yield* startHost(baseDir);
      const failure = yield* rejectionOf(host.invoke("ok", "boom-structured", null));

      expect(failure?.reason).toBe("plugin-failed");
      expect(failure?.detail).toContain("quota");
      expect(failure?.data).toEqual({ kind: "quota-exceeded", limit: 3 });
    }),
  );

  it.effect("leaves `data` absent for an ordinary throw, and never for an unencodable one", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        cyclic: {
          "plugin.json": manifestJson("cyclic", { server: "server/index.mjs" }),
          "server/index.mjs": `
export default {
  rpc: {
    "plain": async () => { throw new Error("nope"); },
    // A cycle cannot be encoded onto the wire — and failing the RPC on the way OUT would hide the
    // plugin's real error behind a schema complaint, so the payload is dropped and the detail stays.
    "cyclic": async () => {
      const data = {};
      data.self = data;
      throw Object.assign(new Error("looped"), { data });
    },
  },
};
`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* rejectionOf(host.invoke("cyclic", "plain", null)))?.data).toBeUndefined();
      const looped = yield* rejectionOf(host.invoke("cyclic", "cyclic", null));
      expect(looped?.data).toBeUndefined();
      expect(looped?.detail).toContain("looped");
    }),
  );
});

it.layer(NodeServices.layer)("the `session` seam (V2-5)", (it) => {
  const sessionPlugin = (id: string, body: string) => ({
    "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
    "server/index.mjs": `
export default {
  ${body}
};
`,
  });

  it.effect("is empty on an install with no `session` seam", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ ok: okPlugin("ok") });
      const host = yield* startHost(baseDir);
      expect(yield* host.sessions).toEqual([]);
    }),
  );

  it.effect("serves one seam per plugin, tagged with its owner and its ctx", () =>
    Effect.gen(function* () {
      // Ids are >= 2 characters — `^[a-z][a-z0-9-]{1,31}$`, the manifest's own rule.
      const baseDir = yield* makeBaseDir({
        alpha: sessionPlugin("alpha", `session: { fingerprint: async () => "fp-a" },`),
        beta: sessionPlugin("beta", `session: { provision: async () => {} },`),
      });
      const host = yield* startHost(baseDir);
      const seams = yield* host.sessions;

      expect(seams.map((entry) => entry.pluginId).sort()).toEqual(["alpha", "beta"]);
      // Both members are optional — a plugin that only provisions is a legal seam.
      const a = seams.find((entry) => entry.pluginId === "alpha");
      const b = seams.find((entry) => entry.pluginId === "beta");
      expect(typeof a?.session.fingerprint).toBe("function");
      expect(a?.session.provision).toBeUndefined();
      expect(typeof b?.session.provision).toBe("function");
      // The ctx the gate will pass in is this plugin's own.
      expect(a?.ctx.pluginId).toBe("alpha");
    }),
  );

  it.effect("passes the thread, the project and the plugin's ctx into `fingerprint`", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        echo: sessionPlugin(
          "echo",
          `session: {
    fingerprint: async (threadId, projectId, ctx) =>
      threadId + "|" + String(projectId) + "|" + ctx.pluginId,
  },`,
        ),
      });
      const host = yield* startHost(baseDir);
      const seams = yield* host.sessions;
      const seam = seams[0];
      expect(
        yield* Effect.promise(
          () => seam?.session.fingerprint?.("t1", null, seam.ctx) ?? Promise.resolve(null),
        ),
      ).toBe("t1|null|echo");
    }),
  );

  it.effect("ignores a `session` of the wrong shape without failing the plugin", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        junk: sessionPlugin("junk", `session: "not a seam", rpc: { ping: async () => "pong" },`),
      });
      const host = yield* startHost(baseDir);

      expect(yield* host.sessions).toEqual([]);
      // The plugin's OTHER seams survive: a bad seam costs the seam, not the plugin.
      expect((yield* host.list)[0]?.state).toBe("loaded");
      expect(yield* host.invoke("junk", "ping", null)).toBe("pong");
    }),
  );

  it.effect("never serves a seam from a plugin that is not loaded", () =>
    Effect.gen(function* () {
      // A plugin whose `activate` throws still EXPORTS its seams — the object was imported before
      // the lifecycle ran. A disabled plugin must not keep running inside every spawn.
      const baseDir = yield* makeBaseDir({
        broken: sessionPlugin(
          "broken",
          `session: { fingerprint: async () => "fp" },
  activate() { throw new Error("activate exploded"); },`,
        ),
      });
      const host = yield* startHost(baseDir);

      expect((yield* host.list)[0]?.state).toBe("failed");
      expect(yield* host.sessions).toEqual([]);
    }),
  );
});

// ru-code (V2-20/V2-21): TWO ROOTS — the shipped set inside the version payload, then the user's.
//
// The whole of the precedence rule lives in the order `start` walks the roots, so what is pinned
// here is what an operator would actually notice: which copy runs, what `manifests.json` says, and
// what is left on disk afterwards. `<baseDir>/plugins` is never written by the installer or the
// updater, so "the user's folder survives" is a property of the design — but it is also the one
// thing that must never regress, so it is asserted rather than argued.
it.layer(NodeServices.layer)("PluginHost — shipped + user roots (V2-21)", (it) => {
  it.effect("a shipped-only install loads from the payload", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({});
      const shipped = yield* makeShippedDir({ analytics: okPlugin("analytics") });
      const host = yield* startHostWithShipped(baseDir, shipped);

      expect((yield* host.list).map((status) => [status.id, status.state])).toEqual([
        ["analytics", "loaded"],
      ]);
      expect(yield* host.invoke("analytics", "echo", { a: 1 })).toEqual({
        echoed: { a: 1 },
        id: "analytics",
      });
    }).pipe(Effect.scoped),
  );

  // The regression half: a user plugin must keep working exactly as it did before there was a
  // second root, including when the shipped root does not exist at all (a fork, a minimal build).
  it.effect("a user-only install is unchanged, shipped root absent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: okPlugin("notes") });
      const host = yield* startHostWithShipped(baseDir, path.join(baseDir, "no-such-shipped-root"));

      expect((yield* host.list).map((status) => [status.id, status.state])).toEqual([
        ["notes", "loaded"],
      ]);
      expect(yield* host.resolvePluginDir("notes")).toBe(path.join(baseDir, "plugins", "notes"));
    }).pipe(Effect.scoped),
  );

  it.effect("both roots load, shipped first and name-sorted within each root", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        alpha: okPlugin("alpha"),
        omega: okPlugin("omega"),
      });
      const shipped = yield* makeShippedDir({
        catalogs: okPlugin("catalogs"),
        analytics: okPlugin("analytics"),
      });
      const host = yield* startHostWithShipped(baseDir, shipped);

      // `registry.ts` depends on this order being deterministic: every shipped plugin (sorted),
      // then every user plugin (sorted) — never interleaved and never scan-order-of-the-filesystem.
      expect((yield* host.list).map((status) => status.id)).toEqual([
        "analytics",
        "catalogs",
        "alpha",
        "omega",
      ]);
      expect((yield* host.list).every((status) => status.state === "loaded")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("an id in both roots: the SHIPPED copy loads, once, and the user folder stays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Same id, different code — so "which one ran" is answerable, not inferred.
      const baseDir = yield* makeBaseDir({
        analytics: {
          "plugin.json": manifestJson("analytics", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { rpc: { "who": async () => "user" } };`,
        },
      });
      const shipped = yield* makeShippedDir({
        analytics: {
          "plugin.json": manifestJson("analytics", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { rpc: { "who": async () => "shipped" } };`,
        },
      });
      const host = yield* startHostWithShipped(baseDir, shipped);

      // ONE row for the id — `manifests.json` is keyed by id and the web loader fetches
      // `/plugins/<id>/web/index.mjs`, so a second row could only ever be a lie.
      expect((yield* host.list).filter((status) => status.id === "analytics")).toHaveLength(1);
      expect(yield* host.invoke("analytics", "who", null)).toBe("shipped");
      // The asset route resolves through `resolvePluginDir`, so this is also the proof that
      // `/plugins/analytics/web/*` serves the payload's bytes and not the user's.
      expect(yield* host.resolvePluginDir("analytics")).toBe(path.join(shipped, "analytics"));
      // D11: the host never deletes a user's folder. It is shadowed, not removed.
      expect(yield* fs.exists(path.join(baseDir, "plugins", "analytics", "plugin.json"))).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  );

  // "Shipped wins" is a rule about which copy is the app's, not about which copy happens to work:
  // falling back to a stale user copy is exactly the invisible shadow the ordering prevents.
  it.effect("a BROKEN shipped copy still wins its id — no silent fallback to the user's", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ analytics: okPlugin("analytics") });
      const shipped = yield* makeShippedDir({
        analytics: { "plugin.json": "{ not json" },
      });
      const host = yield* startHostWithShipped(baseDir, shipped);

      const rows = yield* host.list;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("analytics");
      expect(rows[0]?.state).toBe("skipped");
      expect(yield* host.resolvePluginDir("analytics")).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  // Both overrides are test-only and a run may legitimately point them at one fixture; scanning it
  // twice would report every plugin in it as its own shadow.
  it.effect("the same directory as both roots is scanned once", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: okPlugin("notes") });
      const host = yield* startHostWithShipped(baseDir, path.join(baseDir, "plugins"));

      expect((yield* host.list).map((status) => [status.id, status.state])).toEqual([
        ["notes", "loaded"],
      ]);
    }).pipe(Effect.scoped),
  );

  // A12 finding R1-M2 again, for the root this change adds: `manifests.json` is unauthenticated.
  it.effect("a shipped plugin's failure message does not disclose the payload path", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({});
      const shipped = yield* makeShippedDir({
        analytics: {
          "plugin.json": manifestJson("analytics", { server: "server/index.mjs" }),
          "server/index.mjs": `import "./nope.mjs";\nexport default {};`,
        },
      });
      const host = yield* startHostWithShipped(baseDir, shipped);

      const row = (yield* host.list)[0];
      expect(row?.state).toBe("failed");
      expect(row?.error).toBeDefined();
      expect(row?.error).not.toContain(shipped);
      expect(row?.error).toContain("<shipped>");
    }).pipe(Effect.scoped),
  );
});

// ru-code (V2-21): the opt-out, at the host.
//
// `disabled.test.ts` covers reading the file; what matters here is the TIMING — the check happens
// before anything inside the folder runs, so a disabled plugin is inert rather than merely hidden.
// That is proved by side effects a plugin can only have if it was executed: no database file, no
// row in `plugin.list`, and `invoke` refusing it.

// ru-code S38 (V2-43): a manifest may ship the plugin switched off, and the USER's switch beats it.
it.layer(NodeServices.layer)("PluginHost — manifest `enabled` (V2-43)", (it) => {
  const writeSwitches = (
    baseDir: string,
    switches: {
      readonly disabled?: ReadonlyArray<string>;
      readonly enabled?: ReadonlyArray<string>;
    },
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(stateDirOf(baseDir), "plugins");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "disabled.json"), switchesJson(switches));
    }).pipe(Effect.orDie);

  /** A plugin whose `activate` leaves a marker on disk, so "did it run" is a file, not an inference. */
  const markerPlugin = (id: string, overrides: Record<string, unknown> = {}) => ({
    "plugin.json": manifestJson(id, { server: "server/index.mjs", ...overrides }),
    "server/index.mjs": `
import { writeFileSync } from "node:fs";
export default { activate(ctx) { writeFileSync(ctx.paths.dataDir + "/ACTIVATED", "yes"); } };
`,
  });

  it.effect("`enabled: false` is a skip with its own reason, and nothing in the folder ran", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: markerPlugin("notes", { enabled: false }) });
      const host = yield* startHost(baseDir);

      const rows = yield* host.list;
      expect(rows[0]).toMatchObject({
        id: "notes",
        state: "skipped",
        error: "disabled by the manifest",
      });
      expect(yield* host.resolvePluginDir("notes")).toBeUndefined();
      const dataDir = path.join(stateDirOf(baseDir), "plugins", "notes");
      expect(yield* fs.exists(path.join(dataDir, "ACTIVATED"))).toBe(false);
      expect(yield* fs.exists(path.join(dataDir, PLUGIN_DB_FILENAME))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("`enabled: true` and an absent `enabled` both load, as they always did", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: markerPlugin("notes", { enabled: true }),
        other: markerPlugin("other"),
      });
      const host = yield* startHost(baseDir);
      const rows = yield* host.list;
      expect(rows.map((row) => [row.id, row.state]).toSorted()).toEqual([
        ["notes", "loaded"],
        ["other", "loaded"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a bogus `enabled` reads as TRUE — a typo costs the typo, not the plugin", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        notes: markerPlugin("notes", { enabled: "false" }),
        other: markerPlugin("other", { enabled: 0 }),
      });
      const host = yield* startHost(baseDir);
      const rows = yield* host.list;
      expect(rows.map((row) => [row.id, row.state]).toSorted()).toEqual([
        ["notes", "loaded"],
        ["other", "loaded"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("the USER's `enabled` entry loads a manifest-disabled plugin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: markerPlugin("notes", { enabled: false }) });
      yield* writeSwitches(baseDir, { enabled: ["notes"] });
      const host = yield* startHost(baseDir);

      expect(yield* host.list).toMatchObject([{ id: "notes", state: "loaded" }]);
      const dataDir = path.join(stateDirOf(baseDir), "plugins", "notes");
      expect(yield* fs.exists(path.join(dataDir, "ACTIVATED"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("the USER's `disabled` entry still wins over a manifest that ships it on", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ notes: markerPlugin("notes", { enabled: true }) });
      yield* writeSwitches(baseDir, { disabled: ["notes"] });
      const host = yield* startHost(baseDir);
      expect(yield* host.list).toMatchObject([
        { id: "notes", state: "skipped", error: "disabled by the operator" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a SHIPPED plugin shipped off is skipped too — both roots, one rule", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({});
      const shipped = yield* makeShippedDir({
        analytics: {
          "plugin.json": manifestJson("analytics", { apiVersion: 2, enabled: false }),
        },
      });
      const host = yield* startHostWithShipped(baseDir, shipped);
      expect(yield* host.list).toMatchObject([
        { id: "analytics", state: "skipped", error: "disabled by the manifest" },
      ]);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("PluginHost — disabled.json (V2-21)", (it) => {
  const writeDisabledList = (baseDir: string, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(stateDirOf(baseDir), "plugins");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "disabled.json"), disabledListJson(ids));
    }).pipe(Effect.orDie);

  it.effect("a disabled USER plugin is skipped, and nothing in its folder ran", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({
        // `activate` writes a file: if the folder ran at all, this is on disk afterwards.
        notes: {
          "plugin.json": manifestJson("notes", { server: "server/index.mjs" }),
          "server/index.mjs": `
import { writeFileSync } from "node:fs";
export default {
  migrations: [{ id: "001", sql: "CREATE TABLE t(x)" }],
  activate(ctx) { writeFileSync(ctx.paths.dataDir + "/ACTIVATED", "yes"); },
  rpc: { "ping": async () => "pong" },
};
`,
        },
      });
      yield* writeDisabledList(baseDir, ["notes"]);
      const host = yield* startHost(baseDir);

      const rows = yield* host.list;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "notes",
        state: "skipped",
        error: "disabled by the operator",
      });
      // `statusFor` reports what the browser can FETCH, and a skipped plugin's assets 404.
      expect(rows[0]?.hasWeb).toBe(false);
      expect(yield* host.resolvePluginDir("notes")).toBeUndefined();
      expect(yield* host.sessions).toEqual([]);
      // Nothing inside the folder ran: no activate marker and — the stronger claim — no database,
      // which the host opens EAGERLY for every server plugin it activates.
      const dataDir = path.join(stateDirOf(baseDir), "plugins", "notes");
      expect(yield* fs.exists(path.join(dataDir, "ACTIVATED"))).toBe(false);
      expect(yield* fs.exists(path.join(dataDir, PLUGIN_DB_FILENAME))).toBe(false);
      // The folder itself is untouched — the list is reversible, not a delete.
      expect(yield* fs.exists(path.join(baseDir, "plugins", "notes", "plugin.json"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("a disabled SHIPPED plugin is skipped too — the case the list exists for", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({});
      const shipped = yield* makeShippedDir({ analytics: okPlugin("analytics") });
      yield* writeDisabledList(baseDir, ["analytics"]);
      const host = yield* startHostWithShipped(baseDir, shipped);

      expect((yield* host.list).map((status) => [status.id, status.state, status.error])).toEqual([
        ["analytics", "skipped", "disabled by the operator"],
      ]);
      const refused = yield* Effect.result(host.invoke("analytics", "echo", null));
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect((refused.failure as PluginRpcError).reason).toBe("plugin-disabled");
      }
    }).pipe(Effect.scoped),
  );

  // The list names ids, not roots: a disabled id is disabled wherever it lives, and the user's
  // copy does not quietly take over the slot the shipped one vacated.
  it.effect("a disabled id in BOTH roots yields one skipped row and runs neither copy", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ analytics: okPlugin("analytics") });
      const shipped = yield* makeShippedDir({ analytics: okPlugin("analytics") });
      yield* writeDisabledList(baseDir, ["analytics"]);
      const host = yield* startHostWithShipped(baseDir, shipped);

      const rows = yield* host.list;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("skipped");
      expect(rows[0]?.error).toBe("disabled by the operator");
    }).pipe(Effect.scoped),
  );

  it.effect("the plugins NOT on the list are unaffected", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        alpha: okPlugin("alpha"),
        omega: okPlugin("omega"),
      });
      yield* writeDisabledList(baseDir, ["alpha"]);
      const host = yield* startHost(baseDir);

      expect((yield* host.list).map((status) => [status.id, status.state])).toEqual([
        ["alpha", "skipped"],
        ["omega", "loaded"],
      ]);
      expect(yield* host.invoke("omega", "echo", 1)).toEqual({ echoed: 1, id: "omega" });
    }).pipe(Effect.scoped),
  );

  // A hand-edited file must never be able to switch something off by accident.
  it.effect("a corrupt list disables nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir({ notes: okPlugin("notes") });
      const dir = path.join(stateDirOf(baseDir), "plugins");
      yield* Effect.orDie(fs.makeDirectory(dir, { recursive: true }));
      yield* Effect.orDie(fs.writeFileString(path.join(dir, "disabled.json"), "{ notes }"));
      const host = yield* startHost(baseDir);

      expect((yield* host.list).map((status) => [status.id, status.state])).toEqual([
        ["notes", "loaded"],
      ]);
    }).pipe(Effect.scoped),
  );

  // A disabled folder that is ALSO broken reports the opt-out, not the parse error: the operator
  // asked for it to be off, and "off" is a more useful answer than a fault they did not ask about.
  it.effect("an unreadable folder that is disabled reports the opt-out", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ notes: { "plugin.json": "{ not json" } });
      yield* writeDisabledList(baseDir, ["notes"]);
      const host = yield* startHost(baseDir);

      expect((yield* host.list).map((status) => [status.id, status.state, status.error])).toEqual([
        ["notes", "skipped", "disabled by the operator"],
      ]);
    }).pipe(Effect.scoped),
  );
});
