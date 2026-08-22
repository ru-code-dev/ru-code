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
 * Can THIS process actually bind `host:port`? The question a port picker has to answer.
 *
 * `isPortInUse` asks a different one — "is anything accepting connections there" — and the two
 * disagree exactly where it hurts: a port with no listener that nevertheless cannot be bound (a
 * Windows excluded range, a reservation, a permission rule, another interface) reads as FREE. The
 * child then dies at bind, the launcher retries, and because the connect-probe is a pure function
 * of observable listeners it hands back the SAME dead port all three attempts. Binding and
 * releasing is the only probe whose success means what the caller needs it to mean.
 */
const canBindPort = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      server.close(() => resume(Effect.succeed(free)));
    };
    server.once("error", () => settle(false));
    server.once("listening", () => settle(true));
    server.listen(port, host);
    return Effect.sync(() => {
      settled = true;
      server.close();
    });
  });

/**
 * Prefer `desiredPort`; if it cannot be bound, probe upward for the first port that can.
 * `None` only if the whole window is occupied (pathological).
 *
 * There IS a race between releasing the probe socket and the child binding — unavoidable for any
 * out-of-process launcher, and the retry loop above exists for exactly that. What this removes is
 * the case the retry loop could never fix: a port that is free of listeners but impossible to bind.
 */
export const findFreePort = (
  host: string,
  desiredPort: number,
): Effect.Effect<Option.Option<number>> =>
  Effect.gen(function* () {
    for (let offset = 0; offset < PORT_PROBE_LIMIT; offset += 1) {
      const candidate = desiredPort + offset;
      if (yield* canBindPort(host, candidate)) {
        return Option.some(candidate);
      }
    }
    return Option.none();
  });
