// ru-code: dispatcher for `CliErrorDecision`. Routes a classified
// decision to one of the three UI surfaces (B / T / T+N) or silently,
// runs `killAcp` if requested, ends the turn per the surface's
// implicit rules + the `endTurn` flag.
//
// The dispatcher is **closure-injected**: each catch site builds a
// `CliErrorDispatchEnv` carrying its capabilities (kill function,
// activity-kind, turnId, etc.) and passes it in. Lets one dispatcher
// serve all four call sites without depending on any specific layer.
//
// **B-surface is NOT handled here.** It only makes sense inside the
// prompt RPC scope at `CliAdapter.ts:1359`, where the catch can emit
// a `content.delta` and return `{ stopReason: "end_turn" }` as the
// prompt response. Site #1 short-circuits to that path before calling
// `dispatch`. The dispatcher's `case "B"` is a no-op (logs nothing
// extra; the per-decision `[runtime]` breadcrumb has already fired).

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { CliErrorDecision } from "./types.ts";
import { Surface, surfaceLabel } from "./types.ts";
import { describeRequestFailure } from "./requestLogFormat.ts";

/**
 * Capabilities each catch site must provide to the dispatcher.
 *
 * The dispatcher is generic over the error type `E`: callers' capability
 * effects can carry any tagged error type (orchestration dispatches,
 * persistence ops, etc.). The dispatcher's own error channel becomes
 * the same `E`; the outer guard (`recoverTurnStartFailure` or
 * equivalent) is responsible for swallowing those at the call-site
 * boundary.
 *
 * `R` is the requirements channel. Most call sites already have all
 * services in scope and pass closures that resolve to `R = never`, so
 * this defaults; carry it through as a type parameter to keep the
 * dispatcher service-agnostic.
 */
export interface CliErrorDispatchEnv<E, R = never> {
  /**
   * Force-kill the CLI child process. Called when `decision.killAcp`
   * is true. Set to `undefined` at sites that don't have a session to
   * kill (the dispatcher skips kill silently in that case).
   */
  readonly killAcp: Effect.Effect<void, E, R> | undefined;

  /** Append a `tone: "error"` activity entry to the timeline. */
  readonly appendActivity: (detail: string) => Effect.Effect<void, E, R>;

  /** Set `session.lastError` (red notification). Used for T+N only. */
  readonly setLastError: (detail: string) => Effect.Effect<void, E, R>;

  /**
   * Clear `session.activeTurnId` so the "Working" timer stops. Called
   * when `decision.endTurn === true` on T or silent surfaces; on T+N
   * the lastError dispatch already clears the turn so this is unused.
   */
  readonly endTurn: Effect.Effect<void, E, R>;
}

/**
 * Shared `[runtime]` triage breadcrumb fields, identical across every classify
 * site (B-inline at the adapter, the turn finalizer, this dispatcher): `code` =
 * recognizer id, `surface` = B/T/T+N (or "silent"), `info` = the stack-free
 * failure description. Call sites add their own context (`source`, `where`,
 * `threadId`) alongside, then log under the fixed `[runtime]` tag.
 */
export const cliErrorFields = (
  decision: CliErrorDecision,
  info: Record<string, unknown>,
): Record<string, unknown> => ({
  code: decision.id,
  surface: surfaceLabel(decision),
  info,
});

/**
 * Apply a decision. Emits one `[runtime]` `logError` breadcrumb then does
 * surface-specific routing.
 *
 * @param decision       the classifier output (or `UNRECOGNIZED_DECISION`).
 * @param failureFields  log fields describing the failure (code/message/details
 *                       or a stack-free message chain) — see `describeRequestFailure`.
 * @param env            capabilities for the current catch site.
 */
export const dispatch = <E, R = never>(
  decision: CliErrorDecision,
  failureFields: Record<string, unknown>,
  env: CliErrorDispatchEnv<E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* Effect.logError("[runtime]", {
      source: "cli",
      where: "pre-turn",
      ...cliErrorFields(decision, failureFields),
    });

    if (decision.killAcp === true && env.killAcp !== undefined) {
      yield* env.killAcp;
    }

    if (decision.surface === undefined) {
      // Silent: no UI dispatch. `endTurn` still respected.
      if (decision.endTurn === true) yield* env.endTurn;
      return;
    }

    const surfaces = decision.surface;

    // Bubble only makes sense inside the prompt RPC scope (site #1 emits the
    // `content.delta` there before reaching the dispatcher). A Bubble decision
    // arriving at a non-prompt catch site cannot emit a bubble here, so it is
    // surfaced on the timeline instead (below) and logged loudly.
    if (surfaces.includes(Surface.Bubble)) {
      yield* Effect.logError(`[cli-error.${decision.id}.b-surface-outside-prompt]`, {
        hint: "Bubble-surface decision dispatched at a non-prompt catch site. Falling back to timeline.",
      });
    }

    // Notification → red banner (`session.lastError`).
    if (surfaces.includes(Surface.Notification)) {
      yield* env.setLastError(decision.text);
    }

    // Timeline (or a stray Bubble handled here) → tone:"error" work-log row.
    if (surfaces.includes(Surface.Timeline) || surfaces.includes(Surface.Bubble)) {
      yield* env.appendActivity(decision.text);
    }

    // On a Notification surface the setLastError dispatch already ends the turn
    // (coupled write of lastError + activeTurnId); otherwise honor endTurn.
    if (!surfaces.includes(Surface.Notification) && decision.endTurn === true) {
      yield* env.endTurn;
    }
  });

/**
 * Convenience: derive the stack-free log fields from a `Cause` and
 * `dispatch`. Most catch sites have a `Cause` in hand, not the unwrapped
 * error/cause pair the classifier wants.
 */
export const dispatchCause = <E, R = never>(
  decision: CliErrorDecision,
  cause: Cause.Cause<unknown>,
  env: CliErrorDispatchEnv<E, R>,
): Effect.Effect<void, E, R> => dispatch(decision, describeRequestFailure(cause), env);
