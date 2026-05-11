import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy.ts";
import { resolveSessionCookieName } from "../utils.ts";
import { isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);

  const policy =
    config.mode === "desktop"
      ? isRemoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : isRemoteReachable
        ? "remote-reachable"
        : "loopback-browser";

  // desktop-managed-local: server is loopback-bound in desktop mode, so the
  // OS user is the trust boundary. Auth gate auto-issues a session for any
  // loopback request (see ServerAuth.ts), so no bootstrap surface is needed.
  // An empty list signals to the client that the pair screen should not
  // render at all.
  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? []
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
    }),
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
