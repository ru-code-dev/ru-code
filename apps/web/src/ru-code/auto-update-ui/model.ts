// ru-code: auto-update UI — the component-facing domain model (v3).
//
// This is the shape `wireToUi` produces from one `AutoUpdateWireState` snapshot:
// a fully localized, display-ready projection of the machine wire. Components
// read ONLY this shape; every human sentence is already resolved (the wire
// carries machine codes, `wireToUi` is the localization boundary).
//
// v3 design (see to-do.md §2/§3):
//   · two sources (git first, web second), each user-switchable, health derived
//     from the last probe result + auth/transport counters (no health enum)
//   · hero states = never-checked / up-to-date / checking / available /
//     running / apply-failed / attention — the last three are DERIVED here from
//     the run + lastApply + status wire fields
//   · no frequency, no install policy, no rollback (v2 concepts, all removed)

import type {
  SshKeyOrigin,
  UpdateAttentionCode,
  UpdateFailureClass,
  UpdateFailureCode,
} from "@t3tools/contracts";

export type SourceKind = "git" | "web";

// ── changelog / release ────────────────────────────────────────────────────────

export type NoteKind = "feat" | "fix" | "perf" | "ui";

export interface ReleaseNote {
  /** null = plain text, no badge (author line without a category). */
  kind: NoteKind | null;
  text: string;
}

/** One version's worth of changelog notes (newest-first in the surrounding array). */
export interface ChangelogVersion {
  version: string;
  notes: ReleaseNote[];
}

export interface ReleaseInfo {
  version: string;
  releasedAgo: string;
  sizeMb: number;
  sha256: string;
  /** Accumulated, version-grouped changelog for every version newer than current. */
  changelog: ChangelogVersion[];
  /** True when older versions were dropped by the display cap. */
  changelogTruncated: boolean;
}

// ── check history ──────────────────────────────────────────────────────────────

export interface CheckEntry {
  at: string;
  /**
   * The raw instant, carried alongside the label. A React key needs a value that identifies the
   * row for as long as it exists, and `at` is a LOCALIZED, TIME-VARYING string: it turns from
   * «только что» into «Сегодня, HH:MM» at the 60-second boundary, so keying on it remounted every
   * row on the rollover, and two same-source rows inside one displayed minute collided outright.
   */
  atMs: number;
  source: SourceKind;
  latencyMs: number | null;
  result: "up-to-date" | "update" | "error";
  detail: string;
}

// ── source cards ────────────────────────────────────────────────────────────────

/** A source's last completed probe, projected to one display line. */
export type SourceResultView =
  | { outcome: "ok"; agoLabel: string; raw: string | null; latencyMs: number | null; line: string }
  | {
      outcome: "fail";
      agoLabel: string;
      class: UpdateFailureClass;
      code: UpdateFailureCode;
      sentence: string;
      raw: string | null;
      latencyMs: number | null;
      line: string;
    };

/**
 * Derived presentation state of a source card. `ok` — last probe succeeded;
 * `off` — user switched it off; `paused` — auth lockout (2 rejections);
 * `errored` — the server answered wrong; `unreachable` — a transport streak > 3;
 * `retrying` — a short transport streak; `idle` — never checked yet.
 */
export type SourceState =
  | "ok"
  | "disabled"
  | "paused"
  | "errored"
  | "unreachable"
  | "retrying"
  | "idle"
  // ru-code: a request to this source is running right now (the server publishes it).
  | "probing";

/** The health vocabulary the `ChannelCard` ui-kit copy renders (dot color + text). */
export type ChannelHealth = "ok" | "probing" | "unchecked" | "needs-setup" | "unreachable";

/** Project a derived source state onto the card's coarse health dot. */
export function sourceHealth(state: SourceState): ChannelHealth {
  switch (state) {
    case "ok":
      return "ok";
    case "unreachable":
      return "unreachable";
    // F17: a short transport streak is NOT a probe in flight. Showing the spinner there made a
    // dead server look like a live check forever; the honest dot is "unreachable" and the card
    // line says when the next attempt is. `probing` is reserved for a request actually running.
    case "retrying":
      return "unreachable";
    case "probing":
      return "probing";
    // `idle` means nothing has been asked of this source yet — by design, there is no check at
    // boot. Folding it into `needs-setup` made a FRESH INSTALL open on two amber "needs setup"
    // cards whose own body said no setup was needed, and it did so for BOTH sources, because this
    // projection reads the state and never the kind. Its own neutral health says the true thing.
    case "idle":
      return "unchecked";
    // A source the USER turned off needs nothing from anyone — it was «needs-setup» here while the
    // card's own status text said «off» for the same state, two answers to one question that only
    // render order kept apart. The card is the one that renders the dot, and `unchecked` is its
    // neutral tone, which is what a deliberate off switch deserves.
    case "disabled":
      return "unchecked";
    case "paused":
    case "errored":
      return "needs-setup";
    default:
      return "needs-setup";
  }
}

interface SourceViewBase {
  kind: SourceKind;
  enabled: boolean;
  /** False when the build bakes no link for this source — the card is hidden. */
  offered: boolean;
  url: string;
  paused: boolean;
  authFails: number;
  transportStreak: number;
  /** How long the current unbroken failure streak has lasted (null when healthy). */
  failingSinceAgo: string | null;
  lastResult: SourceResultView | null;
  /** The one-line health sentence the card shows. */
  healthLine: string;
  /** Derived: enabled, not paused, last probe ok. */
  working: boolean;
  /**
   * Derived: this source would be REACHED by a check right now — offered by the build, switched on
   * and not paused. Deliberately NOT {@link working}: a source that has simply never been checked
   * (the state of every source on a fresh install, because nothing probes at boot) is perfectly
   * checkable, and gating the hero's «Check» on `working` is what left a new install with a check
   * button that could never be pressed. `working` still means "answered OK last time" and still
   * drives the facts strip.
   */
  checkable: boolean;
  state: SourceState;
}

export interface GitSourceView extends SourceViewBase {
  kind: "git";
  authVia: "ambient" | "https" | "ssh";
  httpsCred: { username: string; savedAgo: string } | null;
  sshCred: {
    fingerprint: string;
    keyType: "ed25519";
    savedAgo: string;
    origin: SshKeyOrigin;
  } | null;
}

export interface WebSourceView extends SourceViewBase {
  kind: "web";
  cred: { username: string; savedAgo: string } | null;
}

// ── run (drives the /updating view and the hero while installing) ────────────────

/**
 * The run view keeps the prototype's phase vocabulary (the sw-kit pages read it):
 * the wire's `flip` maps to `install`; the wire never emits `reconnect`/`done`
 * (those were prototype-only success beats).
 */
export type RunPhase =
  | "download"
  | "verify"
  | "install"
  | "restart"
  | "reconnect"
  | "done"
  | "failed";

export type RunLogTone = "dim" | "ok" | "act" | "warn" | "err";

export interface RunLogLine {
  time: string;
  tone: RunLogTone;
  text: string;
}

export interface UpdateRun {
  targetVersion: string;
  fromVersion: string;
  phase: RunPhase;
  /** Localized phase label ("Downloading" / "Verifying" / …). */
  phaseLabel: string;
  pct: number;
  log: RunLogLine[];
  /**
   * When the run entered `restart` (epoch ms, from the `run.restart` log event), or null in any
   * other phase. Deliberately RAW rather than a pre-computed elapsed: the number has to keep
   * climbing while the server is down and the snapshot is frozen, so whoever displays it owns the
   * clock. The hero renders it against its own tick; the driver measures the budget from it.
   */
  restartedAtMs: number | null;
  error: { title: string; detail: string; hint: string } | null;
}

// ── last apply (journal outcome, shown after a restart) ──────────────────────────

export interface LastApplyView {
  targetVersion: string;
  fromVersion: string;
  outcome: "ok" | "failed";
  /** Localized reason sentence for `failed`; null on `ok`. */
  reason: string | null;
  /** Mono raw reason code fragment (only when the code was unknown). */
  reasonRaw: string | null;
  atLabel: string;
}

// ── hero status ──────────────────────────────────────────────────────────────────

export interface AttentionView {
  code: UpdateAttentionCode;
  title: string;
  message: string;
}

export type HeroStatus =
  | { phase: "never-checked" }
  | { phase: "up-to-date"; lastCheckedAgo: string }
  | { phase: "checking" }
  | { phase: "available"; release: ReleaseInfo }
  /** Work is ACTUALLY happening — progress, and the restart is still ahead. */
  | { phase: "running"; run: UpdateRun }
  /** The run is over and it failed. Separate from `running` so a dead run can never render as a spinner. */
  | { phase: "run-failed"; run: UpdateRun }
  | { phase: "apply-failed"; lastApply: LastApplyView }
  | { phase: "attention"; attention: AttentionView };

// ── the whole component-facing state ─────────────────────────────────────────────

/**
 * Why an install run is impossible on this machine — a localized sentence plus the machine reason.
 * Null when updates can be applied. The UI states this up front instead of letting a press fail.
 */
export interface ApplyBlockedView {
  reason: "layout" | "read-only";
  note: string;
}

/** Server-owned "already told them" stamps; `release` names the version it covers. */
export interface NotifiedStamps {
  release: { version: string; at: number } | null;
  problems: { at: number } | null;
}

/**
 * The last press the server refused before any run started — a localized sentence plus the machine
 * code, rendered inline by the hero with an action (never a toast).
 */
export interface PressRefusalView {
  code: string;
  sentence: string;
  /** Machine evidence the server attached (a path, a URL), or null. NEVER a sentence. */
  raw: string | null;
  /**
   * Which button answers this refusal. `check` when the cause was that nothing could be resolved
   * (re-checking is the fix); `install` when the press itself is worth repeating.
   */
  action: "check" | "install";
}

export interface AutoUpdateUiState {
  currentVersion: string;
  installDir: string;
  entryPoint: string;
  address: string;
  /** Null when this installation can apply updates. */
  applyBlocked: ApplyBlockedView | null;
  /** Null unless the last press was refused before a run started. */
  pressRefusal: PressRefusalView | null;
  /**
   * A check is in flight RIGHT NOW — a SERVER fact of its own, carried on its own wire field.
   *
   * Separate from the hero status because the hero keeps showing an available release (and a failed
   * run) through a background tick — the buttons go quiet, the screen does not change. This comment
   * described that rule long before the code implemented it: `checkStarted` used to REPLACE the
   * hero status with `{phase:"checking"}`, and the hero status is where the release lives, so every
   * scheduled tick blanked «Доступна vX», unmounted the release notes and hid the sidebar pill for
   * the whole round.
   */
  checking: boolean;
  /**
   * The SERVER has accepted a press and has not settled it yet — it re-resolves both sources before
   * a run exists, which is a full source round.
   *
   * The client used to keep this itself, set on the click and released by a wall-clock watchdog in
   * case nothing ever came back. Now it is a fact the server publishes and clears with a finalizer,
   * so the buttons follow the server rather than a local timer, and a dead server cannot leave one
   * stuck down (no state at all ⇒ the disconnected rendering, not a locked button).
   */
  pressInFlight: boolean;
  autoCheck: boolean;
  /** Localized "in 40 min" / "in 6 h", or null when auto-check is off. */
  nextCheckIn: string | null;
  /** Wall-clock "HH:MM" of the next scheduled check, or null when auto-check is off. */
  nextCheckClock: string | null;
  git: GitSourceView;
  web: WebSourceView;
  status: HeroStatus;
  history: CheckEntry[];
  run: UpdateRun | null;
  lastApply: LastApplyView | null;
  /** The available release (for the notes card / toast), null when none is offered. */
  release: ReleaseInfo | null;
  notify: { releasesMuted: boolean; problemsMuted: boolean };
  /**
   * The server-owned quiet-until stamps behind every notification surface. Written when a notice is
   * raised AND when the user waves it away; the ONLY re-raise clock (no browser storage).
   */
  notified: NotifiedStamps;
}

// ── derivations (used across the settings components) ────────────────────────────

export function anySourceWorks(state: AutoUpdateUiState): boolean {
  return state.git.working || state.web.working;
}

/** True when a check would actually reach something — the gate on every «Check now» button. */
export function anySourceCheckable(state: AutoUpdateUiState): boolean {
  return state.git.checkable || state.web.checkable;
}

/** "git + web" / "git" / "not configured" — for the hero facts strip. */
export function sourcesSummary(state: AutoUpdateUiState): string {
  const active = [state.git.working ? "git" : null, state.web.working ? "web" : null]
    .filter((value): value is string => value !== null)
    .join(" + ");
  return active.length > 0 ? active : "not configured";
}

/** A best-effort manifest location string for the developer-details block. */
export function manifestUrlFor(state: AutoUpdateUiState): string {
  if (state.web.working) return `${state.web.url.replace(/\/$/, "")}/manifest.json`;
  if (state.git.working) return `${state.git.url} → manifest.json`;
  return "—";
}
