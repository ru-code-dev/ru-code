// ru-code: the ONE place that distills a derived `AutoUpdateUiState` snapshot into
// the pure notify signals, so the sidebar pill and the app-root driver read
// byte-identical facts and can never disagree about what to show.

import type { AutoUpdateUiState, GitSourceView, WebSourceView } from "../model";
import type { ProblemSignal, ReleaseSignal, SourceSignal } from "./notifyDecision";

/** A live server-owned run (run present and not terminally failed). */
export function isRunActive(state: AutoUpdateUiState): boolean {
  return state.run !== null && state.run.phase !== "failed";
}

/** The run is in its restart window — the server is being replaced right now. */
export function isRunRestarting(state: AutoUpdateUiState): boolean {
  return state.run !== null && state.run.phase === "restart";
}

export function toReleaseSignal(state: AutoUpdateUiState): ReleaseSignal {
  return {
    available: state.release !== null,
    version: state.release?.version ?? null,
    muted: state.notify.releasesMuted,
    stamp: state.notified.release,
  };
}

function toSourceSignal(source: GitSourceView | WebSourceView): SourceSignal {
  return {
    offered: source.offered,
    enabled: source.enabled,
    delivered: source.working,
    paused: source.paused,
    answeredFail: source.state === "errored",
    transportStreak: source.transportStreak,
  };
}

export function toProblemSignal(state: AutoUpdateUiState): ProblemSignal {
  return {
    git: toSourceSignal(state.git),
    web: toSourceSignal(state.web),
    muted: state.notify.problemsMuted,
    stamp: state.notified.problems,
  };
}
