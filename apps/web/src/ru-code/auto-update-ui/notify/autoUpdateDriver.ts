// ru-code: the ONE app-root auto-update driver (mounted exactly once, by
// AutoUpdateDriverMount at the router root — NOT by the sidebar pill, which the
// sidebar swaps out on `/settings/*`). It watches the single derived UI state and drives the
// two side effects the pure `computeDriverDecision` decides (audit #6):
//   a. «Доступна vX» toast  — Установить / Что нового / Позже, over REAL release
//      facts; deduped per tab session, gated by the server stamp;
//   b. «Настройте обновления» toast — the master problem rule;
// plus (c) the RESTART HANDOVER: when a tab that HAD the server loses it under a
// fresh update marker, this tab reloads, the navigation fails, and the service
// worker's full-screen update page replaces the whole site. There is no in-app
// update route to redirect to any more (F16) — the press stays on the settings
// hero, and the SW owns the blind window. The same effect clears the marker once a
// live server proves the update is over; both verbs come from `decideHandover`.
//
// Both toast surfaces stamp `notified.<kind>` the moment they RAISE (and again if
// the user waves them away) — the server record IS the 2h clock, so a second tab
// and a restart both stay quiet. Nothing is kept in browser storage.
//
// Zero policy lives here: the decision is pure and table-tested; this hook is the
// imperative shell (toast I/O, navigation, session dedupe, the reload).

import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { UPDATE_INAPP_POLL_MS } from "@ru-code/branding";

import { clearUpdateMarker, readUpdateMarker } from "../../sw/swMirror";
import { showUpdateAvailableToast, showUpdateProblemsToast } from "../settings/updateToast";
import { autoUpdateConnectedAtom } from "../store/autoUpdateSubscription";
import { getAutoUpdateState, install, snoozeNotification } from "../store/autoUpdateStore";
import { decideHandover } from "./handoverDecision";
import { fetchHealthz, restartWaitDecision } from "./restartWait";
import { computeDriverDecision, problemToastKey, releaseToastKey } from "./notifyDecision";
import { isRunActive, toProblemSignal, toReleaseSignal } from "./stateSignals";
import type { AutoUpdateUiState } from "../model";

const AUTO_UPDATE_SETTINGS_ROUTE = "/settings/auto-update";
const RELEASE_NOTES_HASH = "auto-update-release-notes";

/**
 * The handover latch. It must survive the reload it authorises (a React ref dies with
 * the page and blocks nothing — that was the loop's second half), and it must be
 * scoped to THIS tab, so `sessionStorage`. The value is the marker's `startedAt`: one
 * marker moves this tab once, a genuinely new update still can.
 */
const HANDOVER_LATCH_KEY = "ru-code:auto-update-handover";

function readHandoverLatch(): number | null {
  try {
    const raw = sessionStorage.getItem(HANDOVER_LATCH_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Private mode / storage disabled: the marker's own stale window remains the backstop.
    return null;
  }
}

function writeHandoverLatch(startedAt: number): void {
  try {
    sessionStorage.setItem(HANDOVER_LATCH_KEY, String(startedAt));
  } catch {
    // best-effort, see above
  }
}

/**
 * The single mount seam for the auto-update notifications + the restart handover.
 * Reads the derived state directly (passed by the pill, which already subscribes)
 * so there is exactly one subscriber and one decision per snapshot.
 */
export function useAutoUpdateDriver(state: AutoUpdateUiState | null): void {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  /** Session dedupe: release-toast keys already fired in THIS tab. */
  const firedReleaseKeysRef = useRef<Set<string>>(new Set());
  /** The same, for the problem notice — see `problemToastKey`. */
  const firedProblemKeysRef = useRef<Set<string>>(new Set());

  // The TRANSPORT's own verdict, not "the data atom is empty". `state === null` was used as the
  // drop signal and never fired: `AsyncResult.value` falls back to `previousSuccess`, so a dying
  // server leaves the last snapshot in place forever. Derived to a boolean in the store, so this
  // always-mounted pill re-renders when connectedness FLIPS, not on every connection event.
  const connected = useAtomValue(autoUpdateConnectedAtom);

  /** Set the first time the environment connects — the difference between "booting" and "dropped". */
  const hadConnectionRef = useRef(false);
  // Its own effect, declared BEFORE the handover one so the flag is already true by the time the
  // handover runs in the same commit (and so nothing mutates a ref during render).
  useEffect(() => {
    if (connected) hadConnectionRef.current = true;
  }, [connected]);

  // c. RESTART HANDOVER + marker lifecycle. This tab reloads into the service-worker page ONLY
  // when it HAD the server and lost it under a fresh marker; a live server with no run means the
  // update is over, so the marker is cleared here (this effect is the single clear owner — see
  // `decideHandover`, where the whole rule lives and is table-tested). Marker WRITES belong to the
  // press (`install`) and to `syncSwMirror`'s restart re-assert; nothing here writes one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const marker = await readUpdateMarker();
      if (cancelled) return;
      const decision = decideHandover({
        hadSnapshot: hadConnectionRef.current,
        connected,
        runActive: state !== null && isRunActive(state),
        marker,
        now: Date.now(),
        handedOverFor: readHandoverLatch(),
        restartWaitArmed: state?.run?.phase === "restart",
      });
      if (decision === "clear") {
        clearUpdateMarker();
        return;
      }
      if (decision === "reload" && marker !== null) {
        // Latch BEFORE the reload: the new page reads it back and cannot repeat the hop.
        writeHandoverLatch(marker.startedAt);
        window.location.reload();
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs on a CONNECTION change (the real signal) and on run activity, not on every time tick.
  }, [connected, state?.run?.phase]);

  // d. THE RESTART WAIT. The server is being replaced, so the WS is gone — but this tab is already
  // loaded and can poll /healthz itself (the SW intercepts navigations only, so a plain fetch goes
  // straight out). It stays on the card the user pressed, reloads into the new version the moment
  // it answers, and hands over to the SW page only if the restart overruns its budget. Mounted
  // app-wide, so it works on any route, not just the settings page.
  // Keyed on the restart itself, NOT on `state`: the derived state changes every second (the
  // shared time tick), which would tear down and re-arm the poll on every render.
  const restartTarget =
    state !== null && state.run !== null && state.run.phase === "restart"
      ? state.run.targetVersion
      : null;

  useEffect(() => {
    if (restartTarget === null) return;
    const target = restartTarget;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // When the server was last seen ANSWERING. The escalation budget runs from here, not from the
    // start of the restart, so a server that is up and merely slow to swap keeps resetting it.
    let lastAnswerAtMs = Date.now();

    const tick = async (): Promise<void> => {
      const response = await fetchHealthz();
      if (cancelled) return;
      if (response !== null && response.ok) lastAnswerAtMs = Date.now();
      // Measured from the SAME instant the hero renders (the `run.restart` log event), so the
      // screen and this decision can never disagree about how long the restart has taken.
      const restartedAtMs = getAutoUpdateState()?.run?.restartedAtMs ?? null;
      const elapsedMs = restartedAtMs === null ? 0 : Math.max(0, Date.now() - restartedAtMs);
      const decision = restartWaitDecision(response, target, {
        unreachableMs: Math.max(0, Date.now() - lastAnswerAtMs),
        elapsedMs,
      });
      if (decision.kind === "wait") {
        timer = setTimeout(() => void tick(), UPDATE_INAPP_POLL_MS);
        return;
      }
      if (decision.kind === "success") {
        // The update is over: drop the marker BEFORE reloading, or the fresh navigation would be
        // answered by the SW's «обновляется» page instead of the new app.
        clearUpdateMarker();
        window.location.reload();
        return;
      }
      if (decision.kind === "escalate") {
        // No longer "restarting" — the server is DOWN. Reload: the navigation fails and the
        // SW-served page, which is built for a dead server, takes the screen.
        //
        // Latched exactly like the drop handover, and for the same reason: if the server is in
        // fact ALIVE (a stuck relaunch that never replaced the process), the reload SUCCEEDS, the
        // app comes back to the very same unfinished run, waits out the budget and reloads again —
        // an endless cycle. One hop per marker; after that the hero simply keeps stating the truth.
        const marker = await readUpdateMarker();
        if (cancelled) return;
        const key = marker?.startedAt ?? null;
        if (key !== null && readHandoverLatch() !== key) {
          writeHandoverLatch(key);
          window.location.reload();
        }
        return;
      }
      // `failed` — the server came back on the old version and journalled the failure. The wire
      // will carry it (lastApply) the moment the WS re-pairs, and the hero states it; nothing to
      // do here but stop polling.
    };

    timer = setTimeout(() => void tick(), UPDATE_INAPP_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [restartTarget]);

  useEffect(() => {
    if (state === null) return;

    const now = Date.now();
    const release = toReleaseSignal(state);
    const problem = toProblemSignal(state);
    const decision = computeDriverDecision({
      release,
      problem,
      runActive: isRunActive(state),
      onUpdateSettingsRoute: pathname === AUTO_UPDATE_SETTINGS_ROUTE,
      now,
    });

    // a. «Доступна vX» — fire at most once per (version × quiet window) per tab.
    if (decision.releaseToast !== null && state.release !== null) {
      const version = decision.releaseToast;
      const key = releaseToastKey(version, release.stamp);
      if (!firedReleaseKeysRef.current.has(key)) {
        firedReleaseKeysRef.current.add(key);
        // Raising IS the stamp: every other tab and the next restart stay quiet for the window.
        snoozeNotification("release");
        const notes = state.release;
        showUpdateAvailableToast({
          version,
          releasedAgo: notes.releasedAgo,
          sizeMb: notes.sizeMb,
          onInstall: () => {
            // Take the user to the hero that owns the run; the press itself happens there, so a
            // refusal is answered inline instead of vanishing into another toast.
            void navigate({ to: AUTO_UPDATE_SETTINGS_ROUTE });
            install();
          },
          onShowNotes: () => {
            void navigate({ to: AUTO_UPDATE_SETTINGS_ROUTE, hash: RELEASE_NOTES_HASH });
          },
          onLater: () => {
            snoozeNotification("release");
          },
        });
      }
    }

    // b. «Настройте обновления» — stamping on fire is what silences the OTHER tabs; the key below
    // is what silences THIS one. Both are needed: the stamp is a server write, and a problem notice
    // is raised exactly when things are failing — including the case where the server is gone and
    // the write cannot land at all.
    if (decision.problemToast) {
      const key = problemToastKey(problem.stamp);
      if (!firedProblemKeysRef.current.has(key)) {
        firedProblemKeysRef.current.add(key);
        snoozeNotification("problems");
        showUpdateProblemsToast({
          onConfigure: () => {
            void navigate({ to: AUTO_UPDATE_SETTINGS_ROUTE });
          },
        });
      }
    }
    // `state` stays in the deps deliberately. It is a NEW object every second (the shared
    // relative-time tick recomputes the derived UI state), so this effect re-runs on that tick —
    // and that re-run is what makes a 2h quiet window expire into a fresh notice without a reload.
    // Narrowing the deps to the decision would freeze both re-raise clocks. The two key guards
    // above are what make re-running every second idempotent.
  }, [state, navigate, pathname]);
}
