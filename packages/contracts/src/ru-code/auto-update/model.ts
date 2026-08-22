// ru-code: Wire model for the in-app auto-update feature (v3 — stateless check
// machine + pointer/wrapper apply). Shared by the server engine and the web
// client so both sides decode/encode byte-identically.
//
// Localization invariant: the wire carries MACHINE DATA ONLY — enums, codes,
// versions, epoch timestamps, raw technical fragments (e.g. "ETIMEDOUT",
// "401 Unauthorized"). Every human sentence is derived client-side from these
// codes via the dictionary. No display strings ride this wire.
//
// Product invariants encoded here (ratified design — see to-do.md):
//   · source links are BAKED constants (@ru-code/branding) — no URL is ever
//     user-writable; only credentials are configurable
//   · priority git → web; the first source that answers wins a tick
//   · failures are classified by EVIDENCE: `transport` (the request never
//     completed — offline/VPN/filtered, always silent) vs `answered` (the real
//     server replied and the reply is wrong — actionable)
//   · two auth rejections pause a source (persisted, zero traffic) until the
//     user re-credentials or a manual probe succeeds — lockout guard
//   · installing is ALWAYS a user press; there is NO auto-download and NO
//     rollback (recovery = reinstall); secrets never ride the wire

import * as Schema from "effect/Schema";

// ── sources ──────────────────────────────────────────────────────────────────

/** Priority order is git first, web second (user decision). */
export const UpdateSourceKind = Schema.Literals(["git", "web"]);
export type UpdateSourceKind = typeof UpdateSourceKind.Type;

/**
 * `transport` — the request never completed (DNS, timeout, refused/reset, no
 * route, TLS drop, middlebox block pages). Indistinguishable from "no internet"
 * by design, therefore silent. `answered` — the real server replied and the
 * reply is wrong (4xx, invalid manifest, git access denial) — actionable.
 */
export const UpdateFailureClass = Schema.Literals(["transport", "answered"]);
export type UpdateFailureClass = typeof UpdateFailureClass.Type;

/** Machine failure code; the client maps it to a localized sentence. */
export const UpdateFailureCode = Schema.Literals([
  // transport class
  "dns",
  "timeout",
  "refused",
  "reset",
  "no-route",
  "tls",
  /** The reply's shape was wrong for the protocol (HTML where JSON expected) — a middlebox, not our server. */
  "blocked-shape",
  "transport-other",
  // answered class
  "http-401",
  "http-403",
  "http-404",
  /** Any other non-2xx status; the raw fragment carries the actual code. */
  "http-status",
  "invalid-manifest",
  "git-not-found",
  "git-access-denied",
  "release-download-failed",
]);
export type UpdateFailureCode = typeof UpdateFailureCode.Type;

/**
 * Every code a press can be REFUSED with, before any run exists. Named here, in the contract, so
 * the three places that must agree cannot drift: the engine's `refusePress` call sites, the
 * client's sentence table (`pressRefusalToUi`), and the test that pins the two together.
 *
 * It was a hand-maintained array inside that test, and it had already gone wrong in both
 * directions — it listed `invalid-manifest`, which is a check failure code and not a refusal at
 * all, while nothing linked it to the engine, so a NEW refusal code would have shipped with no
 * sentence and no failing test. Deliberately a plain tuple rather than a Schema: refusals travel
 * as `UpdateErrorWire.code` (an open string) precisely so an older client renders an unknown code
 * through its generic fallback instead of failing to decode the whole snapshot.
 */
export const UPDATE_PRESS_REFUSAL_CODES = [
  "not-updatable",
  "read-only",
  "no-update",
  "sources-unreachable",
  "node-too-old",
] as const;
export type UpdatePressRefusalCode = (typeof UPDATE_PRESS_REFUSAL_CODES)[number];

/** The most recent completed probe/check touch of a source. */
export const SourceCheckResultWire = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(["ok"]),
    /** Epoch milliseconds. */
    at: Schema.Number,
    latencyMs: Schema.NullOr(Schema.Number),
    /** Raw technical fragment ("200 OK", "ls-remote OK"). */
    raw: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.Literals(["fail"]),
    at: Schema.Number,
    class: UpdateFailureClass,
    code: UpdateFailureCode,
    latencyMs: Schema.NullOr(Schema.Number),
    /** Raw technical fragment ("ETIMEDOUT", "401 Unauthorized", "Permission denied (publickey)"). */
    raw: Schema.NullOr(Schema.String),
  }),
]);
export type SourceCheckResultWire = typeof SourceCheckResultWire.Type;

/** How the git source authenticates. `ambient` = no stored creds, the host's own ~/.ssh keys. */
export const GitAuthVia = Schema.Literals(["ambient", "https", "ssh"]);
export type GitAuthVia = typeof GitAuthVia.Type;

/** Non-secret user/password credential metadata (the password never rides the wire). */
export const UserPassCredMeta = Schema.Struct({
  username: Schema.String,
  /** Epoch milliseconds when saved. */
  savedAt: Schema.Number,
});
export type UserPassCredMeta = typeof UserPassCredMeta.Type;

export const SshKeyOrigin = Schema.Literals(["paste", "generate", "file"]);
export type SshKeyOrigin = typeof SshKeyOrigin.Type;

/** Non-secret SSH credential metadata (the private key never rides the wire). */
export const SshCredMeta = Schema.Struct({
  fingerprint: Schema.String,
  keyType: Schema.Literals(["ed25519"]),
  savedAt: Schema.Number,
  origin: SshKeyOrigin,
});
export type SshCredMeta = typeof SshCredMeta.Type;

const sourceCommonFields = {
  /** USER-owned switch. The engine never changes it. */
  enabled: Schema.Boolean,
  /** False when the build bakes no link for this source — the card is not shown. */
  offered: Schema.Boolean,
  /** The baked link the source currently resolves to (read-only display/diagnostics). */
  url: Schema.String,
  /**
   * Two auth rejections paused the source: ZERO traffic until credentials are
   * re-saved (test-before-save) or a manual probe succeeds. Persisted.
   */
  paused: Schema.Boolean,
  /** Consecutive auth rejections (pauses at 2). */
  authFails: Schema.Number,
  /** Consecutive transport-class failures (escalates presentation above 3; self-clears on success). */
  transportStreak: Schema.Number,
  /** Epoch ms of the first failure of the current unbroken failure streak; null when healthy. */
  failingSince: Schema.NullOr(Schema.Number),
  lastResult: Schema.NullOr(SourceCheckResultWire),
  /**
   * A request to THIS source is in flight right now. Live state, never persisted.
   *
   * It exists because a press with no visible answer is indistinguishable from a broken button: the
   * per-source «Проверить» could spend the whole probe budget with the card showing exactly what it
   * showed before, so users pressed it again and again. The card's `probing` health is driven by
   * this and by nothing else — it must be set only while a request is genuinely running.
   */
  probing: Schema.Boolean,
} as const;

export const GitSourceWire = Schema.Struct({
  ...sourceCommonFields,
  authVia: GitAuthVia,
  httpsCred: Schema.NullOr(UserPassCredMeta),
  sshCred: Schema.NullOr(SshCredMeta),
});
export type GitSourceWire = typeof GitSourceWire.Type;

export const WebSourceWire = Schema.Struct({
  ...sourceCommonFields,
  /** Optional basic-auth metadata. */
  cred: Schema.NullOr(UserPassCredMeta),
});
export type WebSourceWire = typeof WebSourceWire.Type;

// ── releases & changelog ─────────────────────────────────────────────────────

/** One changelog entry. `kind` maps to a colored badge; null = plain text, no badge. */
export const ReleaseNoteWire = Schema.Struct({
  kind: Schema.NullOr(Schema.Literals(["feat", "fix", "perf", "ui"])),
  /** User-authored text from changelog.json — passed through verbatim (already in the author's language). */
  text: Schema.String,
});
export type ReleaseNoteWire = typeof ReleaseNoteWire.Type;

/** Changelog entries for one version, newest-first in the surrounding array. */
export const ChangelogVersionWire = Schema.Struct({
  version: Schema.String,
  notes: Schema.Array(ReleaseNoteWire),
});
export type ChangelogVersionWire = typeof ChangelogVersionWire.Type;

/** The newest release found by a check. Persisted server-side — survives restarts. */
export const AvailableReleaseWire = Schema.Struct({
  version: Schema.String,
  /** Epoch milliseconds; null if the manifest lacks it. */
  releasedAt: Schema.NullOr(Schema.Number),
  sizeBytes: Schema.NullOr(Schema.Number),
  sha256: Schema.String,
  /** Accumulated entries for every version > current, newest first, capped (~10 versions). */
  changelog: Schema.Array(ChangelogVersionWire),
  /** True when older entries were dropped by the cap. */
  changelogTruncated: Schema.Boolean,
  /** Epoch milliseconds the release was first seen by a check. */
  foundAt: Schema.Number,
});
export type AvailableReleaseWire = typeof AvailableReleaseWire.Type;

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Why the hero needs attention. `sources-off` — nothing offered/enabled;
 * `needs-setup` — a source is paused or answered-wrong (points at the card);
 * `unreachable` — only transport streaks (quiet copy, no alarm).
 */
export const UpdateAttentionCode = Schema.Literals(["sources-off", "needs-setup", "unreachable"]);
export type UpdateAttentionCode = typeof UpdateAttentionCode.Type;

export const UpdateHeroStatusWire = Schema.Union([
  /** Fresh install: auto-check armed, nothing has completed yet. */
  Schema.Struct({ phase: Schema.Literals(["never-checked"]) }),
  Schema.Struct({
    phase: Schema.Literals(["up-to-date"]),
    /** Epoch milliseconds of the last successful check. */
    lastCheckedAt: Schema.Number,
  }),
  /**
   * No longer EMITTED — a check publishes `checking` as its own field on the state instead, because
   * this hero status is where the advertised release lives and replacing it blanked «Доступна vX»
   * for the whole round. Kept in the union for decode compatibility: during an update an open tab
   * briefly talks to the outgoing server, which still sends this.
   */
  Schema.Struct({ phase: Schema.Literals(["checking"]) }),
  Schema.Struct({ phase: Schema.Literals(["available"]), release: AvailableReleaseWire }),
  Schema.Struct({ phase: Schema.Literals(["attention"]), code: UpdateAttentionCode }),
]);
export type UpdateHeroStatusWire = typeof UpdateHeroStatusWire.Type;

// ── check history ────────────────────────────────────────────────────────────

export const CheckResult = Schema.Literals(["up-to-date", "update", "error"]);
export type CheckResult = typeof CheckResult.Type;

export const CheckEntryWire = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Number,
  source: UpdateSourceKind,
  latencyMs: Schema.NullOr(Schema.Number),
  result: CheckResult,
  /** The version involved: found version for `update`, current for `up-to-date`, null for `error`. */
  version: Schema.NullOr(Schema.String),
  /** Raw technical fragment for `error` rows ("ETIMEDOUT", "401 Unauthorized"). */
  raw: Schema.NullOr(Schema.String),
});
export type CheckEntryWire = typeof CheckEntryWire.Type;

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * Machine error surfaced on a failed run / RPC. `code` is a stable machine tag
 * the client maps to a localized sentence (unknown codes render generic copy).
 *
 * `raw` is EVIDENCE and nothing else — a fragment produced by someone other than
 * this app (`ETIMEDOUT`, `HTTP 404`, a path, a sha prefix, a version range), shown
 * verbatim in mono because translating it would destroy what support needs. An
 * authored sentence must NEVER travel here: that is what put an English line under
 * the Russian one on the settings hero. When there is no evidence to add, `raw` is
 * null and the code's sentence stands alone.
 *
 * `params` carries the dynamic fragments the client interpolates INTO that localized
 * sentence (mirrors `UpdateRunLogEventWire.params`), so a sentence that needs values
 * still composes on the client — the single localization boundary.
 */
export const UpdateErrorWire = Schema.Struct({
  code: Schema.String,
  raw: Schema.NullOr(Schema.String),
  params: Schema.Record(Schema.String, Schema.String),
});
export type UpdateErrorWire = typeof UpdateErrorWire.Type;

// ── install run (drives /updating) ───────────────────────────────────────────

/**
 * `download` → `verify` (sha256 + per-file checksums) → `flip` (extract +
 * pointer write) → `restart` (detached `cli.js restart` spawned; this server is
 * about to die — the SW page takes over). `failed` is terminal; nothing was
 * flipped unless the log says otherwise.
 */
export const UpdateRunPhase = Schema.Literals(["download", "verify", "flip", "restart", "failed"]);
export type UpdateRunPhase = typeof UpdateRunPhase.Type;

export const UpdateRunLogTone = Schema.Literals(["dim", "ok", "act", "warn", "err"]);
export type UpdateRunLogTone = typeof UpdateRunLogTone.Type;

/**
 * One structured run-log event. `code` is a stable machine tag the client maps
 * to a localized template; `params` carries the dynamic fragments (sizes, sha
 * prefixes, ports). Unknown codes render as `code` + params — never dropped.
 */
export const UpdateRunLogEventWire = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Number,
  tone: UpdateRunLogTone,
  code: Schema.String,
  params: Schema.Record(Schema.String, Schema.String),
});
export type UpdateRunLogEventWire = typeof UpdateRunLogEventWire.Type;

export const UpdateRunWire = Schema.Struct({
  targetVersion: Schema.String,
  fromVersion: Schema.String,
  phase: UpdateRunPhase,
  /** 0..100 within the download; 0 outside it. */
  pct: Schema.Number,
  log: Schema.Array(UpdateRunLogEventWire),
  error: Schema.NullOr(UpdateErrorWire),
});
export type UpdateRunWire = typeof UpdateRunWire.Type;

// ── last apply (journal, read at boot; also in /healthz) ─────────────────────

export const LastApplyWire = Schema.Struct({
  targetVersion: Schema.String,
  fromVersion: Schema.String,
  outcome: Schema.Literals(["ok", "failed"]),
  /** Machine reason for `failed` (maps to localized copy); null on `ok`. */
  reasonCode: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  at: Schema.Number,
});
export type LastApplyWire = typeof LastApplyWire.Type;

// ── notifications ────────────────────────────────────────────────────────────

export const UpdateNotifyPrefsWire = Schema.Struct({
  /** Mute «Доступна новая версия». */
  releasesMuted: Schema.Boolean,
  /** Mute «Настройте обновления» (updates-impossible). */
  problemsMuted: Schema.Boolean,
});
export type UpdateNotifyPrefsWire = typeof UpdateNotifyPrefsWire.Type;

/** The two notices that own a quiet-until stamp. */
export const UpdateNotifyKind = Schema.Literals(["release", "problems"]);
export type UpdateNotifyKind = typeof UpdateNotifyKind.Type;

/**
 * The server-owned "already told them" stamps — the ONLY re-raise clock (there is no client
 * storage of any kind behind the notifications). A stamp is written both when a notice is RAISED
 * and when the user waves it away: either way the surface goes quiet until
 * `UPDATE_NOTIFY_RERAISE_MS` has passed, and every tab agrees because the record is one server
 * fact. Persisted with the config, so a restart does not re-nag.
 *
 * `release` carries the version it was raised for: a NEWER release clears the stamp server-side,
 * so a genuinely new version is announced immediately instead of inheriting the old quiet window.
 */
export const UpdateNotifiedWire = Schema.Struct({
  release: Schema.NullOr(Schema.Struct({ version: Schema.String, at: Schema.Number })),
  problems: Schema.NullOr(Schema.Struct({ at: Schema.Number })),
});
export type UpdateNotifiedWire = typeof UpdateNotifiedWire.Type;

// ── environment facts (hero facts strip / dev details) ───────────────────────

/**
 * Why this installation cannot apply an update. `layout` — it was not installed through the
 * wrapper (a dev checkout, a hand-run bundle); `read-only` — the install directory cannot be
 * written by this process (a system-wide install running as a normal user).
 */
export const UpdateBlockReason = Schema.Literals(["layout", "read-only"]);
export type UpdateBlockReason = typeof UpdateBlockReason.Type;

export const UpdateEnvFactsWire = Schema.Struct({
  installDir: Schema.String,
  entryJs: Schema.String,
  pid: Schema.Number,
  port: Schema.Number,
  /** "host:port" the app is reachable at. */
  address: Schema.String,
  /** Whether an install run is possible here at all — the UI states it instead of failing a press. */
  canApply: Schema.Boolean,
  /** Present exactly when `canApply` is false. */
  blockReason: Schema.NullOr(UpdateBlockReason),
});
export type UpdateEnvFactsWire = typeof UpdateEnvFactsWire.Type;

// ── the full state pushed to the client ──────────────────────────────────────

export const AutoUpdateWireState = Schema.Struct({
  currentVersion: Schema.String,
  facts: UpdateEnvFactsWire,
  /** The on/off switch (replaces the old frequency dropdown). */
  autoCheck: Schema.Boolean,
  /** Epoch ms of the next scheduled tick; null when autoCheck is off. */
  nextCheckAt: Schema.NullOr(Schema.Number),
  git: GitSourceWire,
  web: WebSourceWire,
  status: UpdateHeroStatusWire,
  history: Schema.Array(CheckEntryWire),
  run: Schema.NullOr(UpdateRunWire),
  lastApply: Schema.NullOr(LastApplyWire),
  notify: UpdateNotifyPrefsWire,
  /** When each notice was last shown or waved away — the quiet-until clock. */
  notified: UpdateNotifiedWire,
  /**
   * The last press the engine REFUSED before any run started (nothing newer to install, the host
   * node is too old, the layout cannot be written…). Server-owned so the settings hero can state it
   * inline — with a retry — instead of the press dying in a toast the user may never see. Cleared
   * the moment a run starts or a check settles.
   */
  pressRefusal: Schema.NullOr(UpdateErrorWire),
  /**
   * A press the server has ACCEPTED and is still working on, before any run exists — the install
   * re-resolves both sources first, which is a full source round.
   *
   * Server-owned on purpose. The client used to disable the button on the CLICK and needed a
   * wall-clock watchdog in case the release never arrived; a fact that is set before the resolve
   * and cleared by a finalizer on every exit (refused, run started, defect, interrupt) leaves the
   * client nothing to guess and nothing to time out. It is in-memory only, exactly like `run`, so a
   * server that dies cannot come back with a button stuck down.
   *
   * Optional with a `false` default: during an update an already-open tab briefly talks to the new
   * server (and vice versa), and a required field would fail that decode.
   */
  pressInFlight: Schema.optional(Schema.Boolean),
  /**
   * A check round is in flight RIGHT NOW. Its own field — NOT a hero phase — because a background
   * tick must not displace what the hero knows (`checkStarted` used to replace an `available`
   * status with `checking`, so every scheduled check blanked «Доступна vX», unmounted the release
   * notes and hid the sidebar pill for the whole round). The hero keeps stating the last verdict;
   * this flag is what quiets the buttons while the server works.
   *
   * Optional with a `false` default for the same reason as `pressInFlight`: an open tab briefly
   * talks to both servers during an update, and a required field would fail that decode.
   */
  checking: Schema.optional(Schema.Boolean),
});
export type AutoUpdateWireState = typeof AutoUpdateWireState.Type;

// ── command payloads ─────────────────────────────────────────────────────────

/** Plaintext user/password input (never returned; wire-in only). Used for git-https AND web basic auth. */
export const UserPassCredentialsInput = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
});
export type UserPassCredentialsInput = typeof UserPassCredentialsInput.Type;

/**
 * Which key the SSH test/save should use. `paste` carries the PEM (wire-in
 * only, stored to a 0600 file server-side); `generate` uses the key the server
 * generated this session; `file` points at an existing key on the server host.
 */
export const SshKeySourceInput = Schema.Union([
  Schema.Struct({ origin: Schema.Literals(["paste"]), privateKeyPem: Schema.String }),
  Schema.Struct({ origin: Schema.Literals(["generate"]) }),
  Schema.Struct({ origin: Schema.Literals(["file"]), path: Schema.String }),
]);
export type SshKeySourceInput = typeof SshKeySourceInput.Type;

/** Result of a non-persisting credential test (exactly one attempt; the wizard's test-before-save). */
export const CredentialTestResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Failure classification; both null when `ok`. */
  class: Schema.NullOr(UpdateFailureClass),
  code: Schema.NullOr(UpdateFailureCode),
  latencyMs: Schema.NullOr(Schema.Number),
  /** Raw technical fragment for display ("401", "Permission denied (publickey)"). */
  raw: Schema.NullOr(Schema.String),
});
export type CredentialTestResult = typeof CredentialTestResult.Type;

/** Result of generating a deploy key server-side (private key stays on disk, 0600). */
export const GeneratedSshKeyInfo = Schema.Struct({
  publicKey: Schema.String,
  fingerprint: Schema.String,
  /** Absolute path the key was written to (shown in dev details). */
  path: Schema.String,
});
export type GeneratedSshKeyInfo = typeof GeneratedSshKeyInfo.Type;

/** The single error type for every auto-update RPC. `code` = optional machine tag for localized copy. */
export class AutoUpdateError extends Schema.TaggedErrorClass<AutoUpdateError>()("AutoUpdateError", {
  detail: Schema.String,
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}
