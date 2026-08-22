// ru-code: the auto-update state machine — PURE transition functions over the
// wire state. Every mutation the engine performs goes through a function here so
// the product invariants live (and are exhaustively unit-tested) in one place:
//
//   INV-1  `enabled` on a source is USER-owned: no transition changes it except
//          `toggleSource` (the user's own action).
//   INV-2  Two answered auth rejections `pause` a source (persisted, zero
//          traffic). The ONLY unpause paths are an OK result (a manual «Проверить»
//          that succeeds) and `credentialsSaved` — both user-driven.
//   INV-3  A transport failure is silent: it grows `transportStreak`/`failingSince`
//          but never pauses and never raises alone. An answered result proves the
//          transport completed, so it clears `transportStreak`.
//   INV-4  History is bounded (UPDATE_HISTORY_ROWS) and newest-first.
//   INV-5  Priority is git → web: the FIRST source that answers OK owns the tick's
//          release verdict; the rest are advisory.
//   INV-6  `checkNow`/`checkStarted` no-op while a run is active (`run !== null`).
//
// The IO layer (probes, fetches) reports outcomes as plain data into these
// functions; it never writes state fields directly. No Effect, no Date.now,
// no Math.random — `now` and the next-tick computation are always injected.

import type {
  AutoUpdateWireState,
  AvailableReleaseWire,
  CheckEntryWire,
  SourceCheckResultWire,
  UpdateErrorWire,
  UpdateFailureClass,
  UpdateFailureCode,
  UpdateHeroStatusWire,
  UpdateNotifyKind,
  UpdateNotifyPrefsWire,
  UpdateRunLogEventWire,
  UpdateRunLogTone,
  UpdateRunPhase,
  UpdateSourceKind,
  UserPassCredMeta,
  SshCredMeta,
} from "@t3tools/contracts";

// ru-code: every auto-update tunable (history cap, re-raise window, …) is a
// branding constant — see ru-code/branding/src/auto-update.ts.
import { UPDATE_HISTORY_ROWS } from "@ru-code/branding";

import { isNewer } from "../manifest.ts";

// ── result inputs (plain data from the IO layer) ──────────────────────────────

/** A single completed source probe/check outcome, timestamped by the caller's `now`. */
export type SourceResult =
  | { readonly outcome: "ok"; readonly latencyMs: number | null; readonly raw: string | null }
  | {
      readonly outcome: "fail";
      readonly class: UpdateFailureClass;
      readonly code: UpdateFailureCode;
      readonly latencyMs: number | null;
      readonly raw: string | null;
    };

/** One source's contribution to a tick round: its result plus any manifest release it found (OK only). */
export interface TickSourceOutcome {
  readonly kind: UpdateSourceKind;
  readonly result: SourceResult;
  /** The release the manifest advertised (OK results only); null when none/failed. */
  readonly release: AvailableReleaseWire | null;
}

/** Credential metadata saved through the wizard (test-before-save has already passed). */
export type SavedCredMeta =
  | { readonly authVia: "https"; readonly httpsCred: UserPassCredMeta }
  | { readonly authVia: "ssh"; readonly sshCred: SshCredMeta }
  | { readonly authVia: "web"; readonly cred: UserPassCredMeta };

// ── the mutable common-source fields (shared by both source shapes) ───────────

interface MutableSourceFields {
  readonly paused: boolean;
  readonly authFails: number;
  readonly transportStreak: number;
  readonly failingSince: number | null;
  readonly lastResult: SourceCheckResultWire | null;
  /** A request to this source is running. Every RESULT clears it — see probeStarted. */
  readonly probing: boolean;
}

/** An answered auth rejection: 401/403 for web, access-denied for git. Feeds the pause counter. */
export function isAnsweredAuth(kind: UpdateSourceKind, code: UpdateFailureCode): boolean {
  return kind === "web" ? code === "http-401" || code === "http-403" : code === "git-access-denied";
}

/**
 * The common-field consequence of a single result. OK clears everything (streaks,
 * authFails, pause). A transport fail grows the transport streak and stamps
 * `failingSince`. An answered fail clears the transport streak (transport
 * completed) and, when it is an auth rejection, grows `authFails` — pausing at 2.
 */
function nextCommonFields(
  current: MutableSourceFields,
  kind: UpdateSourceKind,
  result: SourceResult,
  now: number,
): MutableSourceFields {
  if (result.outcome === "ok") {
    return {
      paused: false,
      authFails: 0,
      transportStreak: 0,
      failingSince: null,
      lastResult: { outcome: "ok", at: now, latencyMs: result.latencyMs, raw: result.raw },
      probing: false,
    };
  }
  const lastResult: SourceCheckResultWire = {
    outcome: "fail",
    at: now,
    class: result.class,
    code: result.code,
    latencyMs: result.latencyMs,
    raw: result.raw,
  };
  const failingSince = current.failingSince ?? now;
  if (result.class === "transport") {
    return {
      paused: current.paused,
      authFails: current.authFails,
      transportStreak: current.transportStreak + 1,
      failingSince,
      lastResult,
      probing: false,
    };
  }
  // answered
  if (isAnsweredAuth(kind, result.code)) {
    const authFails = current.authFails + 1;
    return {
      paused: current.paused || authFails >= 2,
      authFails,
      transportStreak: 0,
      failingSince,
      lastResult,
      probing: false,
    };
  }
  return {
    paused: current.paused,
    authFails: current.authFails,
    transportStreak: 0,
    failingSince,
    lastResult,
    probing: false,
  };
}

/**
 * Apply one source result. NEVER touches `enabled` (INV-1). An OK clears any
 * pause (INV-2, the manual-probe unpause path); two answered auth rejections set
 * it (INV-2). Transport failures stay silent (INV-3).
 */
export function applySourceResult(
  state: AutoUpdateWireState,
  kind: UpdateSourceKind,
  result: SourceResult,
  now: number,
): AutoUpdateWireState {
  if (kind === "git") {
    return { ...state, git: { ...state.git, ...nextCommonFields(state.git, "git", result, now) } };
  }
  return { ...state, web: { ...state.web, ...nextCommonFields(state.web, "web", result, now) } };
}

// ── hero derivation (shared with initialState) ────────────────────────────────

/** The subset of a source wire the hero derivation reads. */
export interface HeroSourceView {
  readonly enabled: boolean;
  readonly offered: boolean;
  readonly paused: boolean;
  readonly lastResult: SourceCheckResultWire | null;
}

/**
 * The hero status, derived PURELY from persisted facts (no network). Rule order
 * (to-do §3): a newer availableRelease → available; else any OK result → up-to-date
 * at its timestamp; else a paused/answered-failed source → attention needs-setup;
 * else a transport-failing source → attention unreachable; else nothing
 * offered/enabled → attention sources-off; else never-checked.
 */
export function deriveHero(input: {
  readonly availableRelease: AvailableReleaseWire | null;
  readonly currentVersion: string;
  readonly sources: ReadonlyArray<HeroSourceView>;
}): UpdateHeroStatusWire {
  const { availableRelease, currentVersion, sources } = input;

  const enabledSources = sources.filter((source) => source.offered && source.enabled);

  if (enabledSources.length === 0) {
    return { phase: "attention", code: "sources-off" };
  }

  const answeredFail = (source: HeroSourceView): boolean =>
    source.paused ||
    (source.lastResult?.outcome === "fail" && source.lastResult.class === "answered");
  if (enabledSources.every(answeredFail)) return { phase: "attention", code: "needs-setup" };

  if (availableRelease !== null && isNewer(availableRelease.version, currentVersion)) {
    return { phase: "available", release: availableRelease };
  }

  let lastOkAt: number | null = null;
  for (const source of sources) {
    if (source.lastResult?.outcome === "ok") {
      lastOkAt =
        lastOkAt === null ? source.lastResult.at : Math.max(lastOkAt, source.lastResult.at);
    }
  }
  if (lastOkAt !== null) return { phase: "up-to-date", lastCheckedAt: lastOkAt };

  if (sources.some(answeredFail)) return { phase: "attention", code: "needs-setup" };

  const transportFail = (source: HeroSourceView): boolean =>
    source.lastResult?.outcome === "fail" && source.lastResult.class === "transport";
  if (sources.some(transportFail)) return { phase: "attention", code: "unreachable" };

  return { phase: "never-checked" };
}

function heroSources(state: AutoUpdateWireState): ReadonlyArray<HeroSourceView> {
  return [
    {
      enabled: state.git.enabled,
      offered: state.git.offered,
      paused: state.git.paused,
      lastResult: state.git.lastResult,
    },
    {
      enabled: state.web.enabled,
      offered: state.web.offered,
      paused: state.web.paused,
      lastResult: state.web.lastResult,
    },
  ];
}

/** The release the hero currently advertises (single source of truth: the `available` hero). */
export function currentAvailableRelease(state: AutoUpdateWireState): AvailableReleaseWire | null {
  return state.status.phase === "available" ? state.status.release : null;
}

// ── tick round ────────────────────────────────────────────────────────────────

function tickHistoryEntry(
  outcome: TickSourceOutcome,
  currentVersion: string,
  now: number,
): CheckEntryWire {
  if (outcome.result.outcome === "ok") {
    const foundNewer = outcome.release !== null && isNewer(outcome.release.version, currentVersion);
    return {
      at: now,
      source: outcome.kind,
      latencyMs: outcome.result.latencyMs,
      result: foundNewer ? "update" : "up-to-date",
      version: foundNewer ? outcome.release!.version : currentVersion,
      raw: outcome.result.raw,
    };
  }
  return {
    at: now,
    source: outcome.kind,
    latencyMs: outcome.result.latencyMs,
    result: "error",
    version: null,
    raw: outcome.result.raw,
  };
}

/**
 * Apply a SINGLE manual probe («Проверить» on one card): source fields + one
 * history row + hero recompute. NEVER touches the advertised release — a probe
 * carries no manifest verdict, so it must not erase (or set) a release that a
 * full tick round found; only `applyTickRound` / the install re-resolve own
 * that verdict. (Without this, a successful probe of one source would clear
 * the «Доступна vX» state found via the other.)
 */
export function applyProbeResult(
  state: AutoUpdateWireState,
  kind: UpdateSourceKind,
  result: SourceResult,
  now: number,
): AutoUpdateWireState {
  const next = applySourceResult(state, kind, result, now);
  const entry = tickHistoryEntry({ kind, result, release: null }, state.currentVersion, now);
  const history = [entry, ...next.history].slice(0, UPDATE_HISTORY_ROWS);
  const status = deriveHero({
    availableRelease: currentAvailableRelease(state),
    currentVersion: state.currentVersion,
    sources: heroSources(next),
  });
  return { ...next, history, status };
}

/**
 * Settle a round that a PRESS ran — the install's own resolve, recorded when the press was refused
 * for what the sources said.
 *
 * It applies the results, the history and the release verdict exactly as a check does, and touches
 * NOTHING about a round's lifecycle: not `checking`, not `probing`, not `run`. Those belong to the
 * check machine, and a press does not hold its lock — the two run under DIFFERENT semaphores and
 * genuinely overlap, so clearing them here would switch off a spinner while that source's request
 * was still on the wire, and re-enable buttons a live round had quieted. The card must mean what it
 * says in both directions.
 */
export function applyPressRound(
  state: AutoUpdateWireState,
  outcomes: ReadonlyArray<TickSourceOutcome>,
  now: number,
  priorRelease: AvailableReleaseWire | null,
): AutoUpdateWireState {
  const settled = applyTickRound(state, outcomes, now, priorRelease);
  return {
    ...settled,
    checking: state.checking,
    git: { ...settled.git, probing: state.git.probing },
    web: { ...settled.web, probing: state.web.probing },
    run: state.run,
  };
}

/**
 * Settle a completed tick round: apply every source result, decide the release
 * verdict from the FIRST OK source in [git, web] order (INV-5), append bounded
 * history (INV-4) and recompute the hero. A newer release keeps its original
 * `foundAt` when the version is unchanged, else stamps `now`; a brand-new version
 * clears the dismissal so the notice can raise again.
 */
export function applyTickRound(
  state: AutoUpdateWireState,
  outcomes: ReadonlyArray<TickSourceOutcome>,
  now: number,
  /**
   * The release that was already known when this round STARTED. It has to be passed in, because by
   * the time a round settles the state no longer remembers it: the release lives in the hero status
   * (`currentAvailableRelease` reads `status.release`) and `checkStarted` replaces that status with
   * `checking`. Reading it from `state` here therefore always saw null, concluded that every
   * re-found version was brand new, and cleared the user's «Позже» — so a dismissed release was
   * re-announced at the next check instead of in two hours, and its `foundAt` restarted every time.
   * Callers that settle a round WITHOUT a preceding `checkStarted` (the install's supersede check)
   * pass `currentAvailableRelease(state)`, which is correct for them.
   */
  priorRelease: AvailableReleaseWire | null,
): AutoUpdateWireState {
  let next = state;
  for (const outcome of outcomes) {
    next = applySourceResult(next, outcome.kind, outcome.result, now);
  }

  const prior = priorRelease;
  let available: AvailableReleaseWire | null = prior;
  let clearDismissal = false;

  const order: ReadonlyArray<UpdateSourceKind> = ["git", "web"];
  const firstOk = order
    .map((kind) => outcomes.find((outcome) => outcome.kind === kind))
    .find((outcome) => outcome !== undefined && outcome.result.outcome === "ok");

  if (firstOk !== undefined) {
    // An OK source owns the verdict: a newer manifest sets/keeps the release; anything else clears it.
    if (firstOk.release !== null && isNewer(firstOk.release.version, state.currentVersion)) {
      const sameVersion = prior !== null && prior.version === firstOk.release.version;
      available = { ...firstOk.release, foundAt: sameVersion ? prior.foundAt : now };
      if (!sameVersion) clearDismissal = true;
    } else {
      available = null;
    }
  }

  const entries = outcomes.map((outcome) => tickHistoryEntry(outcome, state.currentVersion, now));
  const history = [...entries, ...next.history].slice(0, UPDATE_HISTORY_ROWS);

  const status = deriveHero({
    availableRelease: available,
    currentVersion: state.currentVersion,
    sources: heroSources(next),
  });

  return {
    ...next,
    history,
    status,
    // The round is over, whatever it found.
    checking: false,
    // Safety net, not the mechanism: the round clears each card as that source's request ends
    // (`probeStopped`). This catches a leg that was reached and then interrupted, so a settled round
    // can never leave a card «проверяю…».
    git: { ...next.git, probing: false },
    web: { ...next.web, probing: false },
    // A brand-new version is news: drop the quiet stamp so it is announced at once.
    notified: clearDismissal ? { ...next.notified, release: null } : next.notified,
    // A settled check answers whatever the last refusal was about.
    pressRefusal: null,
    // …and it supersedes a run that already FAILED. Without this the hero would stay pinned on the
    // dead run and «Проверить» would look like a button that does nothing. A LIVE run is never
    // here: `canCheckNow` refuses to start a check while one is in flight.
    run: next.run !== null && next.run.phase === "failed" ? null : next.run,
  };
}

// ── notifications ─────────────────────────────────────────────────────────────
// The decision itself is NOT here. `computeDriverDecision` (apps/web .../notify/notifyDecision.ts)
// owns it, and it is the only copy that runs: the server's version had zero non-test references and
// had already drifted from the live one (it gated problems on `roundHadAnyOk` — a fact about THIS
// round — where the client uses `noneDelivered`, derived from persisted results, and adds run-active
// and route suppression the server copy knew nothing about). Two copies of one decision, only one
// reachable, is how that drift stayed invisible. `markNotified` below is the server's whole part:
// it records the stamp the client's decision reads.

// ── settings / config (user actions) ──────────────────────────────────────────

/** INV-1: the only transition that touches `enabled`. */
export function toggleSource(
  state: AutoUpdateWireState,
  kind: UpdateSourceKind,
  enabled: boolean,
): AutoUpdateWireState {
  return kind === "git"
    ? { ...state, git: { ...state.git, enabled } }
    : { ...state, web: { ...state.web, enabled } };
}

/**
 * Flip the auto-check switch. `computeNextTickAt` is injected (the engine binds
 * the persisted jitter): `nextCheckAt` is its result when armed, null when off.
 */
export function setAutoCheck(
  state: AutoUpdateWireState,
  enabled: boolean,
  now: number,
  computeNextTickAt: (now: number) => number,
): AutoUpdateWireState {
  return { ...state, autoCheck: enabled, nextCheckAt: enabled ? computeNextTickAt(now) : null };
}

export function setNotifyPrefs(
  state: AutoUpdateWireState,
  prefs: UpdateNotifyPrefsWire,
): AutoUpdateWireState {
  return { ...state, notify: prefs };
}

/**
 * Record why a press was refused BEFORE any run existed (nothing newer, node too old, the layout
 * cannot be written). The settings hero renders it inline with a retry; `null` clears it. Never
 * persisted — a refusal is about this moment, not about the installation.
 */
export function setPressRefusal(
  state: AutoUpdateWireState,
  error: UpdateErrorWire | null,
): AutoUpdateWireState {
  return { ...state, pressRefusal: error };
}

/**
 * Stamp a notice as delivered — the ONE transition behind both "we just showed it" and "the user
 * waved it away", because the consequence is the same: silence until UPDATE_NOTIFY_RERAISE_MS has
 * passed. The release stamp records WHICH version it covers, so a newer one re-announces at once
 * (see applyTickRound) instead of inheriting this quiet window.
 */
export function markNotified(
  state: AutoUpdateWireState,
  kind: UpdateNotifyKind,
  now: number,
): AutoUpdateWireState {
  if (kind === "problems") {
    return { ...state, notified: { ...state.notified, problems: { at: now } } };
  }
  const version = currentAvailableRelease(state)?.version ?? null;
  if (version === null) return state; // nothing to be quiet about
  return { ...state, notified: { ...state.notified, release: { version, at: now } } };
}

/**
 * Credentials saved through the wizard (test-before-save passed): unpause, clear the auth counter,
 * and record the passing test as an OK lastResult (INV-2 unpause path). Updates the source's
 * redacted cred metadata + authVia. Leaves the hero to the check the engine runs next.
 *
 * WHICH SOURCE is derived from the metadata rather than passed alongside it. The two used to be
 * independent parameters, so the type permitted `("git", {authVia:"web", …})` — a pair no caller
 * makes, which the code then handled by silently writing `authVia:"https"`, and which gave the web
 * branch a fallback no caller can reach. Deriving it makes the impossible pairs unrepresentable
 * instead of merely unbuilt.
 */
export function credentialsSaved(
  state: AutoUpdateWireState,
  meta: SavedCredMeta,
  now: number,
): AutoUpdateWireState {
  const reset: MutableSourceFields = {
    paused: false,
    authFails: 0,
    transportStreak: 0,
    failingSince: null,
    lastResult: { outcome: "ok", at: now, latencyMs: null, raw: null },
    probing: false,
  };
  if (meta.authVia === "web") {
    return { ...state, web: { ...state.web, ...reset, cred: meta.cred } };
  }
  return {
    ...state,
    git: {
      ...state.git,
      ...reset,
      authVia: meta.authVia,
      httpsCred: meta.authVia === "https" ? meta.httpsCred : null,
      sshCred: meta.authVia === "ssh" ? meta.sshCred : null,
    },
  };
}

// ── check lifecycle (hero `checking`; guarded during a run) ────────────────────

/**
 * True when a manual/scheduled check may run (no install run IN FLIGHT — INV-6).
 * A run that already failed is terminal, not in flight: it must not lock the user out of
 * re-checking, which is the only way off a hero pinned to a stale release.
 */
export function canCheckNow(state: AutoUpdateWireState): boolean {
  return state.run === null || state.run.phase === "failed";
}

/**
 * A check round is under way. No-op while a run is in flight (INV-6).
 *
 * It does NOT touch the hero status. It used to replace it with `{phase:"checking"}` — and the
 * hero status is where the advertised release lives, so every background tick blanked
 * «Доступна vX», unmounted the release notes and hid the sidebar pill for the whole round. The
 * round's in-flight fact now travels as its own wire flag (`checking`), and the hero keeps
 * stating the last verdict throughout.
 *
 * It does NOT mark the source cards either. It used to mark every source the round *might* reach,
 * but the round is sequential and stops at the first OK — so when git answered, the web card
 * claimed to be checking while not one request had been made to it. The round now flips each card
 * as it reaches that source (`probeStarted` / `probeStopped` in `runSourceRound`), so a card
 * spinning means a request is genuinely in flight.
 */
export function checkStarted(state: AutoUpdateWireState): AutoUpdateWireState {
  if (!canCheckNow(state)) return state;
  return { ...state, checking: true };
}

/**
 * Why the scheduler's beat did or did not start a check. One decision, one place — the beat used to
 * ask three separate questions inline, and the first of them was its own opinion rather than the
 * machine's: `run !== null` also matched a run that had already FAILED. A failed run is terminal,
 * not in flight (see {@link canCheckNow}), so one failed install silently stopped every scheduled
 * check — and because the beat returned before advancing `nextCheckAt`, it stayed stopped until the
 * user pressed «Проверить» or «Повторить» by hand.
 */
export type ScheduleBeatDecision = "tick" | "run-active" | "auto-check-off" | "not-due";

export function scheduleBeatDecision(
  state: AutoUpdateWireState,
  now: number,
): ScheduleBeatDecision {
  if (!canCheckNow(state)) return "run-active";
  if (!state.autoCheck) return "auto-check-off";
  if (state.nextCheckAt === null || now < state.nextCheckAt) return "not-due";
  return "tick";
}

/**
 * End a check that never settled — interrupted, or past the round deadline. There are no results to
 * apply, so every source keeps its last known verdict; this only takes the cards out of
 * «проверяю…» and drops the in-flight flag. The hero was never touched by `checkStarted`, so
 * there is nothing to recompute — a known release (and its «Позже» stamp) survives an aborted
 * round exactly as it survives a settled one.
 *
 * Idempotent and self-guarding: a settled round already cleared `checking` (`applyTickRound`), so
 * calling this afterwards changes nothing. That is what lets it be a blind finalizer on the round
 * rather than a conditional the caller has to get right.
 */
export function checkAborted(state: AutoUpdateWireState): AutoUpdateWireState {
  if (state.checking !== true) return state;
  return {
    ...state,
    checking: false,
    git: { ...state.git, probing: false },
    web: { ...state.web, probing: false },
  };
}

/**
 * One source is being reached RIGHT NOW — the per-source «Проверить», and each leg of a tick round
 * as the round gets to it. Cleared by the result that follows (`nextCommonFields` sets
 * `probing:false` on every outcome) or by `probeStopped` when a round leg ends without applying its
 * result yet, so no path can leave a card spinning forever.
 */
export function probeStarted(
  state: AutoUpdateWireState,
  kind: UpdateSourceKind,
): AutoUpdateWireState {
  return kind === "git"
    ? { ...state, git: { ...state.git, probing: true } }
    : { ...state, web: { ...state.web, probing: true } };
}

/**
 * That source's request is no longer in flight. Needed because a tick round collects its outcomes
 * and applies them all at once at the end (the release verdict depends on the whole round), so
 * without this a source that finished early would keep spinning until the round settled.
 */
export function probeStopped(
  state: AutoUpdateWireState,
  kind: UpdateSourceKind,
): AutoUpdateWireState {
  return kind === "git"
    ? { ...state, git: { ...state.git, probing: false } }
    : { ...state, web: { ...state.web, probing: false } };
}

// ── install run ────────────────────────────────────────────────────────────────

export function startRun(
  state: AutoUpdateWireState,
  target: AvailableReleaseWire,
  now: number,
): AutoUpdateWireState {
  return {
    ...state,
    // A run supersedes whatever the previous press was refused for.
    pressRefusal: null,
    run: {
      targetVersion: target.version,
      fromVersion: state.currentVersion,
      phase: "download",
      pct: 0,
      log: [{ at: now, tone: "dim", code: "run.requested", params: { version: target.version } }],
      error: null,
    },
  };
}

export function advanceRunPhase(
  state: AutoUpdateWireState,
  phase: UpdateRunPhase,
): AutoUpdateWireState {
  if (state.run === null) return state;
  return { ...state, run: { ...state.run, phase } };
}

/** Download progress. Deduped + monotone: a non-advancing pct returns the SAME state (no wire churn). */
export function setRunPct(state: AutoUpdateWireState, pct: number): AutoUpdateWireState {
  if (state.run === null) return state;
  const bounded = Math.min(100, Math.max(0, Math.round(pct)));
  if (bounded <= state.run.pct) return state;
  return { ...state, run: { ...state.run, pct: bounded } };
}

export function appendRunLog(
  state: AutoUpdateWireState,
  event: UpdateRunLogEventWire,
): AutoUpdateWireState {
  if (state.run === null) return state;
  return { ...state, run: { ...state.run, log: [...state.run.log, event] } };
}

export function appendRunLogLine(
  state: AutoUpdateWireState,
  at: number,
  tone: UpdateRunLogTone,
  code: string,
  params: Record<string, string> = {},
): AutoUpdateWireState {
  return appendRunLog(state, { at, tone, code, params });
}

/** The run failed at `error`. Terminal `failed` phase; nothing was flipped unless the log says so. */
export function failRun(state: AutoUpdateWireState, error: UpdateErrorWire): AutoUpdateWireState {
  if (state.run === null) return state;
  return { ...state, run: { ...state.run, phase: "failed", error } };
}

/**
 * Is the run in a phase that only makes sense while work is happening?
 *
 * `download`, `verify` and `flip` all describe something IN PROGRESS. `restart` does not: it is the
 * successful hand-off, after which the server deliberately exits — a run left there ended exactly
 * as intended. `failed` is terminal, and a null run is nothing at all.
 *
 * The install now replies as soon as the run exists, so nobody is awaiting the fiber that finishes
 * it. This predicate is what a finalizer asks to decide whether the fiber ended with a verdict or
 * just ended.
 */
export function isRunUnfinished(state: AutoUpdateWireState): boolean {
  const phase = state.run?.phase;
  return phase === "download" || phase === "verify" || phase === "flip";
}

/**
 * Close a run whose fiber ended without reaching a verdict — interrupted, killed, or past the run
 * deadline. Nothing was switched on (the pointer flip and its journal write are uninterruptible, so
 * a run interrupted mid-flip either never wrote or wrote both), which is why the sentence the user
 * gets says so and «Повторить» stays safe.
 *
 * A no-op on every other phase, so it is safe to call blindly from a finalizer.
 */
export function failUnfinishedRun(state: AutoUpdateWireState, now: number): AutoUpdateWireState {
  if (!isRunUnfinished(state)) return state;
  return failRun(appendRunLogLine(state, now, "err", "run.failed", { code: "interrupted" }), {
    code: "interrupted",
    raw: null,
    params: {},
  });
}
