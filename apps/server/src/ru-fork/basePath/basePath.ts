// ru-fork: base-path support — single source of truth so http.ts,
// auth/http.ts, orchestration/http.ts, and ws.ts share the same
// prefixing logic. The CLI flag `--base-url` (and env
// RU_FORK_BASE_URL) feeds `ServerConfig.basePath`; every route
// registered via `prefixedRouteLayer` ends up under that prefix at
// layer-build time. With an empty basePath the helpers short-circuit
// and the runtime path is byte-for-byte identical to today.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";

export const BASE_PATH_ENV = "RU_FORK_BASE_URL";

export const normalizeBasePath = (raw: string | undefined): string => {
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  let value = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      // not a parseable URL — treat as a raw path
    }
  }
  if (!value.startsWith("/")) value = `/${value}`;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value === "/" ? "" : value;
};

export const joinBasePath = (basePath: string, route: string): string => {
  if (basePath.length === 0) return route;
  if (route.length === 0) return basePath;
  if (route === "/") return basePath;
  return route.startsWith("/") ? `${basePath}${route}` : `${basePath}/${route}`;
};

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";

// `HttpRouter.add` accepts a literal path string and returns a Layer.
// We need the path computed from `ServerConfig.basePath` (a runtime
// value), so wrap the registration in `Layer.unwrap` — runs once at
// layer-build time, captures the handler exactly like the literal
// form would.
export const prefixedRouteLayer = <E, R>(
  method: HttpMethod,
  route: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      // Cast: the path type is a template-literal `PathInput`, but the
      // runtime accepts any string. Localized to this one helper.
      return HttpRouter.add(method, joinBasePath(config.basePath, route) as never, handler);
    }),
  );
