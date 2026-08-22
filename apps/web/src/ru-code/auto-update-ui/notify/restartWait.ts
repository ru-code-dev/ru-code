// ru-code: the pure /healthz-poll decision behind the IN-APP restart wait.
//
// A restart takes 3–10 s (same pinned port, payload already on disk), so the tab does not need to
// go anywhere: it stays on the card the user pressed, polls the tiny same-origin /healthz endpoint
// — which works with the server dead, because the service worker only intercepts NAVIGATIONS
// (sw/sw.ts) — and reloads itself the moment the new version answers. The WS is useless here: it
// is the thing that just died.
//
// Past `UPDATE_INAPP_WAIT_MS` this is no longer "a restart in progress", it is a DOWN server, and
// the SW-served page — built for exactly that — takes over. The app deliberately does NOT grow its
// own manual/dead-app screen: duplicating the SW page inside a page whose server is a corpse is
// the mistake this design avoids.
//
// Machine-only: codes, never sentences (`reasonCode` is localized by wireToUi.lastApplyReason).
// Exhaustively table-tested in tests/auto-update/restartWait.test.ts.

import { UPDATE_INAPP_WAIT_MS, UPDATE_RESTART_CEILING_MS } from "@ru-code/branding";

/** The journalled outcome of the last apply, as carried by /healthz. */
export interface HealthzLastApply {
  readonly targetVersion: string;
  readonly fromVersion: string;
  readonly outcome: "ok" | "failed";
  readonly reasonCode: string | null;
  readonly at: number;
}

/** The /healthz JSON shape this choreography reads (a superset is fine). */
export interface HealthzResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly pid?: number;
  readonly lastApply?: HealthzLastApply | null;
}

/**
 * What the tab should do after one poll.
 * · `success`  — the new version answered; clear the marker and reload into it.
 * · `failed`   — a server answered and its journal says the apply failed; state the reason.
 * · `escalate` — the in-app budget elapsed; reload so the SW page owns the dead server.
 * · `wait`     — nothing conclusive yet; poll again.
 */
export type RestartWaitDecision =
  | { readonly kind: "success"; readonly version: string }
  | { readonly kind: "failed"; readonly reasonCode: string }
  | { readonly kind: "escalate" }
  | { readonly kind: "wait" };

/**
 * Decide from a single poll.
 *
 * The budget measures how long the server has been UNREACHABLE, not how long the restart has been
 * going. That distinction is the whole point: a server that answers — even on the OLD version — is
 * alive and mid-swap, and throwing the user to a full-screen page because a cold start took six
 * seconds is a worse experience than the one the page exists for. The full-screen page is for a
 * DEAD server, so the trigger says exactly that.
 *
 * `elapsedMs` remains as a hard CEILING: a server that answers old-version forever (a relaunch that
 * never replaced the process) would otherwise reset the countdown on every poll and wait for ever.
 */
export function restartWaitDecision(
  response: HealthzResponse | null,
  target: string,
  time: {
    /** Milliseconds since the last poll that got an answer — 0 while the server is answering. */
    readonly unreachableMs: number;
    /** Milliseconds since the run entered `restart`. */
    readonly elapsedMs: number;
  },
): RestartWaitDecision {
  if (response !== null && response.ok) {
    if (target !== "" && response.version === target) {
      return { kind: "success", version: response.version };
    }
    // A DIFFERENT (older) version answered: either the old server is still shutting down, or the
    // relaunch came back on the old version. Its journal is the discriminator — a `failed` apply
    // is the truth the user needs, not more waiting.
    const lastApply = response.lastApply ?? null;
    if (lastApply !== null && lastApply.outcome === "failed" && response.version !== target) {
      return { kind: "failed", reasonCode: lastApply.reasonCode ?? "" };
    }
  }
  if (time.unreachableMs >= UPDATE_INAPP_WAIT_MS) return { kind: "escalate" };
  if (time.elapsedMs >= UPDATE_RESTART_CEILING_MS) return { kind: "escalate" };
  return { kind: "wait" };
}

/** Fetch /healthz once, returning a well-formed response or null (never throws). */
export async function fetchHealthz(): Promise<HealthzResponse | null> {
  try {
    const response = await fetch("/healthz", { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      body !== null &&
      typeof body === "object" &&
      typeof (body as HealthzResponse).ok === "boolean" &&
      typeof (body as HealthzResponse).version === "string"
    ) {
      return body as HealthzResponse;
    }
    return null;
  } catch {
    return null;
  }
}
