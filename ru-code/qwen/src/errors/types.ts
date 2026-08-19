// ru-code: shared error-decision type model for the qwen cli-error classifier.
//
// The recognizer TABLE (`recognizers.ts`) lives in the server app because it
// binds to the app's `ProviderAdapter*` error classes (the core provider error
// contract, which cannot move into a provider package). But the decision TYPE
// MODEL — the surfaces a classified error routes to, and the discriminated
// decision shape — is provider-agnostic, so it lives here and is shared by both
// the table (app) and the dispatcher (`dispatch.ts`, this package).
//
// ## Surfaces are a composable SET
// A classified error can show on any combination of the three UI surfaces. Each
// surface has its own independent native runtime event (see the adapter):
//   - `Bubble`        → `content.delta` (an assistant-message bubble + end_turn)
//   - `Timeline`      → `task.completed{status:"failed", summary}` (a tone:"error"
//                        work-log row carrying the exact classified text)
//   - `Notification`  → `turn.completed{showNotification:true}` (the red banner)
// so any subset renders. The current catalog only uses `[Bubble]`, `[Timeline]`,
// and `[Timeline, Notification]`, but the type permits any combination (e.g.
// `[Bubble, Timeline]`) — the adapter emits one native event per member.
//
// `CliErrorDecision` is a discriminated union so that `text` is required iff a
// `surface` set is present: recognizer authors cannot ship a "surface but no
// text" decision (compile error). Silent decisions omit both `surface` and
// `text` and carry only an id plus the independent flags (`killAcp`, `endTurn`).

export const Surface = {
  Bubble: "Bubble",
  Timeline: "Timeline",
  Notification: "Notification",
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

interface CliErrorDecisionBase {
  readonly id: string;
  readonly killAcp?: boolean;
  readonly endTurn?: boolean;
}

export type CliErrorDecision =
  | (CliErrorDecisionBase & {
      readonly surface?: undefined;
      readonly text?: undefined;
    })
  | (CliErrorDecisionBase & {
      readonly surface: readonly Surface[];
      readonly text: string;
    });

/** True iff the decision routes to the given surface. */
export const hasSurface = (decision: CliErrorDecision, surface: Surface): boolean =>
  decision.surface !== undefined && decision.surface.includes(surface);

/** Readable breadcrumb rendering of a decision's surface set (or "silent"). */
export const surfaceLabel = (decision: CliErrorDecision): string =>
  decision.surface === undefined || decision.surface.length === 0
    ? "silent"
    : decision.surface.join("+");
