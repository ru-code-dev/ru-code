import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as NetService from "@t3tools/shared/Net";

import { DESKTOP_LOOPBACK_HOST, PORT_IN_USE_ERROR_RU } from "./defaults.ts";

// ru-fork: structural exit signal for the desktop-mode port pre-flight.
// Mirrors PreflightFailedError in ru-fork/startup/preflight.ts — the
// Russian text is logged via Effect.logError; this tagged error is what
// signals Command.run to exit non-zero. Keeping the message off the error
// payload (it's already on the logger) means re-running the helper in tests
// produces no duplicate output.
export class PortInUseError extends Data.TaggedError("PortInUseError")<{
  readonly port: number;
}> {}

// ru-fork: pre-flight desktop-mode port collision check. Probes the
// exact address the real HTTP server will bind to (DESKTOP_LOOPBACK_HOST),
// so the probe cannot diverge from the bind by construction. Reuses the
// existing NetService.canListenOnHost helper (packages/shared/src/Net.ts).
// Deliberately NOT using isPortAvailableOnLoopback because that probes
// both IPv4 and IPv6 — we bind IPv4 only, so probing IPv6 would risk a
// false positive on hosts where ::1 listen fails for any non-EADDRNOTAVAIL
// reason.
//
// Mirrors ru-fork/startup/preflight.ts: log the Russian failure via
// Effect.logError, then `return yield* new PortInUseError(...)` as the
// definitive exit. Command.run renders the failure cleanly and exits
// non-zero — no console.error, no process.exit, no NodeRuntime framing
// to fight.
export const assertLocalPortAvailable = (port: number) =>
  Effect.gen(function* () {
    const { canListenOnHost } = yield* NetService.NetService;
    const available = yield* canListenOnHost(port, DESKTOP_LOOPBACK_HOST);
    if (!available) {
      yield* Effect.logError(PORT_IN_USE_ERROR_RU(port));
      return yield* new PortInUseError({ port });
    }
    return port;
  });
