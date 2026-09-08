/**
 * ru-code: the only way plugin bytes reach the browser.
 *
 * Three endpoints under `/plugins/`, registered BEFORE the `GET *` static
 * catch-all in `server.ts` `makeRoutesLayer`:
 *
 *  - `GET /plugins/manifests.json`   — what the web bootstrap reads at startup to
 *    know which plugins exist and which of them actually loaded. `no-store`: the
 *    set of plugins changes when the user copies or deletes a folder, and a
 *    cached list would show a plugin that is gone (or hide one just added).
 *  - `GET /plugins/host-modules.json` — the D13 contract, verbatim, for runtime
 *    introspection (mvp-plan §1.2): which shared modules a plugin may import by
 *    name and at which version the host guarantees them.
 *  - `GET /plugins/<id>/web/…` and `/plugins/<id>/assets/…` — the plugin's own
 *    files. `no-cache`, because "copy the folder, restart" must show new code.
 *
 * WHY the containment work is repeated here. This route turns a URL supplied by
 * a browser into a filesystem read, which is the classic traversal surface; the
 * checks are copied from `staticAndDevRouteLayer` (`http.ts:265-292`) — raw `..`,
 * normalised `..`, NUL, absolute, resolved-path-within-root — and then tightened
 * for the plugin case:
 *
 *  - percent-encoding is DECODED first, so `%2e%2e%2f` is caught by the same
 *    checks as a literal `..` (the static route can skip this because it never
 *    decodes, and a literal `%2e%2e` filename simply does not exist);
 *  - `<id>` must match `PluginId` AND be a plugin whose manifest this host
 *    accepted, so an id can never be turned into an arbitrary directory;
 *  - only `web/` and `assets/` are servable. `server/**` is the plugin's SERVER
 *    code — shipping it to a browser leaks whatever the author put in it — and
 *    `plugin.json` is host metadata that is already exposed, filtered, through
 *    `manifests.json`. Everything else in the folder is 404;
 *  - the resolved file's `realPath` must still be inside the plugin folder, so a
 *    symlink dropped inside `web/` cannot read the rest of the disk.
 *
 * @module ru-code/plugins/httpRoutes
 */
import Mime from "@effect/platform-node/Mime";
import { HOST_PROVIDED_MODULES, PLUGIN_ID_PATTERN } from "@smart-tools/plugin-sdk/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { PluginHost, PluginHostLayer } from "./PluginHost.ts";

/**
 * URL prefix owned by the plugin system.
 *
 * ru-code (A5, A4 findings L4 + L7) — two decisions recorded so they are not
 * re-litigated as accidents:
 *
 *  - **L4, the namespace stays `/plugins/*`.** It is claimed before the SPA
 *    catch-all, so no in-app page can ever deep-link under `/plugins/...`. That
 *    is intentional: a future Plugins settings page lives under
 *    `/settings/plugins` (where every other settings surface already lives), so
 *    the two never collide and the asset URL a plugin bundle embeds stays short.
 *  - **L7, CORS.** `browserApiCorsLayer` (`http.ts`, applied globally in
 *    `server.ts` `makeRoutesLayer`) puts `access-control-allow-origin: *` on
 *    these responses, so any origin can read `manifests.json` and plugin JS/CSS.
 *    This is the app's PRE-EXISTING posture for `/assets/*` and was not
 *    introduced with the plugin system; plugin code is client-side code that the
 *    same browser downloads anyway, and nothing under `/plugins/` is
 *    session-scoped or authorized. Narrowing CORS is an app-wide change, not a
 *    plugin-local one.
 */
export const PLUGIN_ROUTE_PREFIX = "/plugins";

/** The manifest list the web bootstrap fetches. */
export const PLUGIN_MANIFESTS_PATH = `${PLUGIN_ROUTE_PREFIX}/manifests.json`;

/** The D13 host-provided module contract, for runtime introspection. */
export const PLUGIN_HOST_MODULES_PATH = `${PLUGIN_ROUTE_PREFIX}/host-modules.json`;

/** The only two folders inside a plugin that may be served over HTTP. */
export const PLUGIN_SERVABLE_DIRS = ["web", "assets"] as const;

const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Headers for one served plugin file.
 *
 * `no-cache` (revalidate, do not reuse blindly) rather than the app assets'
 * `max-age=3600`: plugin files are not content-hashed — `web/index.mjs` keeps its
 * name across versions, so a cached copy would survive a plugin update.
 */
export const pluginAssetResponseHeaders = (filePath: string): Record<string, string> => ({
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  ...(filePath.toLowerCase().endsWith(".svg")
    ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
    : {}),
});

/** `candidate` is `root` itself or lives beneath it. */
const isWithinRoot = (path: Path.Path, root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

const hasParentSegment = (value: string): boolean =>
  value.split(/[/\\]+/).some((segment) => segment === "..");

/** `decodeURIComponent` on a malformed escape throws; a bad URL is a 400, not a 500. */
const decodePath = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const badRequest = HttpServerResponse.text("Bad Request", { status: 400 });
const notFound = HttpServerResponse.text("Not Found", { status: 404 });

const jsonNoStore = (body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, {
    status: 200,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

/**
 * The route handler, closed over the ONE host instance.
 *
 * Built through `Layer.unwrap` (the `browserApiCorsLayer` shape in `http.ts`) so
 * `PluginHost` is resolved once when the layer is built, not per request: an
 * `Effect.provide` inside the handler would construct a fresh host — with an
 * empty status table — on every single request.
 */
const makeHandler = (host: PluginHost["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return badRequest;

    const pathname = url.value.pathname;
    if (!pathname.startsWith(`${PLUGIN_ROUTE_PREFIX}/`)) return notFound;
    const rawSuffix = pathname.slice(`${PLUGIN_ROUTE_PREFIX}/`.length);

    if (rawSuffix === "manifests.json") {
      return jsonNoStore(yield* host.manifestsForWeb);
    }
    if (rawSuffix === "host-modules.json") {
      return jsonNoStore(HOST_PROVIDED_MODULES);
    }

    // Decode BEFORE validating: `%2e%2e/` and `..` must fail the same checks.
    const suffix = decodePath(rawSuffix);
    if (suffix === null) return badRequest;
    if (rawSuffix.includes("\0") || suffix.includes("\0")) return badRequest;
    // ru-code (A5, A4 finding L2): over a REAL socket a raw `..` never reaches
    // this line — `HttpServerRequest.toURL` normalises the path first, so
    // `/plugins/x/web/../../../../etc/passwd` becomes a path that fails the
    // prefix check above and answers 404 instead of the 400 this branch would
    // give. The unit tests see 400 because they speak raw `node:http` to the
    // router and bypass that normalisation. Both outcomes refuse the request, so
    // this is a status-code nuance, not a hole — do NOT "fix" the tests to expect
    // 404, and do NOT delete this check: the ENCODED form (`%2e%2e`) survives
    // normalisation and lands here for real.
    if (hasParentSegment(rawSuffix) || hasParentSegment(suffix)) return badRequest;
    if (suffix.startsWith("/") || suffix.startsWith("\\") || /^[a-zA-Z]:/.test(suffix)) {
      return badRequest;
    }

    const segments = suffix.split("/");
    const pluginId = segments[0] ?? "";
    const kind = segments[1] ?? "";
    const rest = segments.slice(2);
    if (!PLUGIN_ID_PATTERN.test(pluginId)) return badRequest;
    if (!(PLUGIN_SERVABLE_DIRS as ReadonlyArray<string>).includes(kind)) return notFound;
    if (rest.length === 0 || rest.some((segment) => segment.length === 0)) return notFound;

    const pluginDir = yield* host.resolvePluginDir(pluginId);
    if (pluginDir === undefined) return notFound;

    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const root = path.resolve(pluginDir);
    const servableRoot = path.resolve(root, kind);
    const filePath = path.resolve(servableRoot, path.normalize(rest.join("/")));
    if (!isWithinRoot(path, servableRoot, filePath) || !isWithinRoot(path, root, filePath)) {
      return badRequest;
    }

    const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (stat === null || stat.type !== "File") return notFound;

    // A symlink inside `web/` resolves elsewhere without any `..` in the URL.
    const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.orElseSucceed(() => null));
    if (realPath === null || !isWithinRoot(path, root, realPath)) return notFound;

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: pluginAssetResponseHeaders(filePath),
      contentType: Mime.getType(filePath) ?? "application/octet-stream",
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  });

/**
 * `GET /plugins/*`, taking the host from the ambient context.
 *
 * Split out from the wired layer below so a test can serve these routes against
 * a host it started itself. `Layer.unwrap` resolves the host ONCE at layer-build
 * time — see `makeHandler`.
 */
export const pluginAssetRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* PluginHost;
    return HttpRouter.add("GET", `${PLUGIN_ROUTE_PREFIX}/*`, makeHandler(host));
  }),
);

/** The wired route: same routes, with the module-level host layer supplied. */
export const pluginAssetRouteLayer = pluginAssetRoutes.pipe(Layer.provide(PluginHostLayer));
