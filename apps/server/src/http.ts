import Mime from "@effect/platform-node/Mime";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse, HttpServerRequest } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
// ru-fork: route registration through `prefixedRouteLayer` so every
// HTTP route is mounted under the configured `--base-url` prefix at
// layer-build time. With an empty prefix this is a no-op.
import { prefixedRouteLayer } from "./ru-fork/basePath/basePath.ts";
import {
  rewriteIndexHtmlForBasePath,
  rewriteWebmanifestForBasePath,
} from "./ru-fork/basePath/htmlRewrite.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { readRemoteAddressFromSource } from "./auth/utils.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { runFastShutdownCleanup } from "./fastShutdown.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";
import { resolveStartupBrowserTarget } from "./startupAccess.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

class LoopbackOnlyError extends Data.TaggedError("LoopbackOnlyError")<{}> {}

const requireLoopbackRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const remoteAddress = readRemoteAddressFromSource(request.source);
  if (!remoteAddress || !isLoopbackHostname(remoteAddress)) {
    return yield* new LoopbackOnlyError();
  }
});

const respondToLoopbackOnlyError = (_error: LoopbackOnlyError) =>
  Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 }));

export const serverEnvironmentRouteLayer = prefixedRouteLayer(
  "GET",
  "/.well-known/t3/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }),
);

export const healthRouteLayer = prefixedRouteLayer(
  "GET",
  "/health",
  Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })),
);

// Small grace delay so the 200 response flushes to the wire before the
// HttpServer/route layer is torn down by the shutdown chain. Without it the
// route handler can return, the runtime sees the signal, interrupts the
// launch fiber, and closes the socket before the response reaches the client.
const SHUTDOWN_RESPONSE_FLUSH_DELAY = Duration.millis(50);

class PairingStartupError extends Data.TaggedError("PairingStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Loopback-only endpoint so the daemon launcher can fetch the same browser
// target the foreground startup would auto-open: in desktop mode a bare URL,
// in web mode the pairing URL with a one-time token. Mirrors the /shutdown
// pattern (loopback gate, no bearer auth required).
export const pairingStartupRouteLayer = prefixedRouteLayer(
  "POST",
  "/pair/startup",
  Effect.gen(function* () {
    yield* requireLoopbackRequest;
    const url = yield* resolveStartupBrowserTarget.pipe(
      Effect.mapError(
        (cause) =>
          new PairingStartupError({
            message: "Failed to issue startup pairing URL.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe({ url }, { status: 200 });
  }).pipe(
    Effect.catchTag("LoopbackOnlyError", respondToLoopbackOnlyError),
    Effect.catchTag("PairingStartupError", (error) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 })),
    ),
  ),
);

export const shutdownRouteLayer = prefixedRouteLayer(
  "POST",
  "/shutdown",
  Effect.gen(function* () {
    yield* requireLoopbackRequest;
    // Fast-exit. We deliberately skip the Effect Layer finalizer chain
    // (NodeHttpServer graceful close 20s default + sqlite + reactors +
    // adapters) — empirically that chain held the node process for ~2
    // minutes even after CLI children were SIGKILLed. The shared
    // cleanup in `fastShutdown.ts` does the hot work (kill children,
    // clear state file); SQLite WAL is engineered to survive process
    // exit, so we lose only uncommitted in-flight transactions.
    yield* runFastShutdownCleanup;
    yield* Effect.logInfo("shutdown requested via /shutdown — exiting");
    // `forkDetach` so the 200 response flushes before we exit.
    // `Effect.fork` would tie this to the request fiber and get
    // interrupted before the delay elapses.
    yield* Effect.forkDetach(
      Effect.delay(
        Effect.sync(() => process.exit(0)),
        SHUTDOWN_RESPONSE_FLUSH_DELAY,
      ),
    );
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("LoopbackOnlyError", respondToLoopbackOnlyError)),
);

export const attachmentsRouteLayer = prefixedRouteLayer(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    // ru-fork: when a --base-url prefix is configured the route is
    // registered under it; strip the prefix before slicing the attachments
    // route prefix off so the relative path matches the on-disk layout.
    const pathnameInsideBase =
      config.basePath.length > 0 && url.value.pathname.startsWith(config.basePath)
        ? url.value.pathname.slice(config.basePath.length)
        : url.value.pathname;
    const rawRelativePath = pathnameInsideBase.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = prefixedRouteLayer(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    // ru-fork: the catch-all stays registered at "*" (no prefixing on
    // the pattern itself — that would miss "/<basePath>" without a
    // trailing slash). Inside the handler we gate on basePath manually
    // and slice it off before resolving the static file.
    let effectivePathname = url.value.pathname;
    if (config.basePath.length > 0) {
      if (effectivePathname === config.basePath || effectivePathname === `${config.basePath}/`) {
        effectivePathname = "/";
      } else if (effectivePathname.startsWith(`${config.basePath}/`)) {
        effectivePathname = effectivePathname.slice(config.basePath.length);
      } else {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = effectivePathname === "/" ? "/index.html" : effectivePathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      // ru-fork: SPA fallback — inject runtime config + (when a
      // base-path is configured) prepend it to every absolute asset URL.
      return HttpServerResponse.uint8Array(
        rewriteIndexHtmlForBasePath(indexData, config.basePath),
        {
          status: 200,
          contentType: "text/html; charset=utf-8",
        },
      );
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    // ru-fork: the explicit /index.html request and PWA webmanifests
    // need the same rewriting as the SPA fallback above.
    if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
      return HttpServerResponse.uint8Array(rewriteIndexHtmlForBasePath(data, config.basePath), {
        status: 200,
        contentType,
      });
    }
    if (filePath.endsWith(".webmanifest")) {
      return HttpServerResponse.uint8Array(rewriteWebmanifestForBasePath(data, config.basePath), {
        status: 200,
        contentType,
      });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
