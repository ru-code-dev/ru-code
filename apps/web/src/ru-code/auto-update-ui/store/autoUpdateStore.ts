// ru-code: the auto-update store — the ONE module every component imports (it
// replaced the old prototype facade). REAL-ONLY: it reads the live subscription
// and calls the server RPCs; there is no mock branch and no mock fallback.
//
// Reads: `useAutoUpdate()` returns the single derived, fully-localized UI state
// (or `null` before the environment connects — consumers render a "not connected"
// state, never stale mock data).
//
// Writes (issue #14): every action awaits its RPC promise and routes a failure
// through the app error surface (a stacked error toast — the same house pattern
// the skills/agents catalog uses). No `void rpc(...)`; a disconnected environment
// becomes a VISIBLE «нет соединения» error, not a silent no-op.

import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import type {
  CredentialTestResult,
  GeneratedSshKeyInfo,
  SshKeySourceInput,
  UpdateNotifyKind,
  UpdateSourceKind,
  UserPassCredentialsInput,
} from "@t3tools/contracts";

import { UPDATE_UI_TICK_ACTIVE_MS, UPDATE_UI_TICK_IDLE_MS } from "@ru-code/branding";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { clearUpdateMarker } from "../../sw/swMirror";

import type { AutoUpdateUiState } from "../model";
import { useRelativeTimeTick } from "../ui-kit/layout";
import * as client from "./autoUpdateClient";
import {
  autoUpdateNowAtom,
  autoUpdateUiStateAtom,
  autoUpdateWireStateAtom,
  getAutoUpdateState,
} from "./autoUpdateSubscription";
import { autoUpdateErrorMessage, isPressRefusalCode } from "./wireToUi";

export { getAutoUpdateState };

// ── reactive read ────────────────────────────────────────────────────────────

/** The single derived UI state, or null before the environment connects. */
export function useAutoUpdate(): AutoUpdateUiState | null {
  return useAtomValue(autoUpdateUiStateAtom);
}

/**
 * App-level side effects: drive the shared relative-time tick into the derived
 * atom, and push the SW mirror / reconcile the update marker on every snapshot
 * (issue #12/#23/#30 — ONE effect, mounted once at the app root by
 * AutoUpdateDriverMount, not inside the per-component read hook).
 *
 * The tick is ADAPTIVE. It is mounted app-wide and for the whole life of the tab, so a fixed 1 Hz
 * meant re-deriving the entire UI state and re-rendering every subscriber once a second forever —
 * to serve a second hand that only exists during a run and two clocks whose window is two hours.
 * A live run gets the real second hand; idle gets a minute. See UPDATE_UI_TICK_*.
 */
export function useAutoUpdateMirrorSync(): void {
  const wire = useAtomValue(autoUpdateWireStateAtom);
  // A terminally failed run is not live: it changes nothing per second and must not pin the fast
  // cadence for the rest of the session (the same trap `busy` fell into on the hero).
  const runLive = wire?.run != null && wire.run.phase !== "failed";
  const nowMs = useRelativeTimeTick(runLive ? UPDATE_UI_TICK_ACTIVE_MS : UPDATE_UI_TICK_IDLE_MS);

  useEffect(() => {
    appAtomRegistry.set(autoUpdateNowAtom, nowMs);
  }, [nowMs]);

  useEffect(() => {
    if (wire !== null) client.syncSwMirror(wire);
  }, [wire]);
}

// ── error routing (the app error surface) ───────────────────────────────────────

function errorParts(error: unknown): { code?: string; detail: string } {
  if (error !== null && typeof error === "object") {
    const record = error as { code?: unknown; detail?: unknown; message?: unknown };
    const detail =
      typeof record.detail === "string"
        ? record.detail
        : typeof record.message === "string"
          ? record.message
          : "";
    return typeof record.code === "string" ? { code: record.code, detail } : { detail };
  }
  return { detail: String(error) };
}

function reportActionError(error: unknown): void {
  const { title, description } = autoUpdateErrorMessage(errorParts(error));
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/** Await a fire-and-forget action's promise and surface any failure as an error toast. */
function handle(promise: Promise<unknown>): void {
  promise.catch(reportActionError);
}

/**
 * The press path. A REFUSAL is already on screen — the server recorded it in `pressRefusal` and the
 * settings hero states it inline with the matching action — so toasting it too would stack a second
 * (and, before the wire carried params, an English) copy of the same message on top of the page the
 * user is looking at. Everything else (no connection, an unexpected throw) still surfaces.
 *
 * A rejected press ALSO drops the update marker `client.install` wrote before sending. The marker
 * is the service worker's authority to answer a failed navigation with the full-screen
 * «обновляется…» page, and after a refusal there is no update — but the marker stayed fresh for
 * five minutes, and the driver's handover effect could not clear it because neither of its inputs
 * changes on a refusal. The dangerous half is that the commonest refusal is `sources-unreachable`,
 * i.e. the network is ALREADY failing: one dropped connection inside that window and the tab
 * reloaded itself into a page announcing an update that never started.
 */
function handlePress(promise: Promise<unknown>): void {
  promise.catch((error: unknown) => {
    clearUpdateMarker();
    if (isPressRefusalCode(errorParts(error).code)) return;
    reportActionError(error);
  });
}

// ── config / source / notification actions ─────────────────────────────────────

export function setAutoCheck(enabled: boolean): void {
  handle(client.setAutoCheck(enabled));
}

export function toggleSource(kind: UpdateSourceKind, enabled: boolean): void {
  handle(client.toggleSource(kind, enabled));
}

export function setNotifyPrefs(prefs: { releasesMuted: boolean; problemsMuted: boolean }): void {
  handle(client.setNotifyPrefs(prefs));
}

// ── git credentials ─────────────────────────────────────────────────────────────

/** Wizard test-before-save — the wizard shows the result inline, so the promise is returned. */
export function testGitHttps(credentials: UserPassCredentialsInput): Promise<CredentialTestResult> {
  return client.testGitHttps(credentials);
}

/**
 * Save and REPORT. The wizard needs the verdict — it used to call a void action and advance to its
 * green «Вход выполнен» screen unconditionally, so a save the server refused produced a success
 * screen with a red toast on top of it and no credential stored. The promise is returned so the
 * step can follow the fact; the toast still fires, because a failure is worth stating twice on the
 * one screen where the user is waiting for an answer.
 */
export function saveGitHttps(credentials: UserPassCredentialsInput): Promise<unknown> {
  const promise = client.saveGitHttps(credentials);
  handle(promise);
  return promise;
}

export function generateSshKey(): Promise<GeneratedSshKeyInfo> {
  return client.generateSshKey();
}

export function testSsh(key: SshKeySourceInput): Promise<CredentialTestResult> {
  return client.testSsh(key);
}

export function saveSsh(key: SshKeySourceInput): Promise<unknown> {
  const promise = client.saveSsh(key);
  handle(promise);
  return promise;
}

export function clearGitCreds(): void {
  handle(client.clearGitCreds());
}

// ── web credentials ─────────────────────────────────────────────────────────────

export function testWebCreds(credentials: UserPassCredentialsInput): Promise<CredentialTestResult> {
  return client.testWebCreds(credentials);
}

export function saveWebCreds(credentials: UserPassCredentialsInput): Promise<unknown> {
  const promise = client.saveWebCreds(credentials);
  handle(promise);
  return promise;
}

export function clearWebCreds(): void {
  handle(client.clearWebCreds());
}

// ── check / install lifecycle ────────────────────────────────────────────────────

export function probeSource(kind: UpdateSourceKind): void {
  handle(client.probeSource(kind));
}

export function checkNow(): void {
  handle(client.checkNow());
}

/**
 * Send a press. There is no client-side lock any more: the SERVER publishes `pressInFlight` before
 * it starts resolving and clears it with a finalizer that fires on refusal, on run start, on defect
 * and on interrupt — so the buttons follow a fact instead of a click, and there is nothing local
 * that a wall-clock watchdog would have to release. A server that dies takes the whole state with
 * it, and the UI renders disconnected rather than locked.
 *
 * The synchronous throw is still caught: `client.install` touches the SW mirror before it sends
 * anything, and storage can throw before a promise exists.
 */
function press(start: () => Promise<unknown>): void {
  try {
    handlePress(start());
  } catch (error) {
    reportActionError(error);
  }
}

export function install(): void {
  press(() => client.install());
}

export function retryRun(): void {
  press(() => client.retryRun());
}

/**
 * Stamp a notice as delivered — called both when a surface RAISES it and when the user waves it
 * away (the effect is the same: quiet until the re-raise window passes). Server-owned, so every
 * tab agrees and nothing is kept in browser storage.
 */
export function snoozeNotification(kind: UpdateNotifyKind): void {
  handle(client.snoozeNotification(kind));
}
