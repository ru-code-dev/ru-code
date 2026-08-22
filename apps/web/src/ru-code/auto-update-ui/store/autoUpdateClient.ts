// ru-code: the REAL server-backed action half of the auto-update store — promise
// wrappers over the environment-scoped RPC commands, exactly like the MCP client
// (ru-code/mcp/mcpActions.ts). Each call runs against the PRIMARY environment and
// unwraps the settled AsyncResult into resolve/reject; the `subscribeAutoUpdate`
// stream (./autoUpdateSubscription) pushes the resulting state back — these
// wrappers never mutate a local mirror.
//
// This module also owns the SW-mirror push (issue #12): the mirror is PUSHED on
// every snapshot (deduped by facts), and the update marker is RE-ASSERTED the moment
// a run enters the `restart` phase (the server is about to die — the SW page must
// take over the blind window). Clearing the marker belongs to the handover decision
// (notify/handoverDecision.ts), not here.

import {
  AUTO_UPDATE_METHODS,
  type AutoUpdateWireState,
  type CredentialTestResult,
  type GeneratedSshKeyInfo,
  type SshKeySourceInput,
  type UpdateNotifyKind,
  type UpdateSourceKind,
  type UserPassCredentialsInput,
} from "@t3tools/contracts";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { getLocale } from "@ru-code/localization";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { markUpdateActive, pushSwMirror, type MirrorFacts } from "../../sw/swMirror";
import { getAutoUpdateWireState } from "./autoUpdateSubscription";

// ── RPC runner (mirrors mcpActions.runMcpRpc; resolves value, rejects squashed) ─

/** Raised when no environment is connected — the action layer turns this into a visible error. */
export class AutoUpdateNotConnectedError extends Error {
  readonly code = "not-connected";
  constructor() {
    super("auto-update: no primary environment connected");
    this.name = "AutoUpdateNotConnectedError";
  }
}

async function runAutoUpdateRpc<TTag extends EnvironmentUnaryRpcTag>(
  tag: TTag,
  label: string,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    throw new AutoUpdateNotConnectedError();
  }
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, { label, tag });
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

/** True once the live subscription has delivered a snapshot (⇒ session connected). */
export function isAutoUpdateConnected(): boolean {
  return getAutoUpdateWireState() !== null;
}

// ── config / source / notification actions ─────────────────────────────────────

export function setAutoCheck(enabled: boolean): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateSetAutoCheck, "auto-update:setAutoCheck", {
    enabled,
  });
}

export function toggleSource(
  kind: UpdateSourceKind,
  enabled: boolean,
): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateToggleSource, "auto-update:toggleSource", {
    kind,
    enabled,
  });
}

export function setNotifyPrefs(prefs: {
  releasesMuted: boolean;
  problemsMuted: boolean;
}): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(
    AUTO_UPDATE_METHODS.autoUpdateSetNotifyPrefs,
    "auto-update:setNotifyPrefs",
    prefs,
  );
}

// ── git credentials ─────────────────────────────────────────────────────────────

export function testGitHttps(credentials: UserPassCredentialsInput): Promise<CredentialTestResult> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateTestGitHttps, "auto-update:testGitHttps", {
    credentials,
  });
}

export function saveGitHttps(credentials: UserPassCredentialsInput): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateSaveGitHttps, "auto-update:saveGitHttps", {
    credentials,
  });
}

export function generateSshKey(): Promise<GeneratedSshKeyInfo> {
  return runAutoUpdateRpc(
    AUTO_UPDATE_METHODS.autoUpdateGenerateSshKey,
    "auto-update:generateSshKey",
    {},
  );
}

export function testSsh(key: SshKeySourceInput): Promise<CredentialTestResult> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateTestSsh, "auto-update:testSsh", { key });
}

export function saveSsh(key: SshKeySourceInput): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateSaveSsh, "auto-update:saveSsh", {
    key,
  });
}

export function clearGitCreds(): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(
    AUTO_UPDATE_METHODS.autoUpdateClearGitCreds,
    "auto-update:clearGitCreds",
    {},
  );
}

// ── web credentials ─────────────────────────────────────────────────────────────

export function testWebCreds(credentials: UserPassCredentialsInput): Promise<CredentialTestResult> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateTestWebCreds, "auto-update:testWebCreds", {
    credentials,
  });
}

export function saveWebCreds(credentials: UserPassCredentialsInput): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateSaveWebCreds, "auto-update:saveWebCreds", {
    credentials,
  });
}

export function clearWebCreds(): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(
    AUTO_UPDATE_METHODS.autoUpdateClearWebCreds,
    "auto-update:clearWebCreds",
    {},
  );
}

// ── check / install lifecycle ────────────────────────────────────────────────────

export function probeSource(kind: UpdateSourceKind): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateProbeSource, "auto-update:probeSource", {
    kind,
  });
}

export function checkNow(): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateCheckNow, "auto-update:checkNow", {});
}

/** THE user press — writes the SW marker (blind-window guard), then calls `install`. */
export function install(): Promise<AutoUpdateWireState> {
  const wire = getAutoUpdateWireState();
  if (wire !== null) {
    const target =
      wire.status.phase === "available" ? wire.status.release.version : wire.currentVersion;
    markUpdateActive({ targetVersion: target, fromVersion: wire.currentVersion });
  }
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateInstall, "auto-update:install", {});
}

export function retryRun(): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateRetryRun, "auto-update:retryRun", {});
}

export function snoozeNotification(kind: UpdateNotifyKind): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(
    AUTO_UPDATE_METHODS.autoUpdateSnoozeNotification,
    "auto-update:snoozeNotification",
    {
      kind,
    },
  );
}

export function getState(): Promise<AutoUpdateWireState> {
  return runAutoUpdateRpc(AUTO_UPDATE_METHODS.autoUpdateGetState, "auto-update:getState", {});
}

// ── SW mirror push + marker reconcile (issue #12) ────────────────────────────────

function factsFromWire(wire: AutoUpdateWireState): MirrorFacts {
  return {
    version: wire.currentVersion,
    locale: getLocale(),
    address: wire.facts.address,
    installDir: wire.facts.installDir,
    port: wire.facts.port,
    pid: wire.facts.pid,
  };
}

let lastMirrorKey: string | null = null;

/**
 * Push the SW mirror for this snapshot (deduped by facts — cheap, idempotent) and
 * re-assert the update marker the moment a run enters `restart` (the server is about
 * to die — the SW page must own the blind window).
 *
 * CLEARING the marker is deliberately NOT here: it is one half of the handover rule
 * and lives with the other half in `notify/handoverDecision.ts`, driven by
 * `useAutoUpdateDriver`. Two owners of "clear" is how a healthy boot ended up unable
 * to drop a marker it should have dropped (the app ↔ SW-page reload loop). The
 * hero states that predicate used to miss — `attention`, `apply-failed`,
 * `run-failed` — now clear it like any other run-less snapshot.
 */
export function syncSwMirror(wire: AutoUpdateWireState): void {
  const facts = factsFromWire(wire);
  const key = `${facts.version}|${facts.address}|${facts.installDir}|${facts.port}|${facts.pid}|${facts.locale}`;
  if (key !== lastMirrorKey) {
    lastMirrorKey = key;
    pushSwMirror(facts);
  }

  if (wire.run !== null && wire.run.phase === "restart") {
    markUpdateActive({ targetVersion: wire.run.targetVersion, fromVersion: wire.run.fromVersion });
  }
}
