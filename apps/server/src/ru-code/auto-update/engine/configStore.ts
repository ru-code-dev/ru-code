// ru-code: persisted auto-update user config, schema v3 (the stateless check
// machine). Holds ONLY non-secret, USER- or ENGINE-owned state: the auto-check
// switch, the per-install jitter minute, per-source health counters, the last
// found release, the notification quiet-until stamps and the two mutes. Secrets
// (passwords, PEM keys) stay in the SEPARATE encrypted credential file store —
// never here; this file never sees a secret and never persists cred metadata
// (fingerprints/usernames live redacted in the credential store's presence view,
// re-read at boot). Stored as JSON in the server state dir so it survives the
// version swap. Atomic write (tmp + rename), serialized through a semaphore, and
// defensively decoded field-by-field — a corrupt file degrades to fresh
// defaults, never crashes. The decoder MIGRATES older shapes forward: the v1
// cadence-dropdown / install-policy / channel-URL era (carrying over the
// per-source enabled switches) and the v2 single `releaseDismissedAt` number
// (which becomes the v3 release stamp — see decodeNotified). A migrated or
// jitter-less file is persisted back on first load, so the jitter is generated
// exactly once and the new shape lands on disk immediately.
// @effect-diagnostics preferSchemaOverJson:off

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import type {
  AvailableReleaseWire,
  ChangelogVersionWire,
  ReleaseNoteWire,
  SourceCheckResultWire,
  UpdateFailureClass,
  UpdateFailureCode,
  UpdateNotifiedWire,
} from "@t3tools/contracts";

// ru-code: the jitter range is a branding tunable — see ru-code/branding/src/auto-update.ts.
import { UPDATE_JITTER_MINUTES } from "@ru-code/branding";

// ── the v3 config shape ────────────────────────────────────────────────────────

/** Per-source persisted health + switch. `enabled` is USER-owned; the rest is engine-written. */
export interface SourceConfig {
  readonly enabled: boolean;
  /** Two auth rejections paused the source (zero traffic until re-credentialed or a manual probe succeeds). */
  readonly paused: boolean;
  /** Consecutive auth rejections; pauses at 2. */
  readonly authFails: number;
  /** Consecutive transport-class failures; escalates presentation above 3, self-clears on success. */
  readonly transportStreak: number;
  /** Epoch ms of the first failure of the current unbroken streak; null when healthy. */
  readonly failingSince: number | null;
  readonly lastResult: SourceCheckResultWire | null;
}

export interface AutoUpdateConfig {
  readonly configVersion: 3;
  /** The on/off switch (replaces the retired v1 cadence dropdown). */
  readonly autoCheck: boolean;
  /** Per-install jitter minute in [0, UPDATE_JITTER_MINUTES - 1], generated once and persisted. */
  readonly jitterMinute: number;
  readonly sources: {
    readonly git: SourceConfig;
    readonly web: SourceConfig;
  };
  /** Newest release found by a check (wire shape); survives restarts. */
  readonly availableRelease: AvailableReleaseWire | null;
  /** When each notice was last shown or waved away — the server-owned quiet-until clock (v3). */
  readonly notified: UpdateNotifiedWire;
  readonly notify: {
    readonly releasesMuted: boolean;
    readonly problemsMuted: boolean;
  };
}

const DEFAULT_SOURCE: SourceConfig = {
  enabled: true,
  paused: false,
  authFails: 0,
  transportStreak: 0,
  failingSince: null,
  lastResult: null,
};

/** The fresh-install config for a freshly generated jitter minute. */
export function defaultConfig(jitterMinute: number): AutoUpdateConfig {
  return {
    configVersion: 3,
    autoCheck: true,
    jitterMinute,
    sources: { git: DEFAULT_SOURCE, web: DEFAULT_SOURCE },
    availableRelease: null,
    notified: { release: null, problems: null },
    notify: { releasesMuted: false, problemsMuted: false },
  };
}

// ── defensive field decoders ────────────────────────────────────────────────────

const FAILURE_CLASSES: ReadonlySet<string> = new Set<UpdateFailureClass>(["transport", "answered"]);
const FAILURE_CODES: ReadonlySet<string> = new Set<UpdateFailureCode>([
  "dns",
  "timeout",
  "refused",
  "reset",
  "no-route",
  "tls",
  "blocked-shape",
  "transport-other",
  "http-401",
  "http-403",
  "http-404",
  "http-status",
  "invalid-manifest",
  "git-not-found",
  "git-access-denied",
  "release-download-failed",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function decodeLastResult(value: unknown): SourceCheckResultWire | null {
  const record = asRecord(value);
  if (record === null) return null;
  const at = record["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (record["outcome"] === "ok") {
    return {
      outcome: "ok",
      at,
      latencyMs: asNumberOrNull(record["latencyMs"]),
      raw: asStringOrNull(record["raw"]),
    };
  }
  if (record["outcome"] === "fail") {
    const klass = record["class"];
    const code = record["code"];
    if (typeof klass !== "string" || !FAILURE_CLASSES.has(klass)) return null;
    if (typeof code !== "string" || !FAILURE_CODES.has(code)) return null;
    return {
      outcome: "fail",
      at,
      class: klass as UpdateFailureClass,
      code: code as UpdateFailureCode,
      latencyMs: asNumberOrNull(record["latencyMs"]),
      raw: asStringOrNull(record["raw"]),
    };
  }
  return null;
}

/** Decode a source block, honoring the carried-over `enabled` switch (the v1 → v2 shape). */
function decodeSource(value: unknown): SourceConfig {
  const record = asRecord(value);
  if (record === null) return DEFAULT_SOURCE;
  return {
    enabled: asBoolean(record["enabled"], DEFAULT_SOURCE.enabled),
    paused: asBoolean(record["paused"], DEFAULT_SOURCE.paused),
    authFails: asCounter(record["authFails"]),
    transportStreak: asCounter(record["transportStreak"]),
    failingSince: asNumberOrNull(record["failingSince"]),
    lastResult: decodeLastResult(record["lastResult"]),
  };
}

const NOTE_KINDS: ReadonlySet<string> = new Set(["feat", "fix", "perf", "ui"]);

function decodeNote(value: unknown): ReleaseNoteWire | null {
  const record = asRecord(value);
  if (record === null) return null;
  const text = record["text"];
  if (typeof text !== "string") return null;
  const kind = record["kind"];
  return {
    kind:
      typeof kind === "string" && NOTE_KINDS.has(kind) ? (kind as ReleaseNoteWire["kind"]) : null,
    text,
  };
}

function decodeChangelogVersion(value: unknown): ChangelogVersionWire | null {
  const record = asRecord(value);
  if (record === null) return null;
  const version = record["version"];
  if (typeof version !== "string") return null;
  const rawNotes = Array.isArray(record["notes"]) ? record["notes"] : [];
  const notes = rawNotes.map(decodeNote).filter((note): note is ReleaseNoteWire => note !== null);
  return { version, notes };
}

function decodeAvailableRelease(value: unknown): AvailableReleaseWire | null {
  const record = asRecord(value);
  if (record === null) return null;
  const version = record["version"];
  const sha256 = record["sha256"];
  const foundAt = record["foundAt"];
  if (typeof version !== "string" || typeof sha256 !== "string") return null;
  if (typeof foundAt !== "number" || !Number.isFinite(foundAt)) return null;
  const rawChangelog = Array.isArray(record["changelog"]) ? record["changelog"] : [];
  const changelog = rawChangelog
    .map(decodeChangelogVersion)
    .filter((entry): entry is ChangelogVersionWire => entry !== null);
  return {
    version,
    releasedAt: asNumberOrNull(record["releasedAt"]),
    sizeBytes: asNumberOrNull(record["sizeBytes"]),
    sha256,
    changelog,
    changelogTruncated: asBoolean(record["changelogTruncated"], false),
    foundAt,
  };
}

/** Whether a decoded jitter minute is present and in range; drives the "generate once" write-back. */
function jitterIsPersisted(record: Record<string, unknown>): boolean {
  const value = record["jitterMinute"];
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < UPDATE_JITTER_MINUTES
  );
}

interface DecodeOutcome {
  readonly config: AutoUpdateConfig;
  /** True when the file was migrated / repaired / jitter-generated and should be persisted back. */
  readonly migrated: boolean;
}

/**
 * Field-by-field defensive decode of the stored text into the CURRENT shape (v3 — see the file
 * header and `configVersion`). Unparseable or non-object roots → fresh defaults (with a freshly
 * generated jitter). A stored v1 file (or a v2 file missing its jitter) is migrated: its
 * per-source `enabled` switches are carried over, everything else defaults, and `migrated` is set
 * so the caller persists the jitter exactly once.
 */
export function decodeConfigOutcome(text: string, generateJitter: () => number): DecodeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: defaultConfig(clampJitter(generateJitter())), migrated: true };
  }
  const record = asRecord(parsed);
  if (record === null)
    return { config: defaultConfig(clampJitter(generateJitter())), migrated: true };

  // The `sources` block lives in v2; v1 kept the switches under top-level `web`/`git`.
  const sourcesRecord = asRecord(record["sources"]);
  const gitRaw = sourcesRecord !== null ? sourcesRecord["git"] : record["git"];
  const webRaw = sourcesRecord !== null ? sourcesRecord["web"] : record["web"];

  const jitterPersisted = jitterIsPersisted(record);
  const jitterMinute = jitterPersisted
    ? (record["jitterMinute"] as number)
    : clampJitter(generateJitter());

  const notifyRecord = asRecord(record["notify"]);
  const availableRelease = decodeAvailableRelease(record["availableRelease"]);

  const config: AutoUpdateConfig = {
    configVersion: 3,
    autoCheck: asBoolean(record["autoCheck"], true),
    jitterMinute,
    sources: { git: decodeSource(gitRaw), web: decodeSource(webRaw) },
    availableRelease,
    notified: decodeNotified(record, availableRelease),
    notify: {
      releasesMuted: asBoolean(notifyRecord?.["releasesMuted"], false),
      problemsMuted: asBoolean(notifyRecord?.["problemsMuted"], false),
    },
  };

  const migrated = record["configVersion"] !== 3 || !jitterPersisted;
  return { config, migrated };
}

/**
 * Decode the v3 `notified` stamps, migrating a v2 file on the way: v2 stored ONE number,
 * `releaseDismissedAt` (an explicit «Позже» on whatever release was current). It becomes the
 * release stamp for the release that file also carried — so an upgrade does not re-nag about a
 * version the user already waved away. With no stored release the stamp is dropped (there is
 * nothing for it to be about). The problems stamp has no v2 ancestor: it lived in the browser's
 * localStorage and is deliberately not migrated — worst case one extra notice after the upgrade.
 */
function decodeNotified(
  record: Record<string, unknown>,
  availableRelease: AvailableReleaseWire | null,
): UpdateNotifiedWire {
  const stored = asRecord(record["notified"]);
  if (stored !== null) {
    const release = asRecord(stored["release"]);
    const problems = asRecord(stored["problems"]);
    const releaseVersion = asStringOrNull(release?.["version"]);
    const releaseAt = asNumberOrNull(release?.["at"]);
    const problemsAt = asNumberOrNull(problems?.["at"]);
    return {
      release:
        releaseVersion !== null && releaseAt !== null
          ? { version: releaseVersion, at: releaseAt }
          : null,
      problems: problemsAt !== null ? { at: problemsAt } : null,
    };
  }
  const legacyDismissedAt = asNumberOrNull(record["releaseDismissedAt"]);
  return {
    release:
      legacyDismissedAt !== null && availableRelease !== null
        ? { version: availableRelease.version, at: legacyDismissedAt }
        : null,
    problems: null,
  };
}

/** Convenience wrapper for direct decode testing (drops the migration flag). */
export function decodeConfig(text: string, generateJitter: () => number): AutoUpdateConfig {
  return decodeConfigOutcome(text, generateJitter).config;
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(UPDATE_JITTER_MINUTES - 1, Math.max(0, Math.floor(value)));
}

// ── file-backed store ────────────────────────────────────────────────────────

export class ConfigSaveError extends Data.TaggedError("AutoUpdateConfigSaveError")<{
  readonly detail: string;
}> {}

export interface AutoUpdateConfigStore {
  readonly load: Effect.Effect<AutoUpdateConfig>;
  readonly save: (config: AutoUpdateConfig) => Effect.Effect<void, ConfigSaveError>;
}

/**
 * File-backed store at `<stateDir>/auto-update.json`. `randomJitter` is injected
 * so tests are deterministic; production passes a crypto/random-based generator
 * at the call site (Math.random is banned repo-wide). On the first load of a
 * missing/corrupt/v1/jitter-less file the migrated config is persisted back
 * (best-effort) so the jitter minute is generated exactly once.
 */
export function makeConfigStore(
  configPath: string,
  randomJitter: () => number,
): Effect.Effect<AutoUpdateConfigStore, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const semaphore = yield* Semaphore.make(1);

    const writeAtomic = (config: AutoUpdateConfig) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const dir = path.dirname(configPath);
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
          const tmp = `${configPath}.tmp`;
          yield* fs.writeFileString(tmp, JSON.stringify(config, null, 2));
          yield* fs.rename(tmp, configPath);
        }),
      );

    const save = (config: AutoUpdateConfig) =>
      writeAtomic(config).pipe(
        Effect.mapError((error) => new ConfigSaveError({ detail: String(error) })),
      );

    const load = fs.readFileString(configPath).pipe(
      Effect.map((text) => decodeConfigOutcome(text, randomJitter)),
      Effect.orElseSucceed(() => ({
        config: defaultConfig(clampJitter(randomJitter())),
        migrated: true,
      })),
      // Persist a migrated / jitter-generated config once so the jitter is stable across restarts.
      Effect.flatMap((outcome) =>
        outcome.migrated
          ? writeAtomic(outcome.config).pipe(Effect.ignore, Effect.as(outcome.config))
          : Effect.succeed(outcome.config),
      ),
    );

    return { load, save };
  });
}
