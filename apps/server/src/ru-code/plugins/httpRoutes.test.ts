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
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as ServerConfig from "../../config.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { PluginHost, PluginHostLayer } from "./PluginHost.ts";
import { pluginAssetRoutes } from "./httpRoutes.ts";

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
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, ...overrides });

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

  it.effect("host-modules.json serves the D13 contract", () =>
    withServer((port) =>
      Effect.gen(function* () {
        const response = yield* get(port, "/plugins/host-modules.json");
        expect(response.status).toBe(200);
        // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the raw wire bytes, not a decoded DTO.
        const modules = JSON.parse(response.body) as ReadonlyArray<{ specifier: string }>;
        expect(modules.map((entry) => entry.specifier)).toContain("react");
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
