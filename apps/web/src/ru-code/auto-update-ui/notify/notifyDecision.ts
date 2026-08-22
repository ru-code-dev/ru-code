// ru-code: the ONE pure decision core for every auto-update notification surface
// (the sidebar pill AND the app-root toast/redirect driver read it). No React, no
// I/O, no localized copy — just booleans over the derived v3 UI facts, so the
// whole matrix (muted / dismissed / 2h re-raise / problem-actionable / redirect)
// is table-tested in one place and the pill and the driver can never disagree.
//
// Two re-raise clocks share ONE constant (UPDATE_NOTIFY_RERAISE_MS = 2h, owned by
// @ru-code/branding and read by the server state machine too):
// BOTH clocks are server-owned stamps on the wire (`notified.release` /
// `notified.problems`), written when a surface RAISES a notice and when the user
// waves it away — so the pill, the toast and every other tab share one truth and
// it survives a restart. There is NO browser storage behind notifications.

// ru-code: the re-raise window is a branding tunable, shared verbatim with the
// server state machine (transitions.ts) — see ru-code/branding/src/auto-update.ts.
import { UPDATE_NOTIFY_RERAISE_MS } from "@ru-code/branding";

// ── release signal ─────────────────────────────────────────────────────────────

export interface ReleaseSignal {
  /** A newer release is persisted server-side (the hero is `available`). */
  readonly available: boolean;
  readonly version: string | null;
  /** «о новых версиях» mute toggle. */
  readonly muted: boolean;
  /** Server stamp of when this notice was last raised/waved away, and for WHICH version. */
  readonly stamp: { readonly version: string; readonly at: number } | null;
}

/**
 * True once the quiet window has elapsed — or immediately, when the stamp covers a DIFFERENT
 * version: a genuinely new release is news and must not inherit the previous one's silence.
 */
export function releaseReraised(
  stamp: ReleaseSignal["stamp"],
  version: string,
  now: number,
): boolean {
  if (stamp === null) return true;
  if (stamp.version !== version) return true;
  return now - stamp.at >= UPDATE_NOTIFY_RERAISE_MS;
}

/** The release surface is eligible: available, has a version, not muted, past the re-raise window. */
export function shouldShowRelease(release: ReleaseSignal, now: number): boolean {
  return (
    release.available &&
    release.version !== null &&
    !release.muted &&
    releaseReraised(release.stamp, release.version, now)
  );
}

/**
 * The per-tab dedupe key for a release toast: at most once per (version × quiet window). The server
 * stamp is the real gate — this only stops a double-fire in the moments before the stamp lands.
 */
export function releaseToastKey(version: string, stamp: ReleaseSignal["stamp"]): string {
  return `${version}:${stamp !== null && stamp.version === version ? stamp.at : "fresh"}`;
}

// ── problem signal ──────────────────────────────────────────────────────────────

/** One source distilled to the facts the problem predicate needs. */
export interface SourceSignal {
  /** The build bakes a link for this source. */
  readonly offered: boolean;
  /** The user's on/off switch. */
  readonly enabled: boolean;
  /** The last probe answered OK (a delivered result). */
  readonly delivered: boolean;
  /** Auth-lockout paused (persisted). */
  readonly paused: boolean;
  /** The server answered wrong (CLASS 2 / `answered`). */
  readonly answeredFail: boolean;
  /** Consecutive transport failures (escalates past 3). */
  readonly transportStreak: number;
}

export interface ProblemSignal {
  readonly git: SourceSignal;
  readonly web: SourceSignal;
  /** «о проблемах с каналом» mute toggle. */
  readonly muted: boolean;
  /** Server stamp of when this notice was last raised/waved away. */
  readonly stamp: { readonly at: number } | null;
}

/** An offered + enabled source is a candidate to deliver an update. */
function sourceActive(source: SourceSignal): boolean {
  return source.offered && source.enabled;
}

/** An active source the user could actually fix: paused, answered-wrong, or long unreachable. */
function sourceActionable(source: SourceSignal): boolean {
  return (
    sourceActive(source) && (source.paused || source.answeredFail || source.transportStreak > 3)
  );
}

/**
 * The master «Настройте обновления» predicate (to-do.md §2.4 / 1b): NO active
 * source delivered a result AND at least one is actionable. A broken git behind a
 * working web is silent; both sources merely off/unreachable-once is silent.
 */
export function hasProblem(problem: ProblemSignal): boolean {
  const active = [problem.git, problem.web].filter(sourceActive);
  const noneDelivered = active.length > 0 && active.every((source) => !source.delivered);
  const anyActionable = [problem.git, problem.web].some(sourceActionable);
  return noneDelivered && anyActionable;
}

/** True once the problem quiet window has elapsed (or the notice was never raised). */
export function problemReraised(stamp: ProblemSignal["stamp"], now: number): boolean {
  return stamp === null || now - stamp.at >= UPDATE_NOTIFY_RERAISE_MS;
}

/**
 * The per-tab dedupe key for a problem toast — the exact counterpart of {@link releaseToastKey},
 * and for the exact same reason.
 *
 * The server stamp is the real gate, but it only arrives if `snoozeNotification` reaches the
 * server. A problem notice is raised precisely when sources are failing, and the failure that
 * matters most — the server itself being gone — is the one where that RPC cannot land. Without a
 * local key the raise stays eligible, and since the driver's decision is recomputed on the shared
 * one-second tick (which is what makes the 2h re-raise fire without a reload), "still eligible"
 * meant a fresh toast every second for as long as the server stayed down.
 *
 * Keying on the stamp rotates correctly across quiet windows: raising writes a new stamp, which
 * produces a new key, so the next window is free to raise again.
 */
export function problemToastKey(stamp: ProblemSignal["stamp"]): string {
  return stamp === null ? "fresh" : String(stamp.at);
}

// ── the whole driver decision ─────────────────────────────────────────────────

export interface DriverInput {
  readonly release: ReleaseSignal;
  readonly problem: ProblemSignal;
  /** A server-owned run is live (run !== null && phase !== "failed"). */
  readonly runActive: boolean;
  /** The user is already looking at the update settings — the page states everything a toast would. */
  readonly onUpdateSettingsRoute: boolean;
  readonly now: number;
}

export interface DriverDecision {
  /** The version to raise «Доступна vX» for, or null. */
  readonly releaseToast: string | null;
  /** Raise «Настройте обновления». */
  readonly problemToast: boolean;
}

/**
 * The pure toast decision. Both surfaces stay silent while a run is live (the settings hero is the
 * run view, and the restart choreography owns the screen right after) and on the update-settings
 * route itself, where every fact a toast would carry is already on screen — the live-repro that
 * produced an error toast, a release toast and a stray page over one press (F14/F15).
 */
export function computeDriverDecision(input: DriverInput): DriverDecision {
  const quiet = input.runActive || input.onUpdateSettingsRoute;
  const releaseEligible = !quiet && shouldShowRelease(input.release, input.now);
  const problemEligible =
    !quiet &&
    hasProblem(input.problem) &&
    !input.problem.muted &&
    problemReraised(input.problem.stamp, input.now);
  return {
    releaseToast: releaseEligible ? input.release.version : null,
    problemToast: problemEligible,
  };
}
