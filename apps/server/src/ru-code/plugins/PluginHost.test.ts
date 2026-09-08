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
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../../config.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import type { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";

import {
  normalizeServerDefinition,
  PluginHost,
  PluginHostLayer,
  sanitizeStatusError,
  statusErrorFromCause,
} from "./PluginHost.ts";
import { PLUGIN_DB_FILENAME } from "./paths.ts";
import { PLUGIN_MIGRATIONS_TABLE } from "./storage.ts";

type Files = Readonly<Record<string, string>>;

const manifestJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, ...overrides });

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

/** ru-code (A16): reports what the host handed it under `host.paths` (SDK 0.2.0). */
const pathsPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  activate(host) {
    host.registerRpc("paths", async () => host.paths);
    host.registerRpc("cli-config-dir", async () => host.paths.cliConfigDir);
    // ru-code (A22, SDK 0.3.0)
    host.registerRpc("data-dir", async () => host.paths.dataDir);
    host.registerRpc("projects", async () => host.projects.listLive());
    host.registerRpc("project-cwd", async (id) => host.projects.getCwd(id));
  },
};
`,
});

const okPlugin = (id: string) => ({
  "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
  "server/index.mjs": `
export default {
  activate(host) {
    host.log.info("activated");
    host.registerRpc("echo", async (payload) => ({ echoed: payload, id: host.id }));
    host.registerRpc("boom", async () => {
      throw new Error("handler exploded");
    });
    host.registerRpc("locale", async () => host.getLocale());
  },
};
`,
});

describe("normalizeServerDefinition", () => {
  it("accepts the documented object shape and a bare function", () => {
    const activate = () => {};
    expect(normalizeServerDefinition({ activate })?.activate).toBe(activate);
    expect(normalizeServerDefinition(activate)?.activate).toBe(activate);
    expect(
      normalizeServerDefinition({ activate, migrations: [{ id: "a", sql: "SELECT 1" }] })
        ?.migrations,
    ).toHaveLength(1);
  });

  it("rejects anything that cannot be activated", () => {
    for (const value of [undefined, null, 42, "activate", {}, { activate: 1 }, []]) {
      expect(normalizeServerDefinition(value)).toBeNull();
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

  it.effect("a default export that is not a plugin definition is failed", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        shapeless: {
          "plugin.json": manifestJson("shapeless", { server: "server/index.mjs" }),
          "server/index.mjs": `export default { nope: true };`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.error).toContain("not a plugin definition");
    }),
  );

  it.effect("a bare function default export is accepted as activate", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        bare: {
          "plugin.json": manifestJson("bare", { server: "server/index.mjs" }),
          "server/index.mjs": `export default (host) => { host.registerRpc("ping", async () => "pong"); };`,
        },
      });
      const host = yield* startHost(baseDir);
      expect((yield* host.list)[0]?.state).toBe("loaded");
      expect(yield* host.invoke("bare", "ping", undefined)).toBe("pong");
    }),
  );

  it.effect("a web-only plugin is loaded with hasServer false", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        webonly: {
          "plugin.json": manifestJson("webonly", { web: "web/index.mjs", styles: "web/s.css" }),
          "web/index.mjs": `export default { activate() {} };`,
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
          "web/index.mjs": `export default { activate() {} };`,
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
  activate(host) {
    host.registerRpc("add", async (body) => {
      await host.storage.exec("INSERT INTO notes (body) VALUES (?)", [body]);
      const rows = await host.storage.query("SELECT body FROM notes ORDER BY id");
      return rows.map((row) => row.body);
    });
    host.registerRpc("bad-sql", async () => host.storage.query("SELECT * FROM nowhere"));
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
  activate(host) {
    host.registerRpc("attach", async (path) => {
      await host.storage.exec("ATTACH DATABASE '" + path + "' AS app");
      return host.storage.query("SELECT name FROM app.sqlite_master WHERE type='table' LIMIT 5");
    });
    host.registerRpc("detach", async () => host.storage.exec("DETACH DATABASE app"));
    host.registerRpc("database-list", async () => host.storage.query("PRAGMA database_list"));
    host.registerRpc("attach-commented", async (path) =>
      host.storage.exec("-- share data\\n/* really */ ATTACH DATABASE '" + path + "' AS app"),
    );
    host.registerRpc("multi-query", async () => host.storage.query("SELECT 1; SELECT 2"));
    host.registerRpc("multi-exec", async () => {
      await host.storage.exec("INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (2)");
      return host.storage.query("SELECT id FROM t ORDER BY id");
    });
    host.registerRpc("user-version", async () => host.storage.query("PRAGMA user_version"));
    host.registerRpc("table-info", async () =>
      (await host.storage.query("PRAGMA table_info(t)")).map((row) => row.name),
    );
    host.registerRpc("returns-undefined", async () => {
      await host.storage.exec("DELETE FROM t");
    });
    host.registerRpc("not-a-promise", () => ({ sync: true }));
    // A12 round 2 (R2-M2): the same pragmas under a SELECT, and a write to the schema table.
    host.registerRpc("pragma-tvf", async () =>
      host.storage.query("SELECT * FROM pragma_database_list"),
    );
    host.registerRpc("pragma-tvf-call", async () =>
      host.storage.query("SELECT * FROM pragma_table_list()"),
    );
    host.registerRpc("schema-read", async () =>
      (await host.storage.query("SELECT name FROM sqlite_master WHERE type='table'")).map(
        (row) => row.name,
      ),
    );
    host.registerRpc("schema-write", async () =>
      host.storage.exec("UPDATE sqlite_master SET sql = 'x'"),
    );
    // A12 round 3 (R3-M1): the SAME pragmas, single-quoted — a legal table name in SQLite, and
    // the one spelling the round-2 guard blanked before it looked.
    host.registerRpc("pragma-tvf-quoted", async () =>
      host.storage.query("SELECT * FROM 'pragma_database_list'"),
    );
    host.registerRpc("pragma-tvf-view", async () =>
      host.storage.exec("CREATE VIEW v_leak AS SELECT * FROM 'pragma_table_list'"),
    );
    // …and a row that merely CONTAINS the word is still ordinary data.
    host.registerRpc("store-the-word", async () => {
      await host.storage.exec("INSERT INTO t (id) VALUES (7)");
      return host.storage.query("SELECT id FROM t WHERE id = 7 AND 'pragma_x' = 'pragma_x'");
    });
    // A12 round 3 (R3-L2): the one schema table SQLite lets an application write.
    host.registerRpc("reset-sequence", async () => {
      await host.storage.exec("DELETE FROM sqlite_sequence WHERE name = 'seq'");
      return host.storage.query("SELECT count(*) AS n FROM sqlite_sequence");
    });
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
  activate(host) {
    host.registerRpc("insert", async () => {
      await host.storage.exec("INSERT INTO t (id, n) VALUES ('a', 0)");
      return host.storage.query("SELECT n FROM t WHERE id = 'a'");
    });
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
  activate(host) {
    host.registerRpc("insert", async () => {
      await host.storage.exec("INSERT INTO spans (id, start, end) VALUES ('a', 1, 42)");
      return host.storage.query("SELECT m FROM log");
    });
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
// ru-code (A22, SDK 0.3.0) — `paths.dataDir`, `host.projects` (O2-a), `registerSessionHook` (O1-B)
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
  activate(host) {
    throw new Error("EACCES: permission denied, mkdir '" + host.paths.dataDir + "/skill-catalog'");
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

  it.effect("answers null for an unknown project id, and never throws on a malformed one", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ paths: pathsPlugin("paths") });
      const host = yield* startHost(baseDir);

      expect(yield* host.invoke("paths", "project-cwd", "nope")).toBeNull();
      // `ProjectId` is a branded decode, so a junk id THROWS inside the decode rather than
      // returning — the `Effect.suspend` in `PluginHost.ts` is what turns that into this `null`
      // instead of a synchronous throw out of the promise the plugin awaited.
      expect(yield* host.invoke("paths", "project-cwd", "../../etc/passwd")).toBeNull();
      expect(yield* host.invoke("paths", "project-cwd", "")).toBeNull();
      expect(yield* host.invoke("paths", "project-cwd", null)).toBeNull();
    }),
  );
});

it.layer(NodeServices.layer)("registerSessionHook (A22, O1-B)", (it) => {
  const hookPlugin = (id: string, body: string) => ({
    "plugin.json": manifestJson(id, { server: "server/index.mjs" }),
    "server/index.mjs": `
export default {
  activate(host) {
    ${body}
  },
};
`,
  });

  it.effect("is empty on an install with no hooks — today's behaviour, byte for byte", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({ ok: okPlugin("ok") });
      const host = yield* startHost(baseDir);
      expect(yield* host.sessionHooks).toEqual([]);
    }),
  );

  it.effect("records one hook per plugin, tagged with its owner", () =>
    Effect.gen(function* () {
      // Ids are >= 2 characters — `^[a-z][a-z0-9-]{1,31}$`, the manifest's own rule.
      const baseDir = yield* makeBaseDir({
        alpha: hookPlugin(
          "alpha",
          `host.registerSessionHook({ changedForThread: async () => "fp-a" });`,
        ),
        beta: hookPlugin(
          "beta",
          `host.registerSessionHook({ provisionWorktree: async () => {} });`,
        ),
      });
      const host = yield* startHost(baseDir);
      const hooks = yield* host.sessionHooks;

      expect(hooks.map((entry) => entry.pluginId).sort()).toEqual(["alpha", "beta"]);
      // Both members are optional — a plugin that only provisions is a legal hook.
      const a = hooks.find((entry) => entry.pluginId === "alpha");
      const b = hooks.find((entry) => entry.pluginId === "beta");
      expect(typeof a?.hook.changedForThread).toBe("function");
      expect(a?.hook.provisionWorktree).toBeUndefined();
      expect(typeof b?.hook.provisionWorktree).toBe("function");
    }),
  );

  it.effect("replaces on a second registration — the SDK's last-one-wins rule", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        twice: hookPlugin(
          "twice",
          `host.registerSessionHook({ changedForThread: async () => "first" });
     host.registerSessionHook({ changedForThread: async () => "second" });`,
        ),
      });
      const host = yield* startHost(baseDir);
      const hooks = yield* host.sessionHooks;

      expect(hooks).toHaveLength(1);
      expect(
        yield* Effect.promise(
          () =>
            hooks[0]?.hook.changedForThread?.({ threadId: "t", projectId: null }) ??
            Promise.resolve(null),
        ),
      ).toBe("second");
    }),
  );

  it.effect("ignores a non-object hook without failing activate", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir({
        junk: hookPlugin(
          "junk",
          `host.registerSessionHook("not a hook");
     host.registerRpc("ping", async () => "pong");`,
        ),
      });
      const host = yield* startHost(baseDir);

      expect(yield* host.sessionHooks).toEqual([]);
      // The plugin's OTHER registrations survive: a bad hook costs the hook, not the plugin.
      expect((yield* host.list)[0]?.state).toBe("loaded");
      expect(yield* host.invoke("junk", "ping", null)).toBe("pong");
    }),
  );

  it.effect("never serves a hook from a plugin that is not loaded", () =>
    Effect.gen(function* () {
      // Registering a hook and THEN throwing is the realistic shape: `activate` runs top to
      // bottom, so a plugin can be half-registered when it fails. A disabled plugin must not keep
      // running inside every spawn.
      const baseDir = yield* makeBaseDir({
        broken: hookPlugin(
          "broken",
          `host.registerSessionHook({ changedForThread: async () => "fp" });
     throw new Error("activate exploded");`,
        ),
      });
      const host = yield* startHost(baseDir);

      expect((yield* host.list)[0]?.state).toBe("failed");
      expect(yield* host.sessionHooks).toEqual([]);
    }),
  );
});
