// ru-code: A2 — the WS upgrade auth-reject log line.
//
// A WebSocket upgrade rejected for an auth reason used to be COMPLETELY silent
// on the server (the pin suite's A2 finding): the client shows a cycling
// reconnect banner while the server says nothing, which made the field
// reconnect loop nearly undiagnosable. One logError at the reject point names
// the machine-readable reason and the request shape.
//
// NEVER logs the presented credential/ticket value — only whether one was
// present.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

// Mirrors EnvironmentAuth's private WEBSOCKET_TICKET_QUERY_PARAM ("wsTicket",
// EnvironmentAuth.ts:501). Diagnostics-only: if upstream ever renames the
// param, this line reports ticketPresented=false — the reject reason stays
// correct either way.
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

const readPeerAddress = (source: unknown): string | undefined => {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  return candidate.socket?.remoteAddress ?? candidate.remoteAddress ?? undefined;
};

export const logWebSocketUpgradeAuthReject = (
  request: HttpServerRequest.HttpServerRequest,
  error: EnvironmentAuth.ServerAuthCredentialError,
): Effect.Effect<void> => {
  const requestUrl = HttpServerRequest.toURL(request);
  const ticketPresented = Option.isSome(requestUrl)
    ? requestUrl.value.searchParams.has(WEBSOCKET_TICKET_QUERY_PARAM)
    : false;
  return Effect.logError("websocket upgrade auth rejected", {
    errorTag: error._tag,
    reason: EnvironmentAuth.serverAuthCredentialReason(error),
    ticketPresented,
    remoteAddress: readPeerAddress(request.source) ?? "unknown",
  });
};
