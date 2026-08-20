// @effect-diagnostics nodeBuiltinImport:off
// ru-code: TCP reachability + free-port discovery, on node:net directly (a raw
// probe has no Effect abstraction). Used to decide reuse/reclaim/fallback and to
// pick the child's port.

import * as NodeNet from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PORT_PROBE_LIMIT } from "./constants.ts";

const PROBE_TIMEOUT = Duration.toMillis(Duration.seconds(1));

/** True if something is already accepting connections on `host:port`. */
export const isPortInUse = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    const settle = (inUse: boolean) => {
      socket.destroy();
      resume(Effect.succeed(inUse));
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(PROBE_TIMEOUT, () => settle(false));
    return Effect.sync(() => socket.destroy());
  });

/**
 * Prefer `desiredPort`; if it's taken, probe upward for the first free port.
 * `None` only if the whole window is occupied (pathological).
 */
export const findFreePort = (
  host: string,
  desiredPort: number,
): Effect.Effect<Option.Option<number>> =>
  Effect.gen(function* () {
    for (let offset = 0; offset < PORT_PROBE_LIMIT; offset += 1) {
      const candidate = desiredPort + offset;
      if (!(yield* isPortInUse(host, candidate))) {
        return Option.some(candidate);
      }
    }
    return Option.none();
  });
