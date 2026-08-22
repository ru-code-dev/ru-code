// ru-code: the pure tick scheduler for the stateless check machine (CASE 2).
//
// Ticks fire hourly on the top of each working hour plus a per-install jitter
// minute — HH:jitter for HH in 08..17 LOCAL time. The jitter (0..59, generated
// once and persisted by configStore) smears thousands of clients across the
// hour so the release host never sees a thundering herd. This module owns only
// the WHEN: given a wall-clock instant and the install's jitter minute it names
// the next tick; the engine wires it to the real clock. No Effect, no Date.now —
// every function is a pure transform of its `nowMs` argument (local-time getters
// on `new Date(nowMs)` are permitted precisely because the input is explicit).
// @effect-diagnostics globalDate:off

// ru-code: the working-hour window and the jitter range are branding tunables —
// see ru-code/branding/src/auto-update.ts.
import { UPDATE_JITTER_MINUTES, UPDATE_WORK_HOURS } from "@ru-code/branding";

/** Clamp any supplied jitter to a whole minute in range (defensive; generation lives in configStore). */
function clampJitterMinute(jitterMinute: number): number {
  if (!Number.isFinite(jitterMinute)) return 0;
  return Math.min(UPDATE_JITTER_MINUTES - 1, Math.max(0, Math.floor(jitterMinute)));
}

/**
 * The next tick instant (epoch ms) strictly after `nowMs`: the earliest HH:jitter
 * (HH in 08..17) later today, or tomorrow 08:jitter when the working window is
 * already spent. Local-time construction keeps it DST-correct — the epoch is
 * derived from wall-clock components, so a spring-forward/fall-back day shifts
 * the absolute instant exactly as the wall clock does.
 */
export function nextTickAt(nowMs: number, jitterMinute: number): number {
  const now = new Date(nowMs);
  const minute = clampJitterMinute(jitterMinute);
  for (let hour = UPDATE_WORK_HOURS.first; hour <= UPDATE_WORK_HOURS.last; hour += 1) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0,
    ).getTime();
    if (candidate > nowMs) return candidate;
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    UPDATE_WORK_HOURS.first,
    minute,
    0,
    0,
  ).getTime();
}
