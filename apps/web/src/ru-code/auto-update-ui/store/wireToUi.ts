// ru-code: the presentation mapper AND the localization boundary for auto-update.
//
// The wire (packages/contracts/.../auto-update/model.ts) carries MACHINE DATA
// ONLY — enums, codes, epoch-ms numbers, raw technical fragments. This pure
// function turns one snapshot into the fully localized, display-ready
// `AutoUpdateUiState`. Every human sentence is produced HERE; nothing localized
// rides the wire.
//
// Localization: EN literals are the source; the build transform swaps them for
// their `ru-code/localization/dict/.../store/wireToUi.ts.json` counterparts, and
// the hand-written `L`/`Lp` seams cover plural/structural shapes the transform
// cannot synthesize. `now` is ALWAYS injected (no `Date.now()` default) so the
// single derived atom drives every relative time from one shared tick.

import type {
  AutoUpdateWireState,
  AvailableReleaseWire,
  CheckEntryWire,
  GitSourceWire,
  LastApplyWire,
  SourceCheckResultWire,
  UpdateAttentionCode,
  UpdateErrorWire,
  UpdateFailureCode,
  UpdateHeroStatusWire,
  UpdateRunLogEventWire,
  UpdateRunPhase,
  UpdateRunWire,
  UpdateSourceKind,
  WebSourceWire,
} from "@t3tools/contracts";

import { APP_COMMAND, APP_NAME } from "@ru-code/branding";
import { L, Lp } from "@ru-code/localization"; // ru-code: bilingual plural/structural seam

import {
  type ApplyBlockedView,
  type AttentionView,
  type AutoUpdateUiState,
  type ChangelogVersion,
  type CheckEntry,
  type GitSourceView,
  type HeroStatus,
  type LastApplyView,
  type PressRefusalView,
  type NoteKind,
  type ReleaseInfo,
  type RunLogLine,
  type RunPhase,
  type SourceResultView,
  type SourceState,
  type UpdateRun,
  type WebSourceView,
} from "../model";

// ── time helpers (pure; `now` always injected) ─────────────────────────────────

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const MONTHS_GENITIVE = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago". */
export function agoRu(epochMs: number, now: number): string {
  const delta = Math.max(0, now - epochMs);
  if (delta < 45_000) return "just now";
  const min = Math.round(delta / MINUTE);
  if (delta < HOUR)
    return `${min} ${Lp(min, ["minute", "minutes"], ["минуту", "минуты", "минут"])} ${L("ago", "назад")}`;
  const hr = Math.round(delta / HOUR);
  if (delta < DAY)
    return `${hr} ${Lp(hr, ["hour", "hours"], ["час", "часа", "часов"])} ${L("ago", "назад")}`;
  const day = Math.round(delta / DAY);
  return `${day} ${Lp(day, ["day", "days"], ["день", "дня", "дней"])} ${L("ago", "назад")}`;
}

/** "now" / "in 40 min" / "in 6 h" / "in 7 d" — for the next scheduled check. */
export function inRu(epochMs: number, now: number): string {
  const delta = epochMs - now;
  if (delta <= 30_000) return "now";
  const min = Math.round(delta / MINUTE);
  if (delta < HOUR) return `in ${min} min`;
  const hr = Math.round(delta / HOUR);
  if (delta < DAY) return `in ${hr} h`;
  const day = Math.round(delta / DAY);
  return `in ${day} d`;
}

/** "Just now" / "Today, 09:14" / "Yesterday, 21:14" / "21 July, 21:14". */
export function atRu(epochMs: number, now: number): string {
  if (now - epochMs >= 0 && now - epochMs < 60_000) return "Just now";
  const date = new Date(epochMs);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayDiff = Math.round((startOfDay(now) - startOfDay(epochMs)) / DAY);
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Yesterday, ${time}`;
  return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}, ${time}`;
}

/** Run-log wall-clock timestamp "HH:MM:SS" (no relative time → no `now`). */
export function timeHms(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Wall-clock "HH:MM" of a scheduled instant (digits only — locale-agnostic). */
export function clockHm(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── machine-code → sentence maps (the localization core) ───────────────────────

/** Generic fallback for an unrecognized machine code — paired with the mono raw. */
const UNKNOWN_SENTENCE = "Something went wrong.";

/** Every `UpdateFailureCode` → one sentence. Unknown code → generic + mono raw. */
export function failureSentence(code: UpdateFailureCode): string {
  switch (code) {
    case "dns":
      return "Could not resolve the server address.";
    case "timeout":
      return "The server did not respond in time.";
    case "refused":
      return "The connection was refused.";
    case "reset":
      return "The connection was dropped.";
    case "no-route":
      return "No route to the server.";
    case "tls":
      return "Could not establish a secure connection.";
    case "blocked-shape":
      return "A network gateway answered instead of the server.";
    case "transport-other":
      return "Could not reach the server.";
    case "http-401":
      return "Sign-in required — the credentials were rejected.";
    case "http-403":
      return "Access denied by the server.";
    case "http-404":
      return "The release was not found at this address.";
    case "http-status":
      return "The server replied with an error.";
    case "invalid-manifest":
      return "The server responded, but the release manifest is missing or corrupted.";
    case "release-download-failed":
      return "The release could not be downloaded — check the network and try again.";
    case "git-not-found":
      return "The repository was not found.";
    case "git-access-denied":
      return "Access to the repository was denied.";
    default:
      return UNKNOWN_SENTENCE;
  }
}

/** Hero attention code → title + message (points the user at the CAUSE). */
export function attentionView(code: UpdateAttentionCode): AttentionView {
  switch (code) {
    case "sources-off":
      return {
        code,
        title: "Auto-update is off",
        message: "No update source is enabled — turn one on to keep getting new versions.",
      };
    case "needs-setup":
      return {
        code,
        title: "A source needs attention",
        message: "An update source rejected the connection — open it and check the sign-in.",
      };
    case "unreachable":
      return {
        code,
        title: "Update sources are unreachable",
        message: `The update servers are not responding — ${APP_NAME} will keep trying.`,
      };
    default:
      return { code, title: "Auto-update needs attention", message: UNKNOWN_SENTENCE };
  }
}

/** Wire run phase → the localized step label. */
export function runPhaseLabel(phase: UpdateRunPhase): string {
  switch (phase) {
    case "download":
      return "Downloading";
    case "verify":
      return "Verifying";
    case "flip":
      return "Installing";
    case "restart":
      return "Restarting";
    case "failed":
      return "Failed";
    default:
      return UNKNOWN_SENTENCE;
  }
}

/** Wire run phase → the run-view phase vocabulary the sw-kit pages read. */
function runPhaseToView(phase: UpdateRunPhase): RunPhase {
  switch (phase) {
    case "download":
      return "download";
    case "verify":
      return "verify";
    case "flip":
      return "install";
    case "restart":
      return "restart";
    case "failed":
      return "failed";
    default:
      return "download";
  }
}

/**
 * Every code an APPLY can fail with → one sentence. This is ONE table on purpose: the same
 * failure reaches the user twice — live, as `run.error.code`, and after a restart, as the
 * journal's `lastApply.reasonCode` — and the two must never word it differently. The codes are
 * exactly what the engine emits: `mapFetchErrorCode` (updateEngineLive.ts) produces the first
 * four, the flip/spawn guards the next two, and the journal adds `port-busy` / `not-applied`.
 */
export function applyFailureSentence(code: string): string {
  switch (code) {
    case "download-failed":
      return "The update could not be downloaded.";
    case "download-timeout":
      return "The download took too long and was stopped.";
    case "superseded":
      return "A newer version appeared while this one was downloading — nothing was installed.";
    case "archive-integrity":
      return "The downloaded file was corrupted (checksum mismatch).";
    case "file-integrity":
      return "An extracted file failed its checksum.";
    case "structure":
      return "The update archive is not a valid release.";
    case "flip-failed":
      return "The new version could not be switched on.";
    case "spawn-failed":
      return "The new version could not be started.";
    case "port-busy":
      return "The port was busy after the restart.";
    case "not-applied":
      return "The restart did not pick up the new version.";
    case "node-too-old":
      return "The installed Node.js is too old for this version.";
    // The run ended without reaching a verdict — it hit the run deadline, or the server was
    // interrupted mid-run. Nothing was switched on; pressing again is safe.
    case "interrupted":
      return "The update stopped before it finished. Nothing was changed.";
    default:
      return UNKNOWN_SENTENCE;
  }
}

/**
 * Structured run-log event → its localized line text. Unknown code → code + params, never dropped.
 *
 * The vocabulary is exactly what the engine emits: `run.requested`, `run.download`, `run.verified`,
 * `run.flipped`, `run.restart`, `run.failed`. Three more (`run.downloaded`, `run.verify`,
 * `run.flip`) used to have cases here and no emitter anywhere — dead branches that read as
 * documentation of a protocol the server does not speak. The default arm still renders any code
 * with its params, so adding an event server-side degrades to something readable rather than
 * nothing.
 */
export function runLogText(event: UpdateRunLogEventWire): string {
  const p = event.params;
  const sizeMb = (() => {
    const bytes = Number(p.sizeBytes);
    return Number.isFinite(bytes) && bytes > 0 ? (bytes / 1e6).toFixed(1) : null;
  })();
  switch (event.code) {
    case "run.requested":
      return `requested update to v${p.version ?? ""}`;
    case "run.download": {
      const sizeSuffix = sizeMb !== null ? ` (${sizeMb} MB)` : "";
      return `downloading ${APP_COMMAND}-${p.version ?? ""}.tgz${sizeSuffix}…`;
    }
    case "run.verified":
      return `sha256 matched · ${p.sha256 ?? ""}…`;
    case "run.flipped":
      return "new version in place · pointer written";
    case "run.restart":
      return `restarting on port ${p.port ?? ""}…`;
    case "run.failed": {
      // The reason is a PARAM (see `runFailedParams` server-side), so the journal line reads as a
      // sentence instead of the raw `run.failed.download-failed detail=…` dump it used to be.
      const reason = p.code ? applyFailureSentence(p.code) : UNKNOWN_SENTENCE;
      return p.detail ? `update failed · ${reason} (${p.detail})` : `update failed · ${reason}`;
    }
    default: {
      const tail = Object.entries(p)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      return tail.length > 0 ? `${event.code} ${tail}` : event.code;
    }
  }
}

/**
 * A failed run's error wire → the {title, detail, hint} the hero renders.
 *
 * It used to reach for `failureSentence`, whose vocabulary is the CHECK's transport/HTTP codes —
 * none of which a run can emit — so every single run failure titled as the generic «Что-то пошло
 * не так.». Run codes have their own table (`applyFailureSentence`), shared with the journal.
 */
function runErrorToUi(error: UpdateErrorWire): { title: string; detail: string; hint: string } {
  return {
    title: applyFailureSentence(error.code),
    detail: error.raw ?? "",
    hint: "Nothing was installed — the current version is untouched. You can retry.",
  };
}

/** lastApply reasonCode → sentence — the same table the live run uses (they describe one event). */
export function lastApplyReason(reasonCode: string): string {
  return applyFailureSentence(reasonCode);
}

/**
 * The single auto-update RPC error → a toast-ready title + description.
 *
 * A CODED failure never prints its `detail`: that field is an English log line, and printing it
 * is how English prose appeared next to Russian copy. Only an UNCODED throw (a runtime/browser
 * exception, text nobody here authored) still shows its message, because there is nothing else.
 * Press refusals never reach this function at all — the hero states them inline.
 */
export function autoUpdateErrorMessage(error: { code?: string; detail: string }): {
  title: string;
  description: string;
} {
  const title = "Auto-update";
  switch (error.code) {
    // The one CLIENT-side code: the store raises it when there is no live connection to answer with
    // (autoUpdateClient.ts).
    case "not-connected":
      return { title, description: "No connection to the app — the action was not applied." };
    // ── the codes the SERVER actually attaches (updateEngineLive.ts) ─────────────
    // Every one of these used to land in `default` and, because they ARE coded, print
    // «Что-то пошло не так» with the real reason discarded — including the ones the user can act on.
    case "creds-test-failed":
      return { title, description: "The credentials did not work — the source rejected them." };
    case "creds-save-failed":
      return {
        title,
        description: "The credentials were correct but could not be saved — try again.",
      };
    case "keygen-failed":
      return { title, description: "A new key could not be generated." };
    case "key-unreadable":
      return { title, description: "That key file could not be read — check the path." };
    default:
      return {
        title,
        description:
          error.code === undefined && error.detail.length > 0 ? error.detail : UNKNOWN_SENTENCE,
      };
  }
}

// ── release / changelog ─────────────────────────────────────────────────────────

export function releaseToUi(release: AvailableReleaseWire, now: number): ReleaseInfo {
  const changelog: ChangelogVersion[] = release.changelog.map((group) => ({
    version: group.version,
    notes: group.notes.map((note) => ({
      kind: (note.kind ?? null) as NoteKind | null,
      text: note.text,
    })),
  }));
  return {
    version: release.version,
    releasedAgo: release.releasedAt !== null ? agoRu(release.releasedAt, now) : "recently",
    sizeMb: release.sizeBytes !== null ? Math.round((release.sizeBytes / 1e6) * 10) / 10 : 0,
    sha256: release.sha256,
    changelog,
    changelogTruncated: release.changelogTruncated,
  };
}

// ── source cards ──────────────────────────────────────────────────────────────

function resultToUi(result: SourceCheckResultWire, now: number): SourceResultView {
  const agoLabel = agoRu(result.at, now);
  if (result.outcome === "ok") {
    const parts = [agoLabel];
    if (result.raw !== null) parts.push(result.raw);
    if (result.latencyMs !== null) parts.push(`${result.latencyMs} ms`);
    return {
      outcome: "ok",
      agoLabel,
      raw: result.raw,
      latencyMs: result.latencyMs,
      line: parts.join(" · "),
    };
  }
  const sentence = failureSentence(result.code);
  return {
    outcome: "fail",
    agoLabel,
    class: result.class,
    code: result.code,
    sentence,
    raw: result.raw,
    latencyMs: result.latencyMs,
    line: `${agoLabel} · ${sentence}`,
  };
}

interface SourceCommonWire {
  enabled: boolean;
  offered: boolean;
  url: string;
  paused: boolean;
  authFails: number;
  transportStreak: number;
  failingSince: number | null;
  lastResult: SourceCheckResultWire | null;
  /** A request to this source is running right now (server-published, live only). */
  probing: boolean;
}

function sourceState(source: SourceCommonWire): SourceState {
  if (!source.enabled) return "disabled";
  // A request in flight outranks every settled fact: it IS what is true right now, and it is the
  // only feedback a press gets while the budget runs.
  if (source.probing) return "probing";
  if (source.paused) return "paused";
  if (source.lastResult === null) return "idle";
  if (source.lastResult.outcome === "ok") return "ok";
  if (source.lastResult.class === "answered") return "errored";
  return source.transportStreak > 3 ? "unreachable" : "retrying";
}

function healthLine(
  state: SourceState,
  lastResult: SourceResultView | null,
  failingSinceAgo: string | null,
  nextCheckClock: string | null,
): string {
  switch (state) {
    case "disabled":
      return "Turned off";
    case "idle":
      return "Not checked yet";
    case "probing":
      return "Checking the source…";
    case "ok":
      return lastResult !== null ? lastResult.line : "Working";
    case "paused":
      return "Paused — the server denied access twice. Fix it, then press «Check» to resume.";
    case "errored":
      return lastResult !== null && lastResult.outcome === "fail"
        ? lastResult.sentence
        : "The source answered with an error.";
    // «keeps trying» / «will retry» are PROMISES, and with auto-check off nothing will keep them:
    // the server schedules no tick at all (`nextCheckAt` is null, which is exactly what makes
    // `nextCheckClock` null here), so only a manual press can move this source. The card states
    // what is true instead — the rest of this zone is explicit about not making claims like that.
    case "unreachable":
      if (nextCheckClock === null) {
        return failingSinceAgo !== null
          ? `Unreachable for ${failingSinceAgo}.`
          : "Unreachable right now.";
      }
      return failingSinceAgo !== null
        ? `Unreachable for ${failingSinceAgo} — ${APP_NAME} keeps trying.`
        : `Unreachable — ${APP_NAME} keeps trying.`;
    case "retrying":
      // Static by design (F17): no spinner, no «checking…» — just when the next attempt lands.
      return nextCheckClock !== null
        ? `No connection — will retry at ${nextCheckClock}.`
        : "No connection.";
    default:
      return "";
  }
}

function commonSourceView(source: SourceCommonWire, now: number, nextCheckClock: string | null) {
  const state = sourceState(source);
  const lastResult = source.lastResult !== null ? resultToUi(source.lastResult, now) : null;
  const failingSinceAgo = source.failingSince !== null ? agoRu(source.failingSince, now) : null;
  return {
    enabled: source.enabled,
    offered: source.offered,
    url: source.url,
    paused: source.paused,
    authFails: source.authFails,
    transportStreak: source.transportStreak,
    failingSinceAgo,
    lastResult,
    healthLine: healthLine(state, lastResult, failingSinceAgo, nextCheckClock),
    // `probing` is the request, not its answer — the previous verdict stands (same principle
    // as the card's settleHealth). Without this, every check flipped `working` off for its
    // duration, and the settings page mounted the WHOLE sources section mid-check and
    // unmounted it when the round settled ok (production-error.md §4).
    working: state === "ok" || (state === "probing" && source.lastResult?.outcome === "ok"),
    // A check reaches exactly the sources the server's round reaches: offered, on, not paused.
    checkable: source.offered && source.enabled && !source.paused,
    state,
  };
}

function gitToUi(git: GitSourceWire, now: number, nextCheckClock: string | null): GitSourceView {
  return {
    kind: "git",
    ...commonSourceView(git, now, nextCheckClock),
    authVia: git.authVia,
    httpsCred:
      git.httpsCred !== null
        ? { username: git.httpsCred.username, savedAgo: agoRu(git.httpsCred.savedAt, now) }
        : null,
    sshCred:
      git.sshCred !== null
        ? {
            fingerprint: git.sshCred.fingerprint,
            keyType: git.sshCred.keyType,
            savedAgo: agoRu(git.sshCred.savedAt, now),
            origin: git.sshCred.origin,
          }
        : null,
  };
}

function webToUi(web: WebSourceWire, now: number, nextCheckClock: string | null): WebSourceView {
  return {
    kind: "web",
    ...commonSourceView(web, now, nextCheckClock),
    cred:
      web.cred !== null
        ? { username: web.cred.username, savedAgo: agoRu(web.cred.savedAt, now) }
        : null,
  };
}

// ── history ────────────────────────────────────────────────────────────────────

function sourceLabel(source: UpdateSourceKind): string {
  return source === "web" ? "manifest.json" : "git ls-remote";
}

function historyDetail(entry: CheckEntryWire): string {
  const label = sourceLabel(entry.source);
  switch (entry.result) {
    case "update":
      return `${label} · found v${entry.version ?? "?"}`;
    case "up-to-date":
      return `${label} · v${entry.version ?? "?"} — latest`;
    case "error":
      return entry.raw !== null ? entry.raw : "check failed";
    default:
      return label;
  }
}

function historyToUi(history: ReadonlyArray<CheckEntryWire>, now: number): CheckEntry[] {
  return history.map((entry) => ({
    at: atRu(entry.at, now),
    atMs: entry.at,
    source: entry.source,
    latencyMs: entry.latencyMs,
    result: entry.result,
    detail: historyDetail(entry),
  }));
}

// ── run / lastApply ─────────────────────────────────────────────────────────────

function runToUi(run: UpdateRunWire): UpdateRun {
  const log: RunLogLine[] = run.log.map((event) => ({
    time: timeHms(event.at),
    tone: event.tone,
    text: runLogText(event),
  }));
  // When the restart began, from the `run.restart` event the engine already logs — no new wire
  // field, and the hero and the driver measure from one instant. It stays a RAW timestamp: during
  // the blind window no snapshot arrives, so anything pre-computed here would freeze on screen.
  const restartedAtMs =
    run.phase === "restart"
      ? (run.log.findLast((event) => event.code === "run.restart")?.at ?? null)
      : null;
  return {
    targetVersion: run.targetVersion,
    fromVersion: run.fromVersion,
    phase: runPhaseToView(run.phase),
    phaseLabel: runPhaseLabel(run.phase),
    pct: run.pct,
    log,
    restartedAtMs,
    error: run.error !== null ? runErrorToUi(run.error) : null,
  };
}

function lastApplyToUi(lastApply: LastApplyWire, now: number): LastApplyView {
  const known =
    lastApply.reasonCode !== null && lastApplyReason(lastApply.reasonCode) !== UNKNOWN_SENTENCE;
  return {
    targetVersion: lastApply.targetVersion,
    fromVersion: lastApply.fromVersion,
    outcome: lastApply.outcome,
    reason: lastApply.reasonCode !== null ? lastApplyReason(lastApply.reasonCode) : null,
    reasonRaw: lastApply.reasonCode !== null && !known ? lastApply.reasonCode : null,
    atLabel: atRu(lastApply.at, now),
  };
}

// ── hero composition ─────────────────────────────────────────────────────────────

function statusFromWire(status: UpdateHeroStatusWire, now: number): HeroStatus {
  switch (status.phase) {
    case "never-checked":
      return { phase: "never-checked" };
    case "up-to-date":
      return { phase: "up-to-date", lastCheckedAgo: agoRu(status.lastCheckedAt, now) };
    // NOT dead: this server does not emit a `checking` hero any more (the in-flight fact is its own
    // wire field, so a background round cannot blank an advertised release) — but during an update
    // an already-open tab briefly talks to the OUTGOING server, which does. Deleting this arm would
    // render those seconds as «Проверок ещё не было».
    case "checking":
      return { phase: "checking" };
    case "available":
      return { phase: "available", release: releaseToUi(status.release, now) };
    case "attention":
      return { phase: "attention", attention: attentionView(status.code) };
    default:
      return { phase: "never-checked" };
  }
}

/**
 * Has a check SETTLED OK since the failed apply the journal records? That is the moment the red
 * hero stops being the truth of now: the app asked its sources after the failure and they answered,
 * so whatever went wrong is no longer what the user is looking at. The journal, the history and
 * /healthz keep the record — only the hero moves on.
 *
 * Without this the `apply-failed` hero was sticky for the whole process lifetime: `lastApply` is
 * written once, at boot, and nothing ever cleared it, so a single failed apply painted the settings
 * page destructive-red on every visit until the server was restarted — even after a successful
 * check proved the app was up to date.
 */
function checkedSinceApply(wire: AutoUpdateWireState, lastApply: LastApplyView | null): boolean {
  if (lastApply === null) return false;
  const at = wire.lastApply?.at ?? null;
  if (at === null) return false;
  const okAt = (result: SourceCheckResultWire | null): number | null =>
    result !== null && result.outcome === "ok" ? result.at : null;
  const git = okAt(wire.git.lastResult);
  const web = okAt(wire.web.lastResult);
  const newest = git === null ? web : web === null ? git : Math.max(git, web);
  return newest !== null && newest > at;
}

/**
 * Compose the hero from run + lastApply + wire status. A live run wins; then a run that FAILED;
 * then an available update; then a failed apply (Повторить) that no later check has answered;
 * otherwise the mapped wire status.
 *
 * The run branch is split for a reason: the server keeps the run object after `failRun`, so
 * `run !== null ⇒ running` reported a dead run as live work — a spinner, «Приложение перезапустится
 * само», no reason and no button, surviving F5 because the run is SERVER state. `running` now means
 * exactly what it says; `run-failed` carries the error the wire has been sending all along.
 *
 * There is no `checking` branch any more. A check no longer replaces the hero at all: the wire
 * carries it as its own flag, because a background tick used to blank «Доступна vX» — release notes
 * unmounted, sidebar pill gone — for the whole round, which is the opposite of what this hero is
 * documented to do.
 */
function heroToUi(
  wire: AutoUpdateWireState,
  run: UpdateRun | null,
  lastApply: LastApplyView | null,
  now: number,
): HeroStatus {
  if (run !== null)
    return run.phase === "failed" ? { phase: "run-failed", run } : { phase: "running", run };
  if (wire.status.phase === "available")
    return { phase: "available", release: releaseToUi(wire.status.release, now) };
  if (lastApply !== null && lastApply.outcome === "failed" && !checkedSinceApply(wire, lastApply))
    return { phase: "apply-failed", lastApply };
  return statusFromWire(wire.status, now);
}

/**
 * The install-possible verdict the server computed at boot → a sentence. `layout` means the app was
 * not started through the installed launcher (a dev checkout, a hand-run bundle); `read-only` means
 * the install directory belongs to someone else (a system-wide install).
 */
function applyBlockedToUi(facts: AutoUpdateWireState["facts"]): ApplyBlockedView | null {
  if (facts.canApply || facts.blockReason === null) return null;
  return facts.blockReason === "read-only"
    ? {
        reason: "read-only",
        note: "This copy cannot update itself: the install folder is not writable by this user. Reinstall it under your own account.",
      }
    : {
        reason: "layout",
        note: "This copy cannot update itself: it was not started through the installed launcher. Updates apply to an installed copy only.",
      };
}

/**
 * A refused press → the sentence the hero shows inline, plus WHICH action answers it. Returns null
 * for a code that is not a refusal at all, which is also how the store knows a rejected `install`
 * promise is already stated on screen and needs no toast on top of it.
 *
 * The cases are exactly the codes `refusePress` emits (updateEngineLive.ts) and nothing else: an
 * `invalid-manifest` case lived here for a while, duplicating a sentence that already exists above
 * for a code no press can be refused with.
 *
 * `sentence` is composed here from the code and its params (the wire carries neither prose nor
 * localized text); `raw` is machine evidence the server attached — a path, a URL — or null.
 */
export function pressRefusalToUi(
  refusal: AutoUpdateWireState["pressRefusal"],
): PressRefusalView | null {
  if (refusal === null) return null;
  const p = refusal.params;
  switch (refusal.code) {
    case "no-update":
      return {
        code: refusal.code,
        sentence: "There is nothing newer to install right now.",
        raw: refusal.raw,
        action: "install",
      };
    // The honest counterpart of «nothing newer»: NOBODY answered. Reporting this as "nothing
    // newer" is what pinned the user to a stale release while the release host was down.
    case "sources-unreachable":
      return {
        code: refusal.code,
        sentence: "No update source answered — the release could not be confirmed.",
        raw: refusal.raw,
        action: "check",
      };
    case "node-too-old":
      return {
        code: refusal.code,
        sentence:
          p.required && p.running
            ? `This version needs Node.js ${p.required}; this machine runs ${p.running}.`
            : "The installed Node.js is too old for this version.",
        raw: refusal.raw,
        action: "install",
      };
    case "not-updatable":
      return {
        code: refusal.code,
        sentence:
          "This copy cannot update itself: it was not started through the installed launcher.",
        raw: refusal.raw,
        action: "install",
      };
    case "read-only":
      return {
        code: refusal.code,
        sentence:
          "This copy cannot update itself: the install folder is not writable by this user.",
        raw: refusal.raw,
        action: "install",
      };
    default:
      return null;
  }
}

/** The hero-facing view of whatever the server refused, generic fallback included. */
function pressRefusalView(refusal: AutoUpdateWireState["pressRefusal"]): PressRefusalView | null {
  if (refusal === null) return null;
  return (
    pressRefusalToUi(refusal) ?? {
      code: refusal.code,
      sentence: UNKNOWN_SENTENCE,
      raw: refusal.raw,
      action: "install",
    }
  );
}

/** True for a code the settings hero already states inline — the store must not also toast it. */
export function isPressRefusalCode(code: string | undefined): boolean {
  return code !== undefined && pressRefusalToUi({ code, raw: null, params: {} }) !== null;
}

// ── the whole mapping ─────────────────────────────────────────────────────────

/** Turn one wire snapshot into the component-facing UI state (fully localized). */
export function wireToUi(wire: AutoUpdateWireState, now: number): AutoUpdateUiState {
  const run = wire.run !== null ? runToUi(wire.run) : null;
  // Shared by the hero strip and the source cards: the wall-clock of the next scheduled attempt.
  const nextCheckClock =
    wire.autoCheck && wire.nextCheckAt !== null ? clockHm(wire.nextCheckAt) : null;
  const lastApply = wire.lastApply !== null ? lastApplyToUi(wire.lastApply, now) : null;
  const release = wire.status.phase === "available" ? releaseToUi(wire.status.release, now) : null;
  return {
    currentVersion: wire.currentVersion,
    applyBlocked: applyBlockedToUi(wire.facts),
    installDir: wire.facts.installDir,
    entryPoint: `${wire.facts.entryJs} · pid ${wire.facts.pid} · port ${wire.facts.port}`,
    address: wire.facts.address,
    autoCheck: wire.autoCheck,
    nextCheckIn: wire.autoCheck && wire.nextCheckAt !== null ? inRu(wire.nextCheckAt, now) : null,
    nextCheckClock,
    git: gitToUi(wire.git, now, nextCheckClock),
    web: webToUi(wire.web, now, nextCheckClock),
    status: heroToUi(wire, run, lastApply, now),
    history: historyToUi(wire.history, now),
    run,
    lastApply,
    release,
    notify: { releasesMuted: wire.notify.releasesMuted, problemsMuted: wire.notify.problemsMuted },
    notified: wire.notified,
    pressRefusal: pressRefusalView(wire.pressRefusal),
    // A server fact of its own, not a hero phase — see `heroToUi`. Absent on a server older than
    // this field (an open tab mid-update talks to both).
    checking: wire.checking ?? false,
    // Absent on a server older than this field (an open tab mid-update talks to both).
    pressInFlight: wire.pressInFlight ?? false,
  };
}
