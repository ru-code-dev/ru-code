// ru-code: what `/plugins/*` will and will not hand to a browser.
//
// Served over a REAL loopback HTTP server (`NodeHttpServer.layerTest`, the
// `ru-code/tests/auth/localAutoAuth.test.ts` pattern) rather than by calling the
// handler directly: the traversal cases are about what an ATTACKER can put on
// the wire, and percent-encoding, empty segments and `\0` only behave the same
// way once a real request has been parsed into a URL.
//
// node:http is used deliberately — `fetch` normalises `..` out of a path before
// the request is sent, which would silently turn the traversal cases green.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as ServerConfig from "../../../config.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { PluginHost, PluginHostLayer } from "../../plugins/PluginHost.ts";
import { pluginAssetRoutes } from "../../plugins/httpRoutes.ts";
import { SHIPPED_PLUGINS_DIR_ENV_VAR } from "../../plugins/paths.ts";

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

type Response = {
  readonly status: number;
  readonly body: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
};

/** Raw GET — the path is sent verbatim, traversal and all. */
const get = (port: number, rawPath: string): Effect.Effect<Response, Error> =>
  Effect.callback<Response, Error>((resume) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path: rawPath, method: "GET" },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body,
              headers: response.headers,
            }),
          );
        });
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end();
  });

const manifestJson = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 2, ...overrides });

const FIXTURE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  demo: {
    "plugin.json": manifestJson("demo", { web: "web/index.mjs", styles: "web/styles.css" }),
    "web/index.mjs": "export default { activate() {} };\n",
    "web/styles.css": ":root { --demo: 1; }\n",
    "web/nested/icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n",
    "assets/logo.png": "not-really-a-png",
    "server/index.mjs": "export default { activate() {} };\n",
    "secret.txt": "do not serve me",
  },
};

/** Write the fixture, start a host over it, serve the routes, hand back the port. */
const withServer = <A, E>(run: (port: number) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-routes-" }),
    );
    for (const [id, files] of Object.entries(FIXTURE)) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(baseDir, "plugins", id, rel);
        yield* Effect.orDie(fs.makeDirectory(path.dirname(abs), { recursive: true }));
        yield* Effect.orDie(fs.writeFileString(abs, content));
      }
    }
    // A symlink inside `web/` pointing at a file outside the plugin folder.
    const outside = path.join(baseDir, "outside.txt");
    yield* Effect.orDie(fs.writeFileString(outside, "escaped"));
    yield* Effect.orDie(
      fs.symlink(outside, path.join(baseDir, "plugins", "demo", "web", "link.txt")),
    );

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

    yield* Layer.launch(
      HttpRouter.serve(pluginAssetRoutes.pipe(Layer.provide(Layer.succeed(PluginHost, host)))),
    ).pipe(Effect.forkScoped);

    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      throw new Error("test http server has no port");
    }
    return yield* run(address.port);
  });

it.layer(NodeServices.layer)("plugin asset routes", (it) => {
  it.effect("manifests.json lists the scanned plugins and is never cached", () =>
    withServer((port) =>
      Effect.gen(function* () {
        const response = yield* get(port, "/plugins/manifests.json");
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the raw wire bytes, not a decoded DTO.
        const list = JSON.parse(response.body) as ReadonlyArray<Record<string, unknown>>;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          id: "demo",
          state: "loaded",
          hasWeb: true,
          hasServer: false,
          styles: "web/styles.css",
        });
        // Never an absolute filesystem path.
        expect(response.body).not.toContain("/plugins/demo/web");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "host-modules.json is GONE — v2 publishes the shared list as the page's import map",
    () =>
      withServer((port) =>
        Effect.gen(function* () {
          // v1 served the 50-entry host-provided contract here "for runtime introspection" and
          // nothing ever fetched it. The shared list is ten entries now and the page carries them
          // in a real import map, so the route has nothing left to say.
          const response = yield* get(port, "/plugins/host-modules.json");
          expect([400, 404]).toContain(response.status);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("web and asset files are served with the right MIME and no-cache", () =>
    withServer((port) =>
      Effect.gen(function* () {
        const mjs = yield* get(port, "/plugins/demo/web/index.mjs");
        expect(mjs.status).toBe(200);
        // A browser refuses to execute a module served as anything else.
        expect(mjs.headers["content-type"]).toContain("text/javascript");
        expect(mjs.headers["cache-control"]).toBe("no-cache");
        expect(mjs.headers["x-content-type-options"]).toBe("nosniff");
        expect(mjs.body).toContain("activate");

        const css = yield* get(port, "/plugins/demo/web/styles.css");
        expect(css.status).toBe(200);
        expect(css.headers["content-type"]).toContain("text/css");

        const svg = yield* get(port, "/plugins/demo/web/nested/icon.svg");
        expect(svg.status).toBe(200);
        expect(svg.headers["content-type"]).toContain("image/svg+xml");
        expect(svg.headers["content-security-policy"]).toContain("sandbox");

        const png = yield* get(port, "/plugins/demo/assets/logo.png");
        expect(png.status).toBe(200);
        expect(png.headers["content-type"]).toContain("image/png");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("server code, the manifest and stray files are never served", () =>
    withServer((port) =>
      Effect.gen(function* () {
        for (const target of [
          "/plugins/demo/server/index.mjs",
          "/plugins/demo/plugin.json",
          "/plugins/demo/secret.txt",
          "/plugins/demo/web",
          "/plugins/demo",
        ]) {
          const response = yield* get(port, target);
          expect([400, 404]).toContain(response.status);
          expect(response.body).not.toContain("do not serve me");
          expect(response.body).not.toContain("activate");
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("traversal, encoded traversal, NUL and absolute paths are refused", () =>
    withServer((port) =>
      Effect.gen(function* () {
        for (const target of [
          "/plugins/demo/web/../plugin.json",
          "/plugins/demo/web/..%2fplugin.json",
          "/plugins/demo/web/%2e%2e%2fplugin.json",
          "/plugins/../../etc/passwd",
          "/plugins/demo/web/index.mjs%00.png",
          "/plugins//web/index.mjs",
          "/plugins/demo/web//index.mjs",
          "/plugins//etc/passwd",
        ]) {
          const response = yield* get(port, target);
          expect([400, 404]).toContain(response.status);
          expect(response.body).not.toContain("apiVersion");
          expect(response.body).not.toContain("root:");
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("an unknown or malformed plugin id never becomes a filesystem path", () =>
    withServer((port) =>
      Effect.gen(function* () {
        expect((yield* get(port, "/plugins/nope/web/index.mjs")).status).toBe(404);
        // Not a valid PluginId: rejected before any lookup.
        expect((yield* get(port, "/plugins/Demo/web/index.mjs")).status).toBe(400);
        expect((yield* get(port, "/plugins/de%20mo/web/index.mjs")).status).toBe(400);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a symlink inside web/ that escapes the plugin folder is not followed", () =>
    withServer((port) =>
      Effect.gen(function* () {
        const response = yield* get(port, "/plugins/demo/web/link.txt");
        expect(response.status).toBe(404);
        expect(response.body).not.toContain("escaped");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

// ru-code (V2-20/V2-21): the asset route is ROOT-AGNOSTIC, and this is the proof.
//
// `httpRoutes.ts` resolves every request against `host.resolvePluginDir(id)` and containment-checks
// against THAT directory, never against `<baseDir>/plugins` — so the second root cost it zero
// changes. A shipped plugin's `web/**` therefore has to be served straight out of the version
// payload, and an id present in BOTH roots has to serve the shipped bytes, because that is the copy
// that loaded. Asserted on the BYTES rather than on a status row: the browser fetches the file, and
// a route that agreed with `manifests.json` but served the other folder would be invisible to every
// other test in this file.
const SHIPPED_FIXTURE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  analytics: {
    "plugin.json": manifestJson("analytics", { web: "web/index.mjs" }),
    "web/index.mjs": "export const origin = 'shipped';\n",
    "assets/logo.png": "shipped-png",
    "secret.txt": "do not serve me either",
  },
};

/** The same server, but with a payload-shaped shipped root in front of the user's. */
const withShippedServer = <A, E>(
  userPlugins: Readonly<Record<string, Readonly<Record<string, string>>>>,
  run: (port: number) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-shipped-routes-" }),
    );
    const seed = (root: string, tree: Readonly<Record<string, Readonly<Record<string, string>>>>) =>
      Effect.gen(function* () {
        for (const [id, files] of Object.entries(tree)) {
          for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(root, id, rel);
            yield* fs.makeDirectory(path.dirname(abs), { recursive: true });
            yield* fs.writeFileString(abs, content);
          }
        }
      }).pipe(Effect.orDie);
    const shippedRoot = path.join(baseDir, "payload", "plugins");
    yield* seed(shippedRoot, SHIPPED_FIXTURE);
    yield* seed(path.join(baseDir, "plugins"), userPlugins);

    const context = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
        process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = shippedRoot;
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

    yield* Layer.launch(
      HttpRouter.serve(pluginAssetRoutes.pipe(Layer.provide(Layer.succeed(PluginHost, host)))),
    ).pipe(Effect.forkScoped);

    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      throw new Error("test http server has no port");
    }
    return yield* run(address.port);
  });

it.layer(NodeServices.layer)("plugin asset routes — shipped root (V2-21)", (it) => {
  it.effect("serves web/ and assets/ of a shipped plugin out of the payload", () =>
    withShippedServer({}, (port) =>
      Effect.gen(function* () {
        const entry = yield* get(port, "/plugins/analytics/web/index.mjs");
        expect(entry.status).toBe(200);
        expect(entry.body).toContain("origin = 'shipped'");
        expect((yield* get(port, "/plugins/analytics/assets/logo.png")).status).toBe(200);
        // The containment rules are per-root, so the same refusals hold inside the payload.
        expect((yield* get(port, "/plugins/analytics/secret.txt")).status).toBe(404);
        // The encoded form survives normalisation and reaches the handler for real (see the
        // traversal cases above); either refusal is correct, serving the file is not.
        for (const raw of [
          "/plugins/analytics/web/%2e%2e%2fsecret.txt",
          "/plugins/analytics/web/../secret.txt",
        ]) {
          const refused = yield* get(port, raw);
          expect([400, 404]).toContain(refused.status);
          expect(refused.body).not.toContain("do not serve me");
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("an id in both roots is served from the SHIPPED folder, byte for byte", () =>
    withShippedServer(
      {
        analytics: {
          "plugin.json": manifestJson("analytics", { web: "web/index.mjs" }),
          "web/index.mjs": "export const origin = 'user';\n",
        },
      },
      (port) =>
        Effect.gen(function* () {
          const entry = yield* get(port, "/plugins/analytics/web/index.mjs");
          expect(entry.status).toBe(200);
          expect(entry.body).toContain("origin = 'shipped'");
          expect(entry.body).not.toContain("origin = 'user'");
          // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the raw wire bytes, not a decoded DTO.
          const list = JSON.parse(
            (yield* get(port, "/plugins/manifests.json")).body,
          ) as ReadonlyArray<Record<string, unknown>>;
          expect(list.filter((row) => row["id"] === "analytics")).toHaveLength(1);
        }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // R5: `web/index.mjs` keeps its NAME across versions, and from now on its BYTES change on every
  // app update. The `no-cache` revalidation header stops being a nicety and becomes load-bearing.
  it.effect("a shipped plugin's web asset is revalidated, never cached by name", () =>
    withShippedServer({}, (port) =>
      Effect.gen(function* () {
        const response = yield* get(port, "/plugins/analytics/web/index.mjs");
        expect(response.headers["cache-control"]).toBe("no-cache");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
