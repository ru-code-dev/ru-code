// ru-code: wait for a freshly-spawned child to publish its pairing URL. Resolves
// to one of three outcomes so the launcher can print, retry, or report:
//   ready   — the child wrote its state with a pairing URL
//   exited  — the child died before becoming ready (e.g. EADDRINUSE race → retry)
//   timeout — still up after the budget; carries the plain origin as a fallback

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { READY_POLL_INTERVAL_MS, READY_TIMEOUT_MS } from "./constants.ts";
import { readRuntimeState } from "./runtimeState.ts";
import { isProcessAlive } from "./signal.ts";

export type ReadyOutcome =
  | { readonly _tag: "ready"; readonly url: string; readonly startedAt: string }
  | { readonly _tag: "exited" }
  | {
      readonly _tag: "timeout";
      readonly url: Option.Option<string>;
      readonly startedAt: Option.Option<string>;
    };

export const awaitDaemonReady = (params: {
  readonly statePath: string;
  readonly childPid: number;
  /** Override of the ready budget (tests only - production omits it). */
  readonly timeoutMs?: number;
}): Effect.Effect<ReadyOutcome> =>
  Effect.gen(function* () {
    const maxPolls = Math.ceil((params.timeoutMs ?? READY_TIMEOUT_MS) / READY_POLL_INTERVAL_MS);
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (!(yield* isProcessAlive(params.childPid))) {
        return { _tag: "exited" };
      }
      const state = yield* readRuntimeState(params.statePath);
      if (Option.isSome(state) && state.value.pid === params.childPid && state.value.pairingUrl) {
        return {
          _tag: "ready",
          url: state.value.pairingUrl,
          startedAt: state.value.startedAt,
        };
      }
      yield* Effect.sleep(Duration.millis(READY_POLL_INTERVAL_MS));
    }

    // Budget spent: succeed with the plain origin if the child is ours and up.
    const finalState = yield* readRuntimeState(params.statePath);
    const ours = Option.isSome(finalState) && finalState.value.pid === params.childPid;
    return {
      _tag: "timeout",
      url:
        ours && Option.isSome(finalState)
          ? Option.some(finalState.value.pairingUrl ?? finalState.value.origin)
          : Option.none<string>(),
      startedAt:
        ours && Option.isSome(finalState)
          ? Option.some(finalState.value.startedAt)
          : Option.none<string>(),
    };
  });
