// ru-code: pure view logic for the auto-update sidebar pill — decides whether the
// pill shows, its kind/tone/copy, and the re-raise. Pure and unit-tested so the
// component (SidebarAutoUpdatePill) stays a thin renderer.
//
// v3: the pill has exactly THREE kinds (data-kind on the element):
//   · `release`  — a newer version is available and not muted. It is a STATUS
//     indicator, not a nag: it deliberately ignores the quiet stamp, because the
//     stamp is written the moment the toast fires — reading it here would blank the
//     sidebar for two hours while an update sits waiting. It is therefore not
//     dismissible; muting lives in settings, and clicking opens them.
//   · `problems` — the master «Настройте обновления» predicate (§2.4 / 1b). This one
//     IS a nag, so it honours the server stamp and its ✕ writes it.
//   · `updating`  — a run is LIVE. The pill used to return null here, so it vanished
//     at exactly the moment something was happening: navigate away from the settings
//     page mid-update and nothing on screen said so. It is a status indicator too —
//     never dismissible, and it outranks the others while it lasts.
// No browser storage on any path.
// Updating wins over release, release over problems. Every other phase is silent.

import {
  hasProblem,
  problemReraised,
  type ProblemSignal,
  type ReleaseSignal,
} from "./notifyDecision";

export type PillKind = "updating" | "release" | "problems";
export type PillTone = "available" | "attention";

export interface PillView {
  readonly kind: PillKind;
  readonly tone: PillTone;
  readonly title: string;
  readonly description: string;
  /** The version this pill is about (release only). */
  readonly version: string | null;
  readonly dismissible: boolean;
}

export interface PillInput {
  readonly release: ReleaseSignal;
  readonly problem: ProblemSignal;
  /** A server-owned run is live (not terminally failed). */
  readonly runActive: boolean;
  /** The version that run is installing, when one is live. */
  readonly runTargetVersion: string | null;
  /** The run reached `restart` — the server is coming back on the new version. */
  readonly runRestarting: boolean;
}

export function computePillView(input: PillInput, now: number): PillView | null {
  if (input.runActive) {
    const version = input.runTargetVersion;
    return {
      kind: "updating",
      tone: "available",
      title: input.runRestarting ? "Restarting…" : `Updating to v${version ?? ""}…`,
      description: input.runRestarting
        ? "The app is restarting on the new version — it comes back on its own."
        : `Installing version ${version ?? ""}. Click to watch it.`,
      version,
      dismissible: false,
    };
  }

  if (input.release.available && !input.release.muted && input.release.version !== null) {
    const version = input.release.version;
    return {
      kind: "release",
      tone: "available",
      title: `Available v${version}`,
      description: `An update to version ${version} is ready. Click to open update settings.`,
      version,
      dismissible: false,
    };
  }

  if (
    hasProblem(input.problem) &&
    !input.problem.muted &&
    problemReraised(input.problem.stamp, now)
  ) {
    return {
      kind: "problems",
      tone: "attention",
      title: "Set up updates",
      description: "An update source needs attention — open update settings to fix it.",
      version: null,
      dismissible: true,
    };
  }

  return null;
}
