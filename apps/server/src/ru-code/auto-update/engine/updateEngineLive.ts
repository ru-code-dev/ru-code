// ru-code: the auto-update engine — Live implementation of the UpdateEngine
// service (v3: stateless check machine + pointer/wrapper apply). Composes the
// tested leaf modules (channels, credentials, apply/{pointer,journal,gc,
// fetchVersion}, schedule, classification) around the PURE state machine
// (transitions.ts). Every mutation flows through `mutate` so the SubscriptionRef
// update, the config projection persist, and the emit happen in ONE place.
//
// Enforced here (backed by the transition invariants):
//   · `enabled`/`paused` are user-owned — scheduled work never flips them and the
//     only unpause is an OK probe or a saved-tested credential;
//   · NO boot check (§2.2): the first tick fires only when the schedule says so;
//   · install is ALWAYS the user press: download → verify → flip → restart, run-
//     owned end to end, guarded by the applyLock (a second press no-ops);
//   · links are baked branding constants (documented test-only env overrides) —
//     there are no URL mutations.
//
// Logging (#38): ONE structured debug line per real event; every failure path is
// Effect.logError(msg, {cause}); config setters get NO line; secrets never logged.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  AutoUpdateError,
  type AutoUpdateWireState,
  type AvailableReleaseWire,
  type CredentialTestResult,
  type GeneratedSshKeyInfo,
  type GitAuthVia,
  type LastApplyWire,
  type SshKeySourceInput,
  type UpdatePressRefusalCode,
  type UpdateSourceKind,
  type UserPassCredentialsInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";

import { spawnDetachedServer } from "@ru-code/daemon";
import {
  UPDATE_GIT_HTTPS_URL,
  UPDATE_GIT_SSH_URL,
  UPDATE_CHECK_DEADLINE_MS,
  UPDATE_JITTER_MINUTES,
  UPDATE_RUN_DEADLINE_MS,
  UPDATE_SCHEDULER_BEAT_MS,
  UPDATE_WEB_URL,
} from "@ru-code/branding";

import packageJson from "../../../../package.json" with { type: "json" };

import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerConfig from "../../../config.ts";
import { UpdateEngine } from "../UpdateEngine.ts";
import { accumulateChangelog, parseChangelog } from "../changelog.ts";
import { type Manifest, isNewer, satisfiesMinNode } from "../manifest.ts";
import {
  type GitProbeResult,
  GitSourceFailure,
  fetchGitRelease,
  fetchGitTarball,
  makeGitStrategyCache,
  probeGit,
} from "../channels/gitChannel.ts";
import {
  type WebCredentials,
  type WebProbeResult,
  WebSourceFailure,
  fetchWebRelease,
  probeWeb,
  resolveTarballUrl,
} from "../channels/webChannel.ts";
import type { ClassifiedFailure } from "./classification.ts";
import { credentialedGitUrl } from "../gitAuth/httpsAuth.ts";
import { buildSshEnv } from "../gitAuth/sshCommand.ts";
import {
  discardStagedKey,
  generateDeployKey,
  promoteStagedKey,
  readPublicInfo,
  stagingKeyPath,
  writePastedKey,
} from "../gitAuth/sshKeyFile.ts";
import { makeCredentialFileStore } from "../credentials/credentialFileStore.ts";
import type { StoredCredentials } from "../credentials/credentialModel.ts";
import { collectVersionGarbage, UPDATES_GIT_RELATIVE } from "../apply/gc.ts";
import {
  type ArchiveSource,
  FetchNetworkError,
  type FetchVersionError,
  fetchVersionToDisk,
} from "../apply/fetchVersion.ts";
import { POINTER_FILENAME, makePointer, readPointer, writePointer } from "../apply/pointer.ts";
import {
  JOURNAL_SCHEMA,
  journalToWire,
  reconcileJournalAtBoot,
  writeJournal,
} from "../apply/journal.ts";
import { setHealthzLastApply, setHealthzVersion } from "../healthz.ts";
import {
  AUTO_UPDATE_TEST_TRIGGER_ENV,
  type AutoUpdateTestPressResult,
  setAutoUpdateTestPress,
} from "../apply/testTriggerRoute.ts";
import { type AutoUpdateConfig, makeConfigStore } from "./configStore.ts";
import { type CredMetaForState, buildInitialState } from "./initialState.ts";
import { withDeadline } from "./deadline.ts";
import { detectLayout, makeFactsReader, probeAppRootWritable } from "./envFacts.ts";
import { nextTickAt } from "./schedule.ts";
import * as T from "./transitions.ts";

/** Bounded facts-refresh poll: try ~60 times, 1s apart, until the sentinel port shows. */
const FACTS_REFRESH_TRIES = 60;
/** Grace before self-SIGTERM so the RPC response + state emission flush. */
const HANDOFF_EXIT_DELAY_MS = 300;

/**
 * Test-only URL overrides (documented seam). When the named env var is set +
 * non-empty it wins over the baked branding constant; otherwise the constant is
 * authoritative. Read ONCE at layer build (inside makeUpdateEngine). The web var
 * overrides the web link; the git var overrides BOTH git links (https + ssh).
 */
export const AutoUpdateUrlOverrides = {
  webEnvVar: "RU_CODE_UPDATE_WEB_URL",
  gitEnvVar: "RU_CODE_UPDATE_GIT_URL",
} as const;

/** Skips the relaunch spawn + self-SIGTERM (still journals) — engine install tests set this. */
const TEST_NO_RELAUNCH_ENV = "RU_CODE_UPDATE_TEST_NO_RELAUNCH";

/**
 * Documented, default-off test seam. When set to "1" the engine's `currentVersion`
 * is resolved from the on-disk pointer (`current.json` → `versions/<v>`) instead of
 * the build-baked package.json, and that value is latched into /healthz. This lets
 * the live-cycle integration test re-version a copy of ONE real build (version A vs
 * B are the SAME bytes with a bumped slim package.json) and observe the swap through
 * /healthz + the journal reconcile WITHOUT a second full build. Off ⇒ the baked
 * version is authoritative (production behaviour is byte-identical).
 */
const TEST_VERSION_FROM_DIR_ENV = "RU_CODE_UPDATE_TEST_VERSION_FROM_DIR";

/**
 * TEST SEAM (default-off) — a DETERMINISTIC slow restart.
 *
 * Set `RU_CODE_UPDATE_TEST_HEALTHZ_LAG_MS=<ms>` and /healthz keeps reporting the PRE-FLIP version
 * for that long after the flip, then starts reporting the new one — exactly what a tab sees while
 * a real server is being replaced on a slow disk or a loaded machine, WITHOUT killing anything.
 * Combined with `RU_CODE_UPDATE_TEST_NO_RELAUNCH` (the dev harness never restarts its server) it
 * gives both halves of the in-app restart wait: a lag under the budget must succeed in place, and
 * NO lag configured means the version never changes ⇒ the tab must escalate to the SW page.
 * Unset (production) ⇒ nothing is scheduled and the code path is byte-identical.
 */
const TEST_HEALTHZ_LAG_ENV = "RU_CODE_UPDATE_TEST_HEALTHZ_LAG_MS";

const overrideOr = (envVar: string, constant: string): string => {
  const value = process.env[envVar];
  return value !== undefined && value.trim() !== "" ? value : constant;
};

const toEpochMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/** ClassifiedFailure → the pure transition's fail SourceResult. */
const failToResult = (failure: ClassifiedFailure): T.SourceResult => ({
  outcome: "fail",
  class: failure.class,
  code: failure.code,
  latencyMs: failure.latencyMs,
  raw: failure.raw,
});

/** GitProbeResult / WebProbeResult → the wizard's CredentialTestResult. */
const gitTestResult = (probe: GitProbeResult): CredentialTestResult =>
  probe.ok
    ? { ok: true, class: null, code: null, latencyMs: probe.latencyMs, raw: probe.raw }
    : {
        ok: false,
        class: probe.failure.class,
        code: probe.failure.code,
        latencyMs: probe.failure.latencyMs,
        raw: probe.failure.raw,
      };

const webTestResult = (probe: WebProbeResult): CredentialTestResult =>
  probe.ok
    ? { ok: true, class: null, code: null, latencyMs: probe.latencyMs, raw: probe.raw }
    : {
        ok: false,
        class: probe.failure.class,
        code: probe.failure.code,
        latencyMs: probe.failure.latencyMs,
        raw: probe.failure.raw,
      };

/** Map a fetchVersion failure tag to the run's machine error code. */
const mapFetchErrorCode = (tag: string): string =>
  tag === "FetchNetworkError"
    ? "download-failed"
    : tag === "FetchTimeoutError"
      ? "download-timeout"
      : tag === "FetchArchiveIntegrityError"
        ? "archive-integrity"
        : tag === "FetchFileIntegrityError"
          ? "file-integrity"
          : "structure";

/**
 * The params of the ONE `run.failed` log event. The failure code travels as a PARAM, not baked
 * into the event code: `run.failed.<code>` had no template on the client, so every failed run
 * printed a raw `run.failed.download-failed detail=…` line into the journal the user reads.
 */
const runFailedParams = (code: string, evidence: string | null): Record<string, string> =>
  evidence === null ? { code } : { code, detail: evidence };

/** The manifest + provenance of the first source that answered OK this round. */
interface OkManifest {
  readonly kind: UpdateSourceKind;
  readonly manifest: Manifest;
  /**
   * The address the manifest came from — a base URL for the web source, the repo URL for git. The
   * install re-uses it to reach the tarball, which is always the manifest's sibling.
   */
  readonly sourceUrl: string;
  /** The basic-auth creds used (web only) — replayed on the install download. */
  readonly webCreds: WebCredentials | null;
  readonly release: AvailableReleaseWire;
}

/** One source's fetch: its tick outcome plus the OK manifest (null when it failed / was skipped). */
interface SourceFetch {
  readonly outcome: T.TickSourceOutcome;
  readonly ok: OkManifest | null;
}

/** The outcome of a full source round (git → web, stop after the first OK). */
interface SourceRound {
  readonly outcomes: ReadonlyArray<T.TickSourceOutcome>;
  readonly firstOk: OkManifest | null;
}

const makeUpdateEngine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ProcessRunner.ProcessRunner;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const bakedVersion: string = packageJson.version;

  // ── baked links (branding) + documented test-only overrides ─────────────────
  const webUrl = overrideOr(AutoUpdateUrlOverrides.webEnvVar, UPDATE_WEB_URL);
  const gitHttpsUrl = overrideOr(AutoUpdateUrlOverrides.gitEnvVar, UPDATE_GIT_HTTPS_URL);
  const gitSshUrl = overrideOr(AutoUpdateUrlOverrides.gitEnvVar, UPDATE_GIT_SSH_URL);
  /** git link by auth mode: https when https creds are stored, else ssh (stored key or ambient). */
  const chooseGitUrl = (hasHttpsCreds: boolean): string =>
    hasHttpsCreds ? gitHttpsUrl : gitSshUrl;

  // ── layout (wrapper: appRoot beside current.json) + paths ───────────────────
  const layout = detectLayout({
    entry: process.argv[1],
    envAppRoot: process.env["RU_CODE_APP_ROOT"],
    dirname: (p) => path.dirname(p),
    basename: (p) => path.basename(p),
    join: (...parts) => path.join(...parts),
    exists: (p) => NodeFS.existsSync(p),
  });
  const appRoot = layout.appRoot;

  // ru-code: which access strategy each release repo answers to (`git archive` vs a blobless clone),
  // learned on the first reach and kept for the life of the process — see gitChannel.ts.
  const gitStrategyCache = makeGitStrategyCache();

  const configPath = path.join(serverConfig.stateDir, "auto-update.json");
  const credsPath = path.join(serverConfig.stateDir, "auto-update-credentials.enc");
  const sshKeyPath = path.join(NodeOS.homedir(), ".ssh", "ru_code_update_ed25519");
  const sshKeyStagingPath = stagingKeyPath(sshKeyPath);
  const checkTmpDir = path.join(serverConfig.stateDir, "auto-update-tmp");

  /**
   * A fresh check workspace. The counter distinguishes two created in the same millisecond: the
   * scheduled tick runs under `checkLock` and the install's resolve/supersede rounds under
   * `applyLock` — DIFFERENT semaphores, so the two can genuinely overlap. Keyed by the clock alone
   * they shared one directory and each side's cleanup deleted the other's clone mid-flight, which
   * surfaced as a spurious `invalid-manifest`.
   */
  let checkWorkspaceSeq = 0;
  const nextCheckWorkspace = (now: number): string => {
    checkWorkspaceSeq += 1;
    return path.join(checkTmpDir, `git-${String(now)}-${String(checkWorkspaceSeq)}`);
  };

  /** Close the FileSystem/Path requirements with the instances captured above. */
  const provideLocal = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // ── stores ──────────────────────────────────────────────────────────────────
  const randomJitter = (): number => NodeCrypto.randomInt(0, UPDATE_JITTER_MINUTES);
  const configStore = yield* makeConfigStore(configPath, randomJitter);
  const credStore = yield* makeCredentialFileStore({ filePath: credsPath });

  const config = yield* configStore.load;
  const jitterMinute = config.jitterMinute;

  // A wrapper layout this process cannot write into can never apply an update; probed ONCE at boot
  // so the UI can say so instead of letting a press die mid-download.
  const appRootWritable =
    appRoot === null ? false : yield* provideLocal(probeAppRootWritable(appRoot));

  const factsReader = yield* makeFactsReader({
    layout,
    sentinelPath: serverConfig.serverRuntimeStatePath,
    appRootWritable,
  });

  // ru-code: sweep the check workspace at boot. Every round removes its own directory when it
  // ends, but `Effect.ensuring` cannot cover a SIGKILL, an OOM kill or a power loss — and each
  // survivor is a distinctly-named tree (clock + counter), so they accumulate without bound. The
  // appRoot-side workspaces have had this since day one (gc.ts wipes them on every call); this is
  // the same rule for the state-dir side. Safe unconditionally: the daemon is single-instance, so
  // at boot nothing can own a workspace in here.
  yield* provideLocal(
    fs.remove(checkTmpDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  const bootNow = yield* Clock.currentTimeMillis;

  // ru-code: the authoritative running version. Production = the build-baked value.
  // Under the documented default-off test seam it is read from the pointer the
  // wrapper actually booted (versions/<v> == this process's code), so a re-versioned
  // copy of ONE build reports its own version at /healthz + reconciles correctly.
  const currentVersion: string = yield* Effect.gen(function* () {
    if (process.env[TEST_VERSION_FROM_DIR_ENV] === "1" && appRoot !== null) {
      const pointer = yield* provideLocal(readPointer(appRoot));
      if (pointer !== null && pointer.version !== "") return pointer.version;
    }
    return bakedVersion;
  });
  yield* Effect.sync(() => setHealthzVersion(currentVersion));

  // ── boot: journal reconcile → healthz box → boot GC after an `ok` promote ────
  const lastApply: LastApplyWire | null = yield* Effect.gen(function* () {
    if (appRoot === null) return null;
    const journal = yield* provideLocal(
      reconcileJournalAtBoot({ appRoot, currentVersion, now: bootNow }),
    );
    const wire = journalToWire(journal);
    yield* Effect.sync(() => setHealthzLastApply(wire));
    yield* Effect.logDebug("[auto-update] boot journal reconciled", {
      outcome: journal?.outcome ?? null,
      targetVersion: journal?.targetVersion ?? null,
    });
    if (journal?.outcome === "ok") {
      yield* provideLocal(collectVersionGarbage({ appRoot, keepVersions: [currentVersion] }));
    }
    return wire;
  });

  // ── initial state (persisted-only; no probes) ───────────────────────────────
  const presence = yield* credStore.presence;
  const hasHttps = presence.https !== null;
  const gitUrl = chooseGitUrl(hasHttps);
  const gitAuthVia: GitAuthVia =
    presence.https !== null ? "https" : presence.ssh !== null ? "ssh" : "ambient";
  const credMeta: CredMetaForState = {
    git: {
      authVia: gitAuthVia,
      httpsCred:
        presence.https !== null
          ? { username: presence.https.username, savedAt: presence.https.savedAt }
          : null,
      sshCred:
        presence.ssh !== null
          ? {
              fingerprint: presence.ssh.fingerprint,
              keyType: "ed25519",
              savedAt: presence.ssh.savedAt,
              origin: presence.ssh.origin,
            }
          : null,
    },
    web: {
      cred:
        presence.web !== null
          ? { username: presence.web.username, savedAt: presence.web.savedAt }
          : null,
    },
  };

  const initialFacts = yield* provideLocal(factsReader);
  const bootState = buildInitialState({
    config,
    facts: initialFacts,
    currentVersion,
    gitUrl,
    webUrl,
    credMeta,
    nextCheckAt: config.autoCheck ? nextTickAt(bootNow, jitterMinute) : null,
    lastApply,
  });

  const stateRef = yield* SubscriptionRef.make<AutoUpdateWireState>(bootState);
  const snapshot = SubscriptionRef.get(stateRef);

  // ── config projection + the single mutation seam ────────────────────────────
  const sourceProjection = (source: {
    readonly enabled: boolean;
    readonly paused: boolean;
    readonly authFails: number;
    readonly transportStreak: number;
    readonly failingSince: number | null;
    readonly lastResult: AutoUpdateConfig["sources"]["git"]["lastResult"];
  }): AutoUpdateConfig["sources"]["git"] => ({
    enabled: source.enabled,
    paused: source.paused,
    authFails: source.authFails,
    transportStreak: source.transportStreak,
    failingSince: source.failingSince,
    lastResult: source.lastResult,
  });

  const projectConfig = (state: AutoUpdateWireState): AutoUpdateConfig => ({
    configVersion: 3,
    autoCheck: state.autoCheck,
    jitterMinute,
    sources: { git: sourceProjection(state.git), web: sourceProjection(state.web) },
    availableRelease: T.currentAvailableRelease(state),
    notified: state.notified,
    notify: state.notify,
  });

  /** Persist the config projection; a save failure is logged, never propagated. */
  const persistProjection = (state: AutoUpdateWireState): Effect.Effect<void> =>
    configStore.save(projectConfig(state)).pipe(
      Effect.tapError((error) =>
        Effect.logError("[auto-update] config persist failed", { cause: error }),
      ),
      Effect.ignore,
    );

  /** The ONE mutation seam: pure transition → persist projection → emit. No log line here. */
  const mutate = (
    label: string,
    fn: (state: AutoUpdateWireState) => AutoUpdateWireState,
  ): Effect.Effect<AutoUpdateWireState> =>
    Effect.gen(function* () {
      const next = yield* SubscriptionRef.updateAndGet(stateRef, fn);
      yield* persistProjection(next);
      return next;
    });

  const checkLock = yield* Semaphore.make(1);
  const applyLock = yield* Semaphore.make(1);

  // ── git auth (never logs secrets; pure — nothing to clean up) ───────────────
  // SSH rides the env (GIT_SSH_COMMAND over the stored key file); an HTTPS credential rides the
  // URL itself (credentialedGitUrl — works on every git version, unlike the GIT_CONFIG_* env it
  // replaced). Callers therefore take BOTH the effective url and the env from here, never the
  // configured URL directly: the pair is one decision.
  const withGitAuth = <A, E, R>(
    repoUrl: string,
    creds: StoredCredentials,
    use: (auth: {
      readonly url: string;
      readonly env: Record<string, string>;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (creds.ssh !== null) {
      return use({ url: repoUrl, env: buildSshEnv({ keyPath: creds.ssh.path }) });
    }
    if (creds.https !== null) {
      return use({ url: credentialedGitUrl({ repoUrl, credentials: creds.https }), env: {} });
    }
    return use({ url: repoUrl, env: {} });
  };

  const webCredsFrom = (stored: StoredCredentials): WebCredentials | null =>
    stored.web === null ? null : { username: stored.web.username, password: stored.web.password };

  /** Build the wire release from a fetched manifest (foundAt is a placeholder; applyTickRound fixes it). */
  const releaseFromManifest = (
    manifest: Manifest,
    changelogRaw: string | null,
    now: number,
  ): AvailableReleaseWire => {
    const accumulated = accumulateChangelog(parseChangelog(changelogRaw ?? ""), currentVersion);
    return {
      version: manifest.version,
      releasedAt: toEpochMs(manifest.releasedAt),
      sizeBytes: manifest.sizeBytes ?? null,
      sha256: manifest.sha256,
      changelog: accumulated.versions,
      changelogTruncated: accumulated.truncated,
      foundAt: now,
    };
  };

  // ── one-source fetch (the tick + install re-resolve share it) ────────────────
  const fetchOneSource = (
    kind: UpdateSourceKind,
    url: string,
    stored: StoredCredentials,
    now: number,
  ): Effect.Effect<SourceFetch, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      if (kind === "web") {
        const webCreds = webCredsFrom(stored);
        const outcome = yield* fetchWebRelease(url, webCreds, httpClient).pipe(
          Effect.map((release) => ({ tag: "ok" as const, release })),
          Effect.catch((failure: WebSourceFailure) =>
            Effect.succeed({ tag: "fail" as const, failure: failure.failure }),
          ),
        );
        if (outcome.tag === "ok") {
          const release = releaseFromManifest(
            outcome.release.manifest,
            outcome.release.changelog,
            now,
          );
          return {
            outcome: {
              kind: "web",
              result: { outcome: "ok", latencyMs: outcome.release.latencyMs, raw: null },
              release,
            },
            ok: {
              kind: "web",
              manifest: outcome.release.manifest,
              sourceUrl: url,
              webCreds,
              release,
            },
          };
        }
        return {
          outcome: { kind: "web", result: failToResult(outcome.failure), release: null },
          ok: null,
        };
      }
      // git — a fresh tmp workspace, ALWAYS removed (#16).
      const tmp = nextCheckWorkspace(now);
      const outcome = yield* withGitAuth(url, stored, (auth) =>
        fetchGitRelease({
          repoUrl: auth.url,
          env: auth.env,
          spawner,
          tmpDir: tmp,
          strategyCache: gitStrategyCache,
        }).pipe(
          Effect.map((release) => ({ tag: "ok" as const, release })),
          Effect.catch((failure: GitSourceFailure) =>
            Effect.succeed({ tag: "fail" as const, failure: failure.failure }),
          ),
        ),
      ).pipe(
        Effect.ensuring(
          fs.remove(tmp, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
      if (outcome.tag === "ok") {
        const release = releaseFromManifest(
          outcome.release.manifest,
          outcome.release.changelog,
          now,
        );
        return {
          outcome: {
            kind: "git",
            result: { outcome: "ok", latencyMs: outcome.release.latencyMs, raw: null },
            release,
          },
          ok: {
            kind: "git",
            manifest: outcome.release.manifest,
            sourceUrl: url,
            webCreds: null,
            release,
          },
        };
      }
      return {
        outcome: { kind: "git", result: failToResult(outcome.failure), release: null },
        ok: null,
      };
    });

  /**
   * Run [git, web] in order over the checkable sources; stop after the first OK.
   *
   * `showProgress` makes each source card say «проверяю…» for exactly the window its own request is
   * in flight. It is on for a CHECK, where the cards are the user's view of the round, and off for
   * the install's resolve and supersede rounds, which are internal steps of a run the /updating
   * screen is already narrating — lighting the cards there would announce a check nobody asked for.
   *
   * Marking per source (rather than marking everything up front) is the difference between the card
   * describing the round's INTENT and describing what is actually happening: the round stops at the
   * first OK, so when git answers, web is never reached at all.
   */
  const runSourceRound = (
    state: AutoUpdateWireState,
    now: number,
    options: { readonly showProgress: boolean } = { showProgress: false },
  ): Effect.Effect<SourceRound, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const stored = yield* credStore.load;
      const outcomes: Array<T.TickSourceOutcome> = [];
      let firstOk: OkManifest | null = null;
      for (const kind of ["git", "web"] as const) {
        const source = kind === "git" ? state.git : state.web;
        if (!source.enabled || source.paused || !source.offered) continue;
        if (options.showProgress) {
          yield* mutate("source reached", (s) => T.probeStarted(s, kind));
        }
        // The card must stop spinning whatever this leg does — including an interrupt, which the
        // round deadline can deliver. The outcomes are applied together at the end (the release
        // verdict needs the whole round), so this is what ends the card's own window.
        const fetched = yield* fetchOneSource(kind, source.url, stored, now).pipe(
          Effect.ensuring(
            options.showProgress
              ? mutate("source done", (s) => T.probeStopped(s, kind)).pipe(Effect.asVoid)
              : Effect.void,
          ),
        );
        outcomes.push(fetched.outcome);
        if (fetched.ok !== null) {
          firstOk = fetched.ok;
          break;
        }
      }
      return { outcomes, firstOk };
    });

  // ── the tick (scheduler + checkNow) ──────────────────────────────────────────
  /**
   * One check round. `startedSignal`, when given, is completed the moment the round is visibly
   * under way — that is what lets `checkNow` reply without holding the request open for the whole
   * round (see the `checkNow` command below). The round itself is unchanged either way.
   */
  const tickBody = (
    startedSignal: Deferred.Deferred<AutoUpdateWireState> | null = null,
  ): Effect.Effect<AutoUpdateWireState> =>
    Effect.gen(function* () {
      // Captured BEFORE `checkStarted`, which replaces the hero status — and the hero status is
      // where the known release lives. `applyTickRound` needs it to tell "the same release again"
      // from "a new release", which is what decides whether the «Позже» stamp survives.
      const priorRelease = T.currentAvailableRelease(yield* snapshot);
      yield* mutate("check started", T.checkStarted);
      const state = yield* snapshot;
      if (startedSignal !== null) yield* Deferred.succeed(startedSignal, state);
      const startedAt = yield* Clock.currentTimeMillis;
      const round = yield* provideLocal(runSourceRound(state, startedAt, { showProgress: true }));
      const settledAt = yield* Clock.currentTimeMillis;
      const next = yield* mutate("check settled", (current) =>
        T.applyTickRound(current, round.outcomes, settledAt, priorRelease),
      );
      const available = T.currentAvailableRelease(next);
      yield* Effect.logDebug("[auto-update] tick settled", {
        outcomes:
          round.outcomes
            .map((o) => `${o.kind}:${o.result.outcome === "ok" ? "ok" : o.result.code}`)
            .join(",") || "none",
        winner: round.firstOk?.kind ?? null,
        version: available?.version ?? null,
      });
      return next;
    });

  /**
   * One check round, bounded. `checkAborted` is a no-op once the round settled (the hero is no
   * longer `checking`), which is what lets it be a blind finalizer — see deadline.ts.
   */
  const boundedTickBody = (
    startedSignal: Deferred.Deferred<AutoUpdateWireState> | null = null,
  ): Effect.Effect<AutoUpdateWireState> =>
    withDeadline({
      work: tickBody(startedSignal),
      durationMs: UPDATE_CHECK_DEADLINE_MS,
      label: "check round",
      onTimeout: snapshot,
      settle: mutate("check aborted", T.checkAborted).pipe(Effect.asVoid),
    });

  /**
   * A full tick, awaited to completion — guarded by canCheckNow AND a checkLock try-acquire.
   * This is the SCHEDULER's entry point: nothing is waiting on it, so it keeps the simple shape.
   */
  const performTick: Effect.Effect<AutoUpdateWireState> = Effect.gen(function* () {
    const current = yield* snapshot;
    if (!T.canCheckNow(current)) return current;
    const held = yield* checkLock.withPermitsIfAvailable(1)(boundedTickBody());
    return yield* Option.match(held, {
      onNone: () => snapshot,
      onSome: (state) => Effect.succeed(state),
    });
  });

  /**
   * The `checkNow` RPC. Same round, same lock, same results — only the moment of the REPLY moves:
   * it returns as soon as the check is visibly under way instead of holding the request open for
   * the whole round (git metadata + web, sequentially — long enough to trip the app's generic
   * slow-request monitor and put an orange banner over a check that was working perfectly).
   *
   * Safe because the reply was already vestigial: the client renders from the streamed state, and
   * `handlePress` deliberately discards the RPC's refusal codes. Every source outcome reaches the
   * UI through `lastResult` / `history` / the cards, so nothing that used to be observable through
   * the return value is lost.
   *
   * The round is FORKED DETACHED for the same reason the install run is: it belongs to the server,
   * not to the connection that asked for it, so a closed tab must not abort a check in flight.
   */
  const checkNowCommand: Effect.Effect<AutoUpdateWireState> = Effect.gen(function* () {
    const current = yield* snapshot;
    if (!T.canCheckNow(current)) return current;
    const started = yield* Deferred.make<AutoUpdateWireState>();
    yield* Effect.forkDetach(
      checkLock
        .withPermitsIfAvailable(1)(tickBody(started))
        .pipe(
          // Whatever happens — a busy lock (the round never runs), a defect, an interrupt — the caller
          // gets an answer. `Deferred.succeed` on a completed deferred is a no-op, so the normal path
          // is unaffected and there is no way to be left awaiting a fiber that is gone.
          Effect.ensuring(snapshot.pipe(Effect.flatMap((s) => Deferred.succeed(started, s)))),
        ),
    );
    return yield* Deferred.await(started);
  });

  // ── single-source probe (manual «Проверить»; ALWAYS allowed, even paused) ────
  const probeOne = (
    kind: UpdateSourceKind,
    url: string,
  ): Effect.Effect<T.SourceResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const stored = yield* credStore.load;
      if (kind === "web") {
        const probe = yield* probeWeb(url, webCredsFrom(stored), httpClient);
        return probe.ok
          ? { outcome: "ok", latencyMs: probe.latencyMs, raw: probe.raw }
          : failToResult(probe.failure);
      }
      const probe = yield* withGitAuth(url, stored, (auth) =>
        probeGit({ repoUrl: auth.url, env: auth.env, spawner }),
      );
      return probe.ok
        ? { outcome: "ok", latencyMs: probe.latencyMs, raw: probe.raw }
        : failToResult(probe.failure);
    });

  const probeSource = (kind: UpdateSourceKind): Effect.Effect<AutoUpdateWireState> =>
    Effect.gen(function* () {
      const state = yield* snapshot;
      const source = kind === "git" ? state.git : state.web;
      if (!source.offered) return state;
      // A live run owns the sources — the same rule `canCheckNow` applies to a check. This used to
      // be enforced ONLY by disabling the button, so a second tab holding older state could still
      // reach the RPC and start a probe next to a running install.
      if (!T.canCheckNow(state)) {
        yield* Effect.logDebug("[auto-update] probe refused", { reason: "run-active", kind });
        return state;
      }
      // Publish the in-flight state BEFORE the request: a probe can spend its whole budget, and a
      // card that does not change is read as a button that does not work.
      yield* mutate("probe started", (current) => T.probeStarted(current, kind));
      // Serialized against a check on the SAME lock: a probe racing a round would have two writers
      // for one card and the loser's result would vanish. Waiting (rather than refusing) is what
      // keeps a manual «Проверить» from silently doing nothing.
      //
      // `probeStarted` is re-asserted INSIDE the lock: a round settling while this probe waited
      // force-clears `probing` on both cards (applyTickRound), which would otherwise leave this
      // request in flight with no spinner — exactly the lie item 6 removed.
      //
      // The run guard is re-asked inside too, and for the same class of reason: the check above
      // read a snapshot taken BEFORE this probe queued, and a press takes a DIFFERENT semaphore
      // (applyLock), so a run can start while this one waits. Without the re-ask the refusal was
      // one hop from being useless — the probe would simply execute next to the live run it was
      // written to stay out of.
      const outcome = yield* checkLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (!T.canCheckNow(yield* snapshot)) return null;
            yield* mutate("probe reached", (current) => T.probeStarted(current, kind));
            return yield* provideLocal(probeOne(kind, source.url));
          }),
        )
        .pipe(
          // Whatever happens — including an interrupt — the card must not keep spinning.
          Effect.onInterrupt(() =>
            mutate("probe interrupted", (current) =>
              kind === "git"
                ? { ...current, git: { ...current.git, probing: false } }
                : { ...current, web: { ...current.web, probing: false } },
            ).pipe(Effect.asVoid),
          ),
        );
      // Refused inside the lock (a run started while this probe waited). The spinner published
      // before the wait is what must not be left behind.
      if (outcome === null) {
        yield* Effect.logDebug("[auto-update] probe refused", { reason: "run-active", kind });
        return yield* mutate("probe stood down", (current) => T.probeStopped(current, kind));
      }
      const result = outcome;
      const at = yield* Clock.currentTimeMillis;
      // applyProbeResult, not applyTickRound: a probe carries no manifest verdict
      // and must never clear a release a full round found.
      const next = yield* mutate("probe settled", (current) =>
        T.applyProbeResult(current, kind, result, at),
      );
      yield* Effect.logDebug("[auto-update] probe", {
        kind,
        ok: result.outcome === "ok",
        code: result.outcome === "fail" ? result.code : null,
        latencyMs: result.latencyMs,
      });
      return next;
    });

  /**
   * Refuse a press BEFORE any run exists: record the reason in the state (so the settings hero can
   * state it inline, in every tab, with a retry) and still fail the RPC for the caller.
   *
   * `detail` is the English log/RPC line and NEVER reaches the screen. What the user sees is
   * composed on the client from `code` + `params`, with `evidence` (a path, a version range, a URL
   * — never a sentence) shown verbatim underneath. That split is the whole point: the previous
   * version put `detail` straight into `raw`, which is how «Сейчас нечего устанавливать» ended up
   * with "no newer update resolved" printed under it.
   */
  const refusePress = (
    // Typed against the CONTRACT's list, not `string`: the client composes a sentence per code and
    // a test iterates the same list, so a new refusal invented here without a sentence there is now
    // a compile error rather than a «Что-то пошло не так» in production.
    code: UpdatePressRefusalCode,
    detail: string,
    evidence: { readonly raw?: string | null; readonly params?: Record<string, string> } = {},
  ): Effect.Effect<never, AutoUpdateError> =>
    Effect.gen(function* () {
      yield* mutate("press refused", (s) =>
        T.setPressRefusal(s, {
          code,
          raw: evidence.raw ?? null,
          params: evidence.params ?? {},
        }),
      );
      return yield* new AutoUpdateError({ detail, code });
    });

  // ── git acquisition of the release tarball (the install's git branch) ────────

  /** Total size of everything under `dir`, or 0 while it does not exist yet. Best-effort. */
  const treeBytes = (dir: string): Effect.Effect<number> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      let total = 0;
      for (const entry of entries) {
        const child = path.join(dir, entry);
        const info = yield* fs.stat(child).pipe(Effect.result);
        if (info._tag === "Failure") continue;
        total +=
          info.success.type === "Directory" ? yield* treeBytes(child) : Number(info.success.size);
      }
      return total;
    });

  /**
   * Pull the release tarball out of the git repository, reporting progress by watching the workspace
   * grow: git prints no progress for either access strategy, and the manifest's `sizeBytes` is the
   * only number we can honestly divide by. Without a size the bar simply does not move until the
   * bytes are on disk — better than inventing a percentage. A git failure becomes the same
   * `download-failed` the web branch would produce, with the classified evidence attached.
   */
  const acquireGitArchive = (params: {
    readonly repoUrl: string;
    readonly version: string;
    readonly workDir: string;
    readonly expectedBytes: number | null;
    readonly onPct: (pct: number) => void;
  }): Effect.Effect<ArchiveSource, FetchVersionError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      yield* fs
        .remove(params.workDir, { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined));
      const stored = yield* credStore.load;
      const total = params.expectedBytes;
      const watcher =
        total === null || total <= 0
          ? null
          : yield* treeBytes(params.workDir).pipe(
              Effect.andThen((bytes) =>
                Effect.sync(() => params.onPct(Math.min(99, Math.floor((bytes / total) * 100)))),
              ),
              Effect.andThen(Effect.sleep(Duration.millis(250))),
              Effect.forever,
              Effect.forkDetach,
            );
      const outcome = yield* withGitAuth(params.repoUrl, stored, (auth) =>
        fetchGitTarball({
          repoUrl: auth.url,
          env: auth.env,
          spawner,
          tmpDir: params.workDir,
          version: params.version,
          strategyCache: gitStrategyCache,
        }),
      ).pipe(
        Effect.result,
        Effect.ensuring(watcher === null ? Effect.void : Fiber.interrupt(watcher)),
      );
      if (Result.isFailure(outcome)) {
        const classified = outcome.failure.failure;
        return yield* new FetchNetworkError({
          detail: `git could not deliver the release tarball (${classified.code})`,
          evidence: classified.raw,
          status: null,
          sourceFailureCode: classified.code,
        });
      }
      // 99, not 100: the bytes are on disk, but the shared pipeline still has to sha256 them,
      // extract the tree and verify every file against `__checksums.json` — seconds during which a
      // «Загрузка · 100 %» bar says the opposite of what is happening. The verify step sets 100.
      params.onPct(99);
      return { kind: "file", path: outcome.success.path };
    });

  // ── the install run (the press) ──────────────────────────────────────────────
  /**
   * The install run. `startedSignal`, when given, is completed the moment the run EXISTS in state —
   * after every refusal gate and after `startRun`. Refusals are untouched by this: they happen
   * before the signal and still fail the effect, so `pressRefusal`, the hero, `retryRun` and AU-02
   * behave exactly as before.
   */
  const installBody = (
    startedSignal: Deferred.Deferred<AutoUpdateWireState, AutoUpdateError> | null = null,
  ): Effect.Effect<AutoUpdateWireState, AutoUpdateError> =>
    Effect.gen(function* () {
      if (!layout.updatable || appRoot === null) {
        return yield* refusePress("not-updatable", "this installation layout is not updatable");
      }
      if (!appRootWritable) {
        return yield* refusePress("read-only", "the install directory is not writable", {
          raw: appRoot,
        });
      }
      const pre = yield* snapshot;
      if (T.currentAvailableRelease(pre) === null) {
        return yield* refusePress("no-update", "no update is available to install");
      }

      // 1. RE-RESOLVE the release fresh (first OK of git → web).
      const resolveNow = yield* Clock.currentTimeMillis;
      const round = yield* provideLocal(runSourceRound(pre, resolveNow));
      const ok = round.firstOk;
      /**
       * A press's round is a REAL round: same sources, same requests, same answers. Its outcomes
       * were thrown away, so a source that answered 401 to ten presses stayed at `authFails: 0`,
       * no history row was written, and after a refusal the hero went on advertising a release the
       * sources had just failed to confirm.
       *
       * Recorded on the two refusals that are ABOUT WHAT THE SOURCES SAID — nobody answered, or
       * they answered and nothing is newer. `node-too-old` (and the layout/read-only refusals,
       * which happen before the round runs) are about this machine, not about the sources, so they
       * leave the round unrecorded: a release that cannot run here must not be re-announced by a
       * press that just refused it. A successful press continues into a run, where the release
       * verdict belongs to the run; the supersede round follows the same rule for the same reason.
       *
       * Consequence, deliberate and ratified: two answered auth rejections from a press pause the
       * source, exactly as two from a scheduled check do. One state machine, one rule.
       */
      const recordRound = (at: number): Effect.Effect<void> =>
        mutate("press round", (s) =>
          // `applyPressRound`, NOT `applyTickRound`: a press does not hold the check lock, so a
          // scheduled round can be in flight right now — and the tick settler clears `checking` and
          // both `probing` flags, which would switch off a spinner while that source's request was
          // still on the wire. No `checkStarted` preceded this round either, so the state still
          // carries the known release and it is passed straight back in.
          T.applyPressRound(s, round.outcomes, at, T.currentAvailableRelease(s)),
        ).pipe(Effect.asVoid);

      // Two different truths, and conflating them was a lie the user caught: `ok === null` means NO
      // source answered at all (the host is down / unreachable) — never "nothing newer exists".
      if (ok === null) {
        yield* recordRound(yield* Clock.currentTimeMillis);
        return yield* refusePress("sources-unreachable", "no update source answered this round");
      }
      if (!isNewer(ok.manifest.version, currentVersion)) {
        // The round answered and there is nothing newer — that IS the check's verdict, so it is
        // recorded exactly as a scheduled round would record it (this is what clears a hero still
        // advertising a release the source no longer offers).
        yield* recordRound(yield* Clock.currentTimeMillis);
        return yield* refusePress("no-update", "the resolved release is not newer", {
          params: { latest: ok.manifest.version, current: currentVersion },
        });
      }
      const manifest = ok.manifest;
      // Refuse BEFORE downloading when this host's node can't run the release
      // (the frozen wrapper re-checks at boot; refusing here is the clean UX).
      if (!satisfiesMinNode(manifest.minNode, process.versions.node)) {
        return yield* refusePress(
          "node-too-old",
          `release requires node ${manifest.minNode}, running ${process.versions.node}`,
          { params: { required: manifest.minNode, running: process.versions.node } },
        );
      }
      // 2. start the run + download.
      const startAt = yield* Clock.currentTimeMillis;
      yield* mutate("run start", (s) => T.startRun(s, ok.release, startAt));
      yield* mutate("run download", (s) =>
        T.appendRunLogLine(s, startAt, "act", "run.download", {
          version: manifest.version,
          sizeBytes: String(manifest.sizeBytes ?? ""),
          sha256: manifest.sha256.slice(0, 12),
        }),
      );
      // Every refusal is behind us and the run is now visible in state, so the press can be answered.
      // From here on the client follows the run through the stream, not through this reply.
      if (startedSignal !== null) yield* Deferred.succeed(startedSignal, yield* snapshot);

      // Old pointer captured BEFORE the flip so a spawn failure can revert it.
      const oldPointer = yield* provideLocal(readPointer(appRoot));

      // A ticker mirrors the download callback into the wire so the bar is smooth.
      const pctBox = { value: 0 };
      const ticker = yield* SubscriptionRef.update(stateRef, (s) =>
        T.setRunPct(s, pctBox.value),
      ).pipe(Effect.andThen(Effect.sleep(Duration.millis(150))), Effect.forever, Effect.forkDetach);

      // ru-code: WHERE the archive comes from is the only thing the two channels do differently. The
      // web source streams it (progress from content-length); git carries the tarball itself, so it is
      // pulled out of the release repo first and the shared verification pipeline then reads it off
      // disk — same sha256, same per-file checksums, same atomic landing.
      const gitWorkDir = path.join(appRoot, UPDATES_GIT_RELATIVE);
      const fetched = yield* provideLocal(
        (ok.kind === "web"
          ? Effect.succeed<ArchiveSource>({
              kind: "http",
              url: resolveTarballUrl(ok.sourceUrl, manifest.version),
              basicAuth: ok.webCreds,
            })
          : acquireGitArchive({
              repoUrl: ok.sourceUrl,
              version: manifest.version,
              workDir: gitWorkDir,
              expectedBytes: manifest.sizeBytes,
              onPct: (pct) => {
                pctBox.value = pct;
              },
            })
        ).pipe(
          Effect.andThen((source) =>
            fetchVersionToDisk({
              appRoot,
              version: manifest.version,
              source,
              expectedSha256: manifest.sha256,
              expectedBytes: manifest.sizeBytes ?? null,
              signature: manifest.signature,
              onProgress: (pct) => {
                pctBox.value = pct;
              },
            }),
          ),
        ),
      ).pipe(Effect.result);
      yield* Fiber.interrupt(ticker);
      yield* provideLocal(
        fs.remove(gitWorkDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined)),
      );

      if (Result.isFailure(fetched)) {
        const error = fetched.failure;
        const code = mapFetchErrorCode(error._tag);
        const failAt = yield* Clock.currentTimeMillis;
        yield* Effect.logError("[auto-update] install download/verify failed", { cause: error });
        if (error._tag === "FetchNetworkError") {
          const failureCode =
            error.sourceFailureCode ??
            (error.status === 401
              ? ("http-401" as const)
              : error.status === 403
                ? ("http-403" as const)
                : null);
          if (failureCode !== null && T.isAnsweredAuth(ok.kind, failureCode)) {
            yield* mutate("install auth fail → source", (s) =>
              T.applySourceResult(
                s,
                ok.kind,
                {
                  outcome: "fail",
                  class: "answered",
                  code: failureCode,
                  latencyMs: null,
                  raw: error.evidence,
                },
                failAt,
              ),
            );
          }
        }
        yield* mutate("run failed", (s) =>
          T.failRun(
            T.appendRunLogLine(
              s,
              failAt,
              "err",
              "run.failed",
              runFailedParams(code, error.evidence),
            ),
            {
              code,
              raw: error.evidence,
              params: {},
            },
          ),
        );
        return yield* snapshot;
      }
      const landed = fetched.success;

      // 3. GC right after a successful fetch: keep only the current + the incoming.
      yield* provideLocal(
        collectVersionGarbage({ appRoot, keepVersions: [currentVersion, manifest.version] }),
      );

      // 4. verify happened inside fetchVersionToDisk — reflect it in the run log.
      const verifyAt = yield* Clock.currentTimeMillis;
      yield* mutate("run verify", (s) =>
        T.appendRunLogLine(
          T.advanceRunPhase(T.setRunPct(s, 100), "verify"),
          verifyAt,
          "ok",
          "run.verified",
          {
            version: manifest.version,
            sha256: manifest.sha256.slice(0, 12),
          },
        ),
      );

      // 4b. LAST LOOK BEFORE THE POINT OF NO RETURN — did a newer release appear while this one was
      // downloading? The download owns minutes (see UPDATE_DOWNLOAD_TIMEOUT_MS) and the scheduler is
      // blocked for all of them, so the version resolved at press time can be stale by now. This is
      // the last instant where stopping is FREE: nothing has been flipped and the running version is
      // untouched.
      //
      // Deliberately advisory. It aborts ONLY on a positive answer — a source that replied OK with a
      // version newer than the one on disk. A round where nobody answers means the release host went
      // away mid-download, which is no reason to throw away bytes the user asked for and that have
      // already passed every integrity gate: the flip proceeds. For the same reason the round's
      // outcomes are recorded ONLY on the abort path — letting an advisory probe bump failure streaks
      // (and so pause a source) as a side effect of installing would be a hidden second job.
      const supersedeRound = yield* provideLocal(
        runSourceRound(yield* snapshot, yield* Clock.currentTimeMillis),
      );
      const supersededBy =
        supersedeRound.firstOk !== null &&
        isNewer(supersedeRound.firstOk.manifest.version, manifest.version)
          ? supersedeRound.firstOk
          : null;
      if (supersededBy !== null) {
        const abortAt = yield* Clock.currentTimeMillis;
        yield* Effect.logDebug("[auto-update] install superseded mid-run", {
          downloaded: manifest.version,
          appeared: supersededBy.manifest.version,
        });
        // Record the round: it re-points `availableRelease` (and its changelog) at the NEW version and
        // drops the quiet stamp, so the hero re-offers it the moment the run ends. A LIVE run is left
        // alone by applyTickRound, so the failRun below is what ends this one.
        yield* mutate("supersede round", (s) =>
          // No `checkStarted` preceded this round, so the state still carries the known release.
          T.applyTickRound(s, supersedeRound.outcomes, abortAt, T.currentAvailableRelease(s)),
        );
        yield* mutate("run superseded", (s) =>
          T.failRun(
            T.appendRunLogLine(
              s,
              abortAt,
              "err",
              "run.failed",
              runFailedParams("superseded", supersededBy.manifest.version),
            ),
            {
              code: "superseded",
              raw: supersededBy.manifest.version,
              params: { appeared: supersededBy.manifest.version },
            },
          ),
        );
        // The payload we will never boot goes away, so `versions/` does not accumulate a dead tree.
        yield* provideLocal(collectVersionGarbage({ appRoot, keepVersions: [currentVersion] }));
        return yield* snapshot;
      }

      // 5. flip: write the pointer, then journal `started`.
      // UNINTERRUPTIBLE: the pointer and its journal entry are one decision. The run deadline
      // (UPDATE_RUN_DEADLINE_MS) interrupts, and an interrupt landing between the two would leave a
      // machine pointing at a version with no record of the attempt. Deferring the interrupt until
      // both are on disk costs a few milliseconds and removes the case entirely.
      const flipAt = yield* Clock.currentTimeMillis;
      yield* mutate("run flip", (s) => T.advanceRunPhase(s, "flip"));
      const flip = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const written = yield* provideLocal(
            writePointer(appRoot, makePointer(manifest.version, landed.entryRelative)),
          ).pipe(Effect.result);
          if (Result.isFailure(written)) return written;
          yield* provideLocal(
            writeJournal(appRoot, {
              schema: JOURNAL_SCHEMA,
              targetVersion: manifest.version,
              fromVersion: currentVersion,
              outcome: "started",
              reasonCode: null,
              at: flipAt,
            }),
          );
          return written;
        }),
      );
      if (Result.isFailure(flip)) {
        const failAt = yield* Clock.currentTimeMillis;
        yield* Effect.logError("[auto-update] pointer flip failed", { cause: flip.failure });
        yield* mutate("run failed", (s) =>
          T.failRun(
            T.appendRunLogLine(
              s,
              failAt,
              "err",
              "run.failed",
              runFailedParams("flip-failed", null),
            ),
            { code: "flip-failed", raw: null, params: {} },
          ),
        );
        return yield* snapshot;
      }
      yield* mutate("run flipped", (s) =>
        T.appendRunLogLine(s, flipAt, "ok", "run.flipped", { version: manifest.version }),
      );

      // ru-code: TEST SEAM (default-off, see TEST_HEALTHZ_LAG_ENV) — make /healthz start reporting the
      // NEW version after a delay, so a harness whose server never actually restarts can still play a
      // slow-but-successful restart to the tab. Production leaves this unset and nothing is forked.
      // The emptiness check is not decoration: `Number("")` is 0 — finite and >= 0 — so an
      // exported-but-empty variable would arm this seam in production with zero delay, defeating
      // the very property /healthz exists to guarantee. Every other seam in this file uses the
      // safe `=== "1"` form; this one takes a number, so it states the rule itself.
      const healthzLagRaw = process.env[TEST_HEALTHZ_LAG_ENV];
      const healthzLagMs =
        healthzLagRaw === undefined || healthzLagRaw.trim() === "" ? NaN : Number(healthzLagRaw);
      if (Number.isFinite(healthzLagMs) && healthzLagMs >= 0) {
        yield* Effect.sleep(Duration.millis(healthzLagMs)).pipe(
          Effect.andThen(Effect.sync(() => setHealthzVersion(manifest.version))),
          Effect.forkDetach,
        );
      }

      // 6. restart: spawn the detached relaunch, then self-SIGTERM after a grace.
      const facts = yield* provideLocal(factsReader);
      const restartAt = yield* Clock.currentTimeMillis;
      yield* mutate("run restart", (s) =>
        T.appendRunLogLine(T.advanceRunPhase(s, "restart"), restartAt, "act", "run.restart", {
          port: String(facts.port),
        }),
      );

      if (process.env[TEST_NO_RELAUNCH_ENV] === "1") {
        yield* Effect.logDebug("[auto-update] relaunch skipped (test seam)", {
          version: manifest.version,
        });
        return yield* snapshot;
      }

      const spawned = yield* spawnDetachedServer({
        command: process.execPath,
        args: [
          ...process.execArgv,
          path.join(appRoot, "cli.js"),
          "update-relaunch",
          "--port",
          String(facts.port),
          "--no-browser",
          "--base-dir",
          serverConfig.baseDir,
        ],
        env: process.env,
        logPath: path.join(appRoot, "updates", "relaunch.log"),
      }).pipe(Effect.result);

      if (Result.isFailure(spawned)) {
        // Revert the pointer + journal the failed relaunch so nothing boots half-flipped.
        //
        // `oldPointer === null` means there was no readable pointer BEFORE the flip — a missing or
        // corrupt `current.json`, i.e. exactly the installs where the wrapper is already running on
        // its fallback. Leaving the new pointer there left disk and journal disagreeing; removing
        // it puts the machine back where it was, which is what "nothing boots half-flipped" says.
        // The version it names is fully verified either way, so neither choice can break a boot —
        // this one just does not lie about what happened.
        if (oldPointer !== null) {
          yield* provideLocal(writePointer(appRoot, oldPointer)).pipe(Effect.ignore);
        } else {
          yield* provideLocal(
            fs
              .remove(path.join(appRoot, POINTER_FILENAME))
              .pipe(Effect.orElseSucceed(() => undefined)),
          );
        }
        const failAt = yield* Clock.currentTimeMillis;
        yield* provideLocal(
          writeJournal(appRoot, {
            schema: JOURNAL_SCHEMA,
            targetVersion: manifest.version,
            fromVersion: currentVersion,
            outcome: "failed",
            reasonCode: "spawn-failed",
            at: failAt,
          }),
        );
        yield* Effect.logError("[auto-update] relaunch spawn failed", { cause: spawned.failure });
        yield* mutate("run failed", (s) =>
          T.failRun(
            T.appendRunLogLine(
              s,
              failAt,
              "err",
              "run.failed",
              runFailedParams("spawn-failed", null),
            ),
            {
              code: "spawn-failed",
              raw: null,
              params: {},
            },
          ),
        );
        return yield* snapshot;
      }
      yield* Effect.logDebug("[auto-update] relaunch spawned", { pid: spawned.success });

      // Graceful-fast shutdown: the FIRST signal flows into the Effect runtime
      // (finalizers run — ACP children die, the sentinel is cleared); the daemon's
      // second-signal hard-exit stays available as the escape hatch.
      yield* Effect.sleep(Duration.millis(HANDOFF_EXIT_DELAY_MS)).pipe(
        Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
        Effect.forkDetach,
      );
      return yield* snapshot;
    });

  /**
   * The install run, bounded. THE GUARANTEE: a started run always reaches a terminal phase.
   * `download`, `verify` and `flip` are mid-flight; reaching the finalizer while state still shows
   * one of them means the fiber ended without a verdict, and the user must be told rather than left
   * watching a bar that has stopped moving. `restart` is NOT one of them — it is the successful
   * hand-off, after which this process is deliberately dying.
   */
  const boundedInstallBody = (
    startedSignal: Deferred.Deferred<AutoUpdateWireState, AutoUpdateError> | null = null,
  ): Effect.Effect<AutoUpdateWireState, AutoUpdateError> =>
    withDeadline({
      work: installBody(startedSignal),
      durationMs: UPDATE_RUN_DEADLINE_MS,
      label: "install run",
      onTimeout: snapshot,
      settle: Effect.gen(function* () {
        const state = yield* snapshot;
        if (!T.isRunUnfinished(state)) return;
        const at = yield* Clock.currentTimeMillis;
        yield* Effect.logError("[auto-update] run ended without a verdict", {
          phase: state.run?.phase ?? null,
        });
        yield* mutate("run interrupted", (s) => T.failUnfinishedRun(s, at));
      }),
    });

  /**
   * The press is ACCEPTED and the server is working on it — set before the resolve round, cleared
   * on every exit. This is what lets the client disable the button from a server fact instead of
   * from the click, and is why no wall-clock watchdog is needed to release it.
   */
  const markPressInFlight = (inFlight: boolean): Effect.Effect<void> =>
    mutate(inFlight ? "press accepted" : "press settled", (s) => ({
      ...s,
      pressInFlight: inFlight,
    })).pipe(Effect.asVoid);

  const install: Effect.Effect<AutoUpdateWireState, AutoUpdateError> = Effect.gen(function* () {
    // The run is SERVER-OWNED end to end (user law): it must survive the pressing client vanishing
    // (tab closed, hard reload, WS drop), so it executes on a DETACHED fiber.
    //
    // The RPC used to JOIN that fiber to completion, which meant the request stayed open for the
    // whole download — and the app's generic slow-request monitor put an orange «выполняются
    // медленно» banner over every real install. It now waits only for the run to EXIST: refusals
    // still fail the call exactly as before (they happen before the signal), and everything after
    // the start is reported through the state stream, which is what the client renders from anyway.
    const started = yield* Deferred.make<AutoUpdateWireState, AutoUpdateError>();
    yield* Effect.forkDetach(
      applyLock
        .withPermitsIfAvailable(1)(
          // Set INSIDE the permitted region, cleared by its own finalizer: the flag's writer is
          // exactly the permit holder, so it has ONE owner. Set outside, a second press that finds
          // the permit busy would run this finalizer without ever running the work — clearing the
          // flag while the FIRST press was still resolving, which re-opens the very gap the flag
          // exists to close (the install re-resolves both sources before a run exists, and a
          // second press is reachable: the release toast calls `install()` with no busy gate).
          markPressInFlight(true).pipe(
            Effect.andThen(boundedInstallBody(started)),
            // Cleared the moment the press settles — refused, run started, or dead. `ensuring`
            // covers the defect and interrupt cases too, which is why the client can trust it.
            Effect.ensuring(markPressInFlight(false)),
          ),
        )
        .pipe(
          // The caller can never be left waiting on a fiber that is gone. A refusal (typed failure)
          // reaches it as the same error the join used to deliver; a busy apply-lock resolves to the
          // current snapshot, as before; a defect or interrupt resolves to the state the finalizer
          // above just made truthful. Completing an already-completed Deferred is a no-op.
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? snapshot.pipe(Effect.flatMap((s) => Deferred.succeed(started, s)))
              : Deferred.failCause(started, exit.cause),
          ),
        ),
    );
    return yield* Deferred.await(started);
  });

  const retryRun: Effect.Effect<AutoUpdateWireState, AutoUpdateError> = Effect.gen(function* () {
    const state = yield* snapshot;
    if (state.run === null || state.run.phase !== "failed") return state;
    yield* mutate("run cleared", (s) => ({ ...s, run: null }));
    return yield* install;
  });

  /**
   * The install AWAITED TO COMPLETION — the shape `install` had before it started replying early.
   * Not on the engine interface: its only caller is the test-trigger seam below, which drives one
   * real press head-lessly and needs the FINISHED state, not the started one.
   */
  const installToCompletion: Effect.Effect<AutoUpdateWireState, AutoUpdateError> = Effect.gen(
    function* () {
      const held = yield* applyLock.withPermitsIfAvailable(1)(boundedInstallBody());
      return yield* Option.match(held, {
        onNone: () => snapshot,
        onSome: (state) => Effect.succeed(state),
      });
    },
  );

  // ── credentials (wizard: test-before-save; every save re-tests server-side) ──
  const testGitOnUrl = (
    url: string,
    env: Record<string, string>,
  ): Effect.Effect<CredentialTestResult> =>
    Effect.gen(function* () {
      if (url.trim() === "") {
        return {
          ok: false,
          class: null,
          code: null,
          latencyMs: null,
          raw: "git source is not configured",
        };
      }
      const probe = yield* probeGit({ repoUrl: url, env, spawner });
      return gitTestResult(probe);
    });

  const testGitHttps = (
    credentials: UserPassCredentialsInput,
  ): Effect.Effect<CredentialTestResult> =>
    // The credential rides the URL (credentialedGitUrl); the env carries nothing extra — the
    // prompt-disabling floor in buildGitEnv is what makes a rejected credential answer fast.
    provideLocal(
      testGitOnUrl(
        gitHttpsUrl.trim() === ""
          ? gitHttpsUrl
          : credentialedGitUrl({
              repoUrl: gitHttpsUrl,
              credentials: { username: credentials.username, password: credentials.password },
            }),
        {},
      ),
    );

  /**
   * Where the key under consideration lives while it is being tested. `file` points at the user's
   * own key and is never copied; `generate` and `paste` both land in the STAGING path, so the key
   * the app is currently authenticating with survives until a save promotes the new one.
   */
  const resolveSshKeyPath = (key: SshKeySourceInput): Effect.Effect<string, AutoUpdateError> => {
    if (key.origin === "file") {
      // The path is an unconstrained wire string that will be PERSISTED and re-used on every
      // scheduled check. Refuse anything that is not a readable regular file here, at the boundary,
      // rather than letting it fail silently once a check later — and never for anything else.
      return provideLocal(
        fs.stat(key.path).pipe(
          Effect.flatMap((info) =>
            info.type === "File"
              ? Effect.succeed(key.path)
              : Effect.fail(
                  new AutoUpdateError({
                    detail: `ssh key path is not a file: ${key.path}`,
                    code: "key-unreadable",
                  }),
                ),
          ),
          Effect.catchTag("PlatformError", () =>
            Effect.fail(
              new AutoUpdateError({
                detail: `ssh key file not found: ${key.path}`,
                code: "key-unreadable",
              }),
            ),
          ),
        ),
      );
    }
    if (key.origin === "generate") return Effect.succeed(sshKeyStagingPath);
    return provideLocal(
      writePastedKey(key.privateKeyPem, sshKeyStagingPath).pipe(
        Effect.map(() => sshKeyStagingPath),
        Effect.mapError(
          (error) => new AutoUpdateError({ detail: `ssh key write failed: ${error.detail}` }),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, spawner),
      ),
    );
  };

  const testSsh = (key: SshKeySourceInput): Effect.Effect<CredentialTestResult, AutoUpdateError> =>
    Effect.gen(function* () {
      const keyPath = yield* resolveSshKeyPath(key);
      return yield* provideLocal(testGitOnUrl(gitSshUrl, buildSshEnv({ keyPath })));
    });

  const testWebCreds = (
    credentials: UserPassCredentialsInput,
  ): Effect.Effect<CredentialTestResult> =>
    Effect.gen(function* () {
      if (webUrl.trim() === "") {
        return {
          ok: false,
          class: null,
          code: null,
          latencyMs: null,
          raw: "web source is not configured",
        };
      }
      const probe = yield* probeWeb(
        webUrl,
        { username: credentials.username, password: credentials.password },
        httpClient,
      );
      return webTestResult(probe);
    });

  const withGitUrl = (state: AutoUpdateWireState, url: string): AutoUpdateWireState => ({
    ...state,
    git: { ...state.git, url, offered: url !== "" },
  });

  const saveGitHttps = (
    credentials: UserPassCredentialsInput,
  ): Effect.Effect<AutoUpdateWireState, AutoUpdateError> =>
    Effect.gen(function* () {
      const test = yield* testGitHttps(credentials);
      if (!test.ok) {
        return yield* new AutoUpdateError({
          detail: test.raw ?? "credential test failed",
          code: "creds-test-failed",
        });
      }
      yield* credStore
        .saveHttps({ username: credentials.username, password: credentials.password })
        .pipe(
          Effect.mapError(
            () =>
              new AutoUpdateError({ detail: "credential save failed", code: "creds-save-failed" }),
          ),
        );
      const savedAt = yield* Clock.currentTimeMillis;
      const next = yield* mutate("git https saved", (s) =>
        withGitUrl(
          T.credentialsSaved(
            s,
            { authVia: "https", httpsCred: { username: credentials.username, savedAt } },
            savedAt,
          ),
          gitHttpsUrl,
        ),
      );
      yield* Effect.logDebug("[auto-update] credentials saved", {
        source: "git",
        authVia: "https",
      });
      yield* probeSource("git").pipe(Effect.forkDetach);
      return next;
    });

  const saveSsh = (key: SshKeySourceInput): Effect.Effect<AutoUpdateWireState, AutoUpdateError> =>
    Effect.gen(function* () {
      const keyPath = yield* resolveSshKeyPath(key);
      const test = yield* provideLocal(testGitOnUrl(gitSshUrl, buildSshEnv({ keyPath })));
      if (!test.ok) {
        return yield* new AutoUpdateError({
          detail: test.raw ?? "credential test failed",
          code: "creds-test-failed",
        });
      }
      const info = yield* provideLocal(
        readPublicInfo(keyPath).pipe(
          Effect.mapError(
            (error) => new AutoUpdateError({ detail: `ssh key unreadable: ${error.detail}` }),
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, spawner),
        ),
      );
      const livePath = key.origin === "file" ? keyPath : sshKeyPath;
      if (key.origin !== "file") {
        yield* provideLocal(promoteStagedKey(sshKeyPath)).pipe(
          Effect.mapError(
            () =>
              new AutoUpdateError({ detail: "credential save failed", code: "creds-save-failed" }),
          ),
        );
      }
      yield* credStore
        .saveSsh({ path: livePath, origin: key.origin, fingerprint: info.fingerprint })
        .pipe(
          Effect.mapError(
            () =>
              new AutoUpdateError({ detail: "credential save failed", code: "creds-save-failed" }),
          ),
        );
      const savedAt = yield* Clock.currentTimeMillis;
      const next = yield* mutate("git ssh saved", (s) =>
        withGitUrl(
          T.credentialsSaved(
            s,
            {
              authVia: "ssh",
              sshCred: {
                fingerprint: info.fingerprint,
                keyType: "ed25519",
                savedAt,
                origin: key.origin,
              },
            },
            savedAt,
          ),
          gitSshUrl,
        ),
      );
      yield* Effect.logDebug("[auto-update] credentials saved", { source: "git", authVia: "ssh" });
      yield* probeSource("git").pipe(Effect.forkDetach);
      return next;
    });

  const generateSshKey: Effect.Effect<GeneratedSshKeyInfo, AutoUpdateError> = Effect.gen(
    function* () {
      const generated = yield* provideLocal(
        generateDeployKey(sshKeyStagingPath).pipe(
          Effect.mapError(
            (error) =>
              new AutoUpdateError({
                detail: `keygen failed: ${error.detail}`,
                code: "keygen-failed",
              }),
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, spawner),
        ),
      );
      yield* Effect.logDebug("[auto-update] ssh key generated", {
        fingerprint: generated.fingerprint,
      });
      return {
        publicKey: generated.publicKey,
        fingerprint: generated.fingerprint,
        path: generated.path,
      };
    },
  );

  const clearGitCreds: Effect.Effect<AutoUpdateWireState, AutoUpdateError> = Effect.gen(
    function* () {
      yield* credStore.clear("https").pipe(Effect.orElseSucceed(() => undefined));
      yield* credStore.clear("ssh").pipe(Effect.orElseSucceed(() => undefined));
      // A key the user generated or pasted and then never saved has no owner left.
      yield* provideLocal(discardStagedKey(sshKeyPath));
      const next = yield* mutate("git creds cleared", (s) =>
        withGitUrl(
          { ...s, git: { ...s.git, authVia: "ambient", httpsCred: null, sshCred: null } },
          gitSshUrl,
        ),
      );
      yield* Effect.logDebug("[auto-update] credentials cleared", { source: "git" });
      return next;
    },
  );

  const saveWebCreds = (
    credentials: UserPassCredentialsInput,
  ): Effect.Effect<AutoUpdateWireState, AutoUpdateError> =>
    Effect.gen(function* () {
      const test = yield* testWebCreds(credentials);
      if (!test.ok) {
        return yield* new AutoUpdateError({
          detail: test.raw ?? "credential test failed",
          code: "creds-test-failed",
        });
      }
      yield* credStore
        .saveWeb({ username: credentials.username, password: credentials.password })
        .pipe(
          Effect.mapError(
            () =>
              new AutoUpdateError({ detail: "credential save failed", code: "creds-save-failed" }),
          ),
        );
      const savedAt = yield* Clock.currentTimeMillis;
      const next = yield* mutate("web creds saved", (s) =>
        T.credentialsSaved(
          s,
          { authVia: "web", cred: { username: credentials.username, savedAt } },
          savedAt,
        ),
      );
      yield* Effect.logDebug("[auto-update] credentials saved", { source: "web", authVia: "web" });
      yield* probeSource("web").pipe(Effect.forkDetach);
      return next;
    });

  const clearWebCreds: Effect.Effect<AutoUpdateWireState, AutoUpdateError> = Effect.gen(
    function* () {
      yield* credStore.clear("web").pipe(Effect.orElseSucceed(() => undefined));
      const next = yield* mutate("web creds cleared", (s) => ({
        ...s,
        web: { ...s.web, cred: null },
      }));
      yield* Effect.logDebug("[auto-update] credentials cleared", { source: "web" });
      return next;
    },
  );

  const engine: UpdateEngine["Service"] = {
    state: snapshot,
    changes: SubscriptionRef.changes(stateRef),

    setAutoCheck: (enabled) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* mutate("auto-check", (s) =>
          T.setAutoCheck(s, enabled, now, (n) => nextTickAt(n, jitterMinute)),
        );
      }),

    toggleSource: (kind, enabled) =>
      mutate("toggle source", (s) => T.toggleSource(s, kind, enabled)),

    setNotifyPrefs: (prefs) => mutate("notify prefs", (s) => T.setNotifyPrefs(s, prefs)),

    testGitHttps,
    saveGitHttps,
    generateSshKey,
    testSsh,
    saveSsh,
    clearGitCreds,
    testWebCreds,
    saveWebCreds,
    clearWebCreds,

    probeSource,
    checkNow: checkNowCommand,

    install,
    retryRun,

    snoozeNotification: (kind) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* mutate("notice stamped", (s) => T.markNotified(s, kind, now));
      }),
  };

  // ru-code: arm the default-off same-origin test-trigger (see apply/testTriggerRoute.ts). ONLY
  // under RU_CODE_UPDATE_TEST_TRIGGER=1 — the live-cycle integration harness posts to drive one
  // real press (checkNow → install) because the authenticated ws RPC handshake is impractical
  // head-lessly. performTick/install require no context, so the default runtime runs them; the
  // shared SubscriptionRef + applyLock make this fiber tree see the same engine state.
  if (process.env[AUTO_UPDATE_TEST_TRIGGER_ENV] === "1") {
    const press = performTick.pipe(
      Effect.andThen(installToCompletion),
      Effect.map(
        (state): AutoUpdateTestPressResult => ({
          status: state.status.phase,
          runPhase: state.run?.phase ?? null,
          errorCode: state.run?.error?.code ?? null,
          refused: false,
        }),
      ),
      Effect.catch((error: AutoUpdateError) =>
        Effect.succeed<AutoUpdateTestPressResult>({
          status: "",
          runPhase: null,
          errorCode: error.code ?? null,
          refused: true,
        }),
      ),
    );
    // The callback is handed to a plain HTTP route handler, which is outside any Effect. `press`
    // is `R = never` (it typechecks under runPromise), so no service is lost — only the surrounding
    // logger/clock/fiber-refs, in a seam that is off unless RU_CODE_UPDATE_TEST_TRIGGER=1.
    // @effect-diagnostics-next-line runEffectInsideEffect:off - see above
    setAutoUpdateTestPress(() => Effect.runPromise(press));
    yield* Effect.logDebug("[auto-update] test-trigger route armed");
  }

  // ── facts refresh (#13): poll the sentinel until the port shows, then patch ──
  const factsRefreshFiber = Effect.gen(function* () {
    for (let attempt = 0; attempt < FACTS_REFRESH_TRIES; attempt += 1) {
      const facts = yield* provideLocal(factsReader);
      if (facts.port !== 0) {
        yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, facts }));
        yield* Effect.logDebug("[auto-update] facts refreshed", { port: facts.port });
        return;
      }
      yield* Effect.sleep(Duration.seconds(1));
    }
  });
  yield* factsRefreshFiber.pipe(Effect.forkScoped);

  // ── scheduler: UPDATE_SCHEDULER_BEAT_MS beat; the first tick only when due ───
  const schedulerBeat = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* snapshot;
    const decision = T.scheduleBeatDecision(state, now);
    if (decision !== "tick") {
      // "not due" is the common case and stays silent; a real block is worth a line.
      if (decision !== "not-due") {
        yield* Effect.logDebug("[auto-update] scheduler skip", { reason: decision });
      }
      return;
    }
    yield* performTick;
    const tickedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(stateRef, (s) => ({
      ...s,
      nextCheckAt: nextTickAt(tickedAt, jitterMinute),
    }));
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("[auto-update] scheduler beat failed", { cause })),
  );
  yield* schedulerBeat.pipe(
    Effect.andThen(Effect.sleep(Duration.millis(UPDATE_SCHEDULER_BEAT_MS))),
    Effect.forever,
    Effect.forkScoped,
  );

  yield* Effect.logDebug("[auto-update] boot facts", {
    updatable: layout.updatable,
    appRoot,
    currentVersion,
    autoCheck: config.autoCheck,
  });

  return engine;
});

/** The Live layer. Requires the platform services + ServerConfig from the host. */
export const UpdateEngineLive: Layer.Layer<
  UpdateEngine,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ProcessRunner.ProcessRunner
  | ServerConfig.ServerConfig
> = Layer.effect(UpdateEngine, makeUpdateEngine);
