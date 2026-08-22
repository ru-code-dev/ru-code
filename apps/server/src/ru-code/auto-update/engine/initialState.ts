// ru-code: builds the boot-time AutoUpdateWireState PURELY from persisted config,
// the redacted credential metadata, the baked source links and environment facts.
// NO probes, NO network — the hero is derived from what survived the last run
// (to-do §3): the settings page renders truthfully the instant the server boots,
// before any check has fired. `offered` reflects whether the build baked a link
// for the source; `nextCheckAt` and `lastApply` are computed/read by the engine
// (schedule + jitter, journal) and passed in — this module stays free of clocks.

import type {
  AutoUpdateWireState,
  GitAuthVia,
  GitSourceWire,
  LastApplyWire,
  SshCredMeta,
  UpdateEnvFactsWire,
  UserPassCredMeta,
  WebSourceWire,
} from "@t3tools/contracts";

import type { AutoUpdateConfig } from "./configStore.ts";
import { currentAvailableRelease, deriveHero } from "./transitions.ts";

/** Redacted, wire-safe credential metadata (secrets stay in the encrypted store). */
export interface CredMetaForState {
  readonly git: {
    readonly authVia: GitAuthVia;
    readonly httpsCred: UserPassCredMeta | null;
    readonly sshCred: SshCredMeta | null;
  };
  readonly web: {
    readonly cred: UserPassCredMeta | null;
  };
}

export function buildInitialState(params: {
  readonly config: AutoUpdateConfig;
  readonly facts: UpdateEnvFactsWire;
  readonly currentVersion: string;
  /** The baked git link ("" when the build offers no git source). */
  readonly gitUrl: string;
  /** The baked web link ("" when the build offers no web source). */
  readonly webUrl: string;
  readonly credMeta: CredMetaForState;
  /** Epoch ms of the next scheduled tick (engine: schedule+jitter); null when autoCheck is off. */
  readonly nextCheckAt: number | null;
  /** The last apply outcome read from the journal; null when none recorded. */
  readonly lastApply: LastApplyWire | null;
}): AutoUpdateWireState {
  const { config, facts, currentVersion, gitUrl, webUrl, credMeta, nextCheckAt, lastApply } =
    params;

  const git: GitSourceWire = {
    enabled: config.sources.git.enabled,
    offered: gitUrl !== "",
    url: gitUrl,
    paused: config.sources.git.paused,
    authFails: config.sources.git.authFails,
    transportStreak: config.sources.git.transportStreak,
    failingSince: config.sources.git.failingSince,
    lastResult: config.sources.git.lastResult,
    // ru-code: live-only — a fresh process has nothing in flight.
    probing: false,
    authVia: credMeta.git.authVia,
    httpsCred: credMeta.git.httpsCred,
    sshCred: credMeta.git.sshCred,
  };

  const web: WebSourceWire = {
    enabled: config.sources.web.enabled,
    offered: webUrl !== "",
    url: webUrl,
    paused: config.sources.web.paused,
    authFails: config.sources.web.authFails,
    transportStreak: config.sources.web.transportStreak,
    failingSince: config.sources.web.failingSince,
    lastResult: config.sources.web.lastResult,
    probing: false,
    cred: credMeta.web.cred,
  };

  const status = deriveHero({
    availableRelease: config.availableRelease,
    currentVersion,
    sources: [
      {
        enabled: git.enabled,
        offered: git.offered,
        paused: git.paused,
        lastResult: git.lastResult,
      },
      {
        enabled: web.enabled,
        offered: web.offered,
        paused: web.paused,
        lastResult: web.lastResult,
      },
    ],
  });

  return {
    currentVersion,
    facts,
    autoCheck: config.autoCheck,
    nextCheckAt: config.autoCheck ? nextCheckAt : null,
    git,
    web,
    status,
    history: [],
    run: null,
    lastApply,
    notify: config.notify,
    notified: config.notified,
    // A refusal is about the last press in THIS session — never restored from disk.
    pressRefusal: null,
    // Both are live in-memory facts about THIS process — a boot starts with neither.
    pressInFlight: false,
    checking: false,
  };
}

// Re-export for the engine's convenience (single import site for hero helpers).
export { currentAvailableRelease };
