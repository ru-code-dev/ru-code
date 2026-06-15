import type { HttpServerRequest } from "effect/unstable/http";

// Read a query-string parameter from the request URL. Returns null when absent.
// (Parses request.url directly — no Option dance — so both branches are testable.)
export const queryParam = (
  request: HttpServerRequest.HttpServerRequest,
  key: string,
): string | null => {
  const url = request.url;
  const queryStart = url.indexOf("?");
  const queryString = queryStart >= 0 ? url.slice(queryStart + 1) : "";
  return new URLSearchParams(queryString).get(key);
};
