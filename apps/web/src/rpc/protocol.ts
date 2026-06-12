import { WsRpcGroup } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  WS_RECONNECT_MAX_RETRIES,
} from "./wsConnectionState";
import { wsDebug } from "../ru-fork/debugging";

// ru-fork: connection-robustness restored from 8fc31793 (it was removed by
// c36945d8 "…+ cleanup"). The intentional-close flag lets the transport mark
// deliberate reconnect/dispose closes so they are NOT recorded as a disconnect
// (a deliberate close being misread re-triggered the retry and leaked a zombie
// socket). The telemetry/metadata that the cleanup also removed (connection
// label, version-mismatch hint, client tracing) is intentionally NOT restored.
export interface WsProtocolCloseContext {
  readonly intentional: boolean;
}

export interface WsProtocolLifecycleHandlers {
  readonly isActive?: () => boolean;
  readonly isCloseIntentional?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onHeartbeatPing?: () => void;
  readonly onHeartbeatPong?: () => void;
  readonly onHeartbeatTimeout?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: WsProtocolCloseContext,
  ) => void;
}

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

function formatSocketErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveWsRpcSocketUrl(rawUrl: string): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  // ru-fork: append /ws to whatever pathname the base URL carries
  // (the pathname holds the configured --base-url prefix). Overwriting
  // would drop the prefix and the upgrade would land on a bare /ws —
  // 404 under a sub-path deployment.
  const trimmed = resolved.pathname.replace(/\/+$/, "");
  resolved.pathname = `${trimmed}/ws`;
  return resolved.toString();
}

type ComposedWsProtocolLifecycleHandlers = Required<
  Pick<WsProtocolLifecycleHandlers, "isActive" | "onAttempt" | "onOpen" | "onError" | "onClose">
>;

function defaultLifecycleHandlers(): ComposedWsProtocolLifecycleHandlers {
  return {
    isActive: () => true,
    onAttempt: recordWsConnectionAttempt,
    onOpen: recordWsConnectionOpened,
    onError: (message) => {
      clearAllTrackedRpcRequests();
      recordWsConnectionErrored(message);
    },
    onClose: (details, context) => {
      clearAllTrackedRpcRequests();
      // ru-fork: a deliberate close (reconnect/dispose) is not a disconnect —
      // don't record it (else it feeds the retry and leaves a zombie socket).
      if (context.intentional) {
        return;
      }
      recordWsConnectionClosed(details);
    },
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  const defaults = defaultLifecycleHandlers();
  const isActive = handlers?.isActive ?? (() => true);

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      defaults.onOpen();
      handlers?.onOpen?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      defaults.onClose(details, context);
      handlers?.onClose?.(details, context);
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
) {
  const lifecycle = composeLifecycleHandlers(handlers);
  const resolvedUrl =
    typeof url === "function"
      ? Effect.promise(() => url()).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl)),
          Effect.tapError((error) =>
            Effect.sync(() => {
              lifecycle.onError(formatSocketErrorMessage(error));
            }),
          ),
          Effect.orDie,
        )
      : resolveWsRpcSocketUrl(url);

  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      wsDebug("ws attempt", { socketUrl });
      lifecycle.onAttempt(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);

      socket.addEventListener(
        "open",
        () => {
          wsDebug("ws open", { socketUrl });
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          wsDebug("ws error", { socketUrl });
          lifecycle.onError("Unable to connect to the T3 server WebSocket.");
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          const intentional = handlers?.isCloseIntentional?.() ?? false;
          wsDebug("ws close", { code: event.code, reason: event.reason, intentional });
          lifecycle.onClose(
            {
              code: event.code,
              reason: event.reason,
            },
            {
              intentional,
            },
          );
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const retryPolicy = Schedule.addDelay(Schedule.recurs(WS_RECONNECT_MAX_RETRIES), (retryCount) =>
    Effect.succeed(Duration.millis(getWsReconnectDelayMsForRetry(retryCount) ?? 0)),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: true,
      }),
      (protocol) => ({
        ...protocol,
        run: (clientId, writeResponse) =>
          protocol.run(clientId, (response) => {
            if (response._tag === "Chunk" || response._tag === "Exit") {
              wsDebug("rpc ←", { tag: response._tag, requestId: response.requestId });
              acknowledgeRpcRequest(response.requestId);
            } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              wsDebug("rpc ← error", { tag: response._tag });
              clearAllTrackedRpcRequests();
            }
            return writeResponse(response);
          }),
        send: (clientId, request, transferables) => {
          if (request._tag === "Request") {
            wsDebug("rpc →", { id: request.id, tag: request.tag });
            trackRpcRequestSent(request.id, request.tag);
          }
          return protocol.send(clientId, request, transferables);
        },
      }),
    ),
  );
  // ru-fork: heartbeat hooks restored from 8fc31793. The RPC client pings the
  // server every ~5s; on a missed pong it fires onPingTimeout. We surface
  // ping/pong so the transport can track heartbeat freshness (used to skip
  // needless reconnects) and clear in-flight requests on a real timeout.
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      onDisconnect: Effect.void,
      onPing: Effect.sync(() => {
        wsDebug("hb ping", { active: lifecycle.isActive() });
        if (lifecycle.isActive()) {
          handlers?.onHeartbeatPing?.();
        }
      }),
      onPong: Effect.sync(() => {
        wsDebug("hb pong", { active: lifecycle.isActive() });
        if (lifecycle.isActive()) {
          handlers?.onHeartbeatPong?.();
        }
      }),
      onPingTimeout: Effect.sync(() => {
        wsDebug("hb TIMEOUT", { active: lifecycle.isActive() });
        if (lifecycle.isActive()) {
          clearAllTrackedRpcRequests();
          recordWsConnectionErrored("WebSocket heartbeat timed out.");
          handlers?.onHeartbeatTimeout?.();
        }
      }),
    }),
  );

  return protocolLayer.pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
  );
}
