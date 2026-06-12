// ru-fork: log terminal open()/restart() failures to the server at ERROR level.
//
// Upstream's RPC observability wrapper (`observeRpcEffect` in `ws.ts`) was
// stripped to a no-op when telemetry was removed, so a failed terminal open was
// logged NOWHERE — the real reason (bad cwd, unreadable history, a defect) was
// invisible on the server while the UI showed a generic "Failed to open
// terminal". This pipe-able transform taps the failure cause, logs the real
// reason once, and RE-RAISES it unchanged — the typed `TerminalError` still
// propagates, so every caller (the run-a-command callers, the RPC handler, the
// drawer) keeps its existing error handling. A cancelled request
// (interrupt-only cause) is not logged as an error.

import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const logTerminalStartFailure =
  (input: {
    readonly threadId: string;
    readonly terminalId?: string | undefined;
    readonly cwd: string;
  }) =>
  <A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    work.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("terminal start failed", {
              threadId: input.threadId,
              terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
              cwd: input.cwd,
              cause: Cause.pretty(cause),
            }),
      ),
    );
