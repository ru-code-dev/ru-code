// ru-code: Auto-update RPC definitions (v3 — stateless check machine +
// pointer/wrapper apply). The host spreads `autoUpdateRpcs` into its
// `WsRpcGroup.make(...)` (marked seam in packages/contracts/src/rpc.ts).
// Method names are stable literal wire tags.
//
// Command-set invariants (ratified design — see to-do.md):
//   · NO URL setters — links are baked branding constants
//   · NO frequency/policy — auto-check is a single on/off switch
//   · NO rollback — recovery is reinstall
//   · `install` is the ONLY trigger for download+flip+restart (user press)
//   · credential saves happen ONLY after a passing test (wizard enforces;
//     the server re-tests on save as the hard guarantee)

import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../../auth.ts";
import {
  AutoUpdateError,
  AutoUpdateWireState,
  CredentialTestResult,
  GeneratedSshKeyInfo,
  SshKeySourceInput,
  UpdateNotifyKind,
  UpdateSourceKind,
  UserPassCredentialsInput,
} from "./model.ts";

/** Literal-keyed method map (host WS_METHODS retains literal typing through a spread). */
export const AUTO_UPDATE_METHODS = {
  autoUpdateGetState: "autoUpdate.getState",
  autoUpdateSetAutoCheck: "autoUpdate.setAutoCheck",
  autoUpdateToggleSource: "autoUpdate.toggleSource",
  autoUpdateSetNotifyPrefs: "autoUpdate.setNotifyPrefs",
  autoUpdateTestGitHttps: "autoUpdate.testGitHttps",
  autoUpdateSaveGitHttps: "autoUpdate.saveGitHttps",
  autoUpdateGenerateSshKey: "autoUpdate.generateSshKey",
  autoUpdateTestSsh: "autoUpdate.testSsh",
  autoUpdateSaveSsh: "autoUpdate.saveSsh",
  autoUpdateClearGitCreds: "autoUpdate.clearGitCreds",
  autoUpdateTestWebCreds: "autoUpdate.testWebCreds",
  autoUpdateSaveWebCreds: "autoUpdate.saveWebCreds",
  autoUpdateClearWebCreds: "autoUpdate.clearWebCreds",
  autoUpdateProbeSource: "autoUpdate.probeSource",
  autoUpdateCheckNow: "autoUpdate.checkNow",
  autoUpdateInstall: "autoUpdate.install",
  autoUpdateRetryRun: "autoUpdate.retryRun",
  autoUpdateSnoozeNotification: "autoUpdate.snoozeNotification",
  subscribeAutoUpdate: "subscribeAutoUpdate",
} as const;
export type AutoUpdateMethods = typeof AUTO_UPDATE_METHODS;

const stateError = Schema.Union([AutoUpdateError, EnvironmentAuthorizationError]);

/** One-shot full state (the subscription is the primary read path). */
export const WsAutoUpdateGetStateRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateGetState, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/** The auto-check switch. On → the hourly working-hours tick runs; off → zero background traffic. */
export const WsAutoUpdateSetAutoCheckRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateSetAutoCheck, {
  payload: Schema.Struct({ enabled: Schema.Boolean }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Flip a source's USER-owned switch. Never touched by the engine itself. */
export const WsAutoUpdateToggleSourceRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateToggleSource, {
  payload: Schema.Struct({ kind: UpdateSourceKind, enabled: Schema.Boolean }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** The two notification mute toggles. */
export const WsAutoUpdateSetNotifyPrefsRpc = Rpc.make(
  AUTO_UPDATE_METHODS.autoUpdateSetNotifyPrefs,
  {
    payload: Schema.Struct({ releasesMuted: Schema.Boolean, problemsMuted: Schema.Boolean }),
    success: AutoUpdateWireState,
    error: stateError,
  },
);

/** Test git-over-https user/password via one `git ls-remote` attempt. Does NOT persist. */
export const WsAutoUpdateTestGitHttpsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateTestGitHttps, {
  payload: Schema.Struct({ credentials: UserPassCredentialsInput }),
  success: CredentialTestResult,
  error: stateError,
});

/** Persist git-https credentials (cipher file). Server re-tests before persisting; success unpauses. */
export const WsAutoUpdateSaveGitHttpsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateSaveGitHttps, {
  payload: Schema.Struct({ credentials: UserPassCredentialsInput }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Generate a passphrase-less ed25519 deploy key at the dedicated path (0600). */
export const WsAutoUpdateGenerateSshKeyRpc = Rpc.make(
  AUTO_UPDATE_METHODS.autoUpdateGenerateSshKey,
  {
    payload: Schema.Struct({}),
    success: GeneratedSshKeyInfo,
    error: stateError,
  },
);

/** Test an SSH key via one `git ls-remote` attempt (`-i <path> -o IdentitiesOnly=yes`). */
export const WsAutoUpdateTestSshRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateTestSsh, {
  payload: Schema.Struct({ key: SshKeySourceInput }),
  success: CredentialTestResult,
  error: stateError,
});

/** Persist the SSH key config. Server re-tests before persisting; success unpauses. */
export const WsAutoUpdateSaveSshRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateSaveSsh, {
  payload: Schema.Struct({ key: SshKeySourceInput }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Remove stored git credentials (both kinds) → `authVia: ambient`. */
export const WsAutoUpdateClearGitCredsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateClearGitCreds, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Test web basic-auth via one manifest GET. Does NOT persist. */
export const WsAutoUpdateTestWebCredsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateTestWebCreds, {
  payload: Schema.Struct({ credentials: UserPassCredentialsInput }),
  success: CredentialTestResult,
  error: stateError,
});

/** Persist web basic-auth credentials. Server re-tests before persisting; success unpauses. */
export const WsAutoUpdateSaveWebCredsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateSaveWebCreds, {
  payload: Schema.Struct({ credentials: UserPassCredentialsInput }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Remove stored web credentials (anonymous requests). */
export const WsAutoUpdateClearWebCredsRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateClearWebCreds, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/**
 * Manual «Проверить» on one source card. Always allowed — including on a paused
 * source (this is the unpause path: a success resets authFails/streaks).
 * Explicit user action, so a credentialed attempt is allowed here.
 */
export const WsAutoUpdateProbeSourceRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateProbeSource, {
  payload: Schema.Struct({ kind: UpdateSourceKind }),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Run a full tick now (git → web, first success wins). The hero-level manual check. */
export const WsAutoUpdateCheckNowRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateCheckNow, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/**
 * THE user press. Starts the server-owned install run: download → verify
 * (sha256 + per-file checksums) → flip the pointer → spawn the detached restart.
 * Runs to completion regardless of any client. Try-acquire: a second press
 * while a run is live is a no-op.
 */
export const WsAutoUpdateInstallRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateInstall, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/** Retry a failed run (corrupted download deleted — re-download from scratch). */
export const WsAutoUpdateRetryRunRpc = Rpc.make(AUTO_UPDATE_METHODS.autoUpdateRetryRun, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
});

/**
 * Stamp a notice as delivered — sent BOTH when a surface raises it and when the user waves it
 * away, because the effect is identical: quiet until the re-raise window passes. One server record
 * per kind, so the pill, the toast and every other tab share one clock.
 */
export const WsAutoUpdateSnoozeNotificationRpc = Rpc.make(
  AUTO_UPDATE_METHODS.autoUpdateSnoozeNotification,
  {
    payload: Schema.Struct({ kind: UpdateNotifyKind }),
    success: AutoUpdateWireState,
    error: stateError,
  },
);

/** Live state stream (sources/status/run changes). */
export const WsSubscribeAutoUpdateRpc = Rpc.make(AUTO_UPDATE_METHODS.subscribeAutoUpdate, {
  payload: Schema.Struct({}),
  success: AutoUpdateWireState,
  error: stateError,
  stream: true,
});

/** All auto-update RPCs, ready to spread into the host's `RpcGroup.make(...)`. */
export const autoUpdateRpcs = [
  WsAutoUpdateGetStateRpc,
  WsAutoUpdateSetAutoCheckRpc,
  WsAutoUpdateToggleSourceRpc,
  WsAutoUpdateSetNotifyPrefsRpc,
  WsAutoUpdateTestGitHttpsRpc,
  WsAutoUpdateSaveGitHttpsRpc,
  WsAutoUpdateGenerateSshKeyRpc,
  WsAutoUpdateTestSshRpc,
  WsAutoUpdateSaveSshRpc,
  WsAutoUpdateClearGitCredsRpc,
  WsAutoUpdateTestWebCredsRpc,
  WsAutoUpdateSaveWebCredsRpc,
  WsAutoUpdateClearWebCredsRpc,
  WsAutoUpdateProbeSourceRpc,
  WsAutoUpdateCheckNowRpc,
  WsAutoUpdateInstallRpc,
  WsAutoUpdateRetryRunRpc,
  WsAutoUpdateSnoozeNotificationRpc,
  WsSubscribeAutoUpdateRpc,
] as const;
