// ru-code: the restart-handover matrix, table-tested against the ONE pure decision
// (notify/handoverDecision.ts). Every row here is a situation from the handover matrix in
// WORKFLOW/HANDOFF-PRESS-FAILURE-ROUND.md §3; the row numbers are kept so the table and the doc
// stay readable side by side.
//
// The bug this exists to prevent: `state === null` was read as "the server died", but it is also
// every fresh page load before the first snapshot arrives — so a boot with a still-fresh marker
// reloaded, booted, reloaded… (the app ↔ SW-page blink after a restart). The rule is a real DROP
// (`hadSnapshot && !connected`), plus a latch that survives the reload it authorises.
import { describe, expect, it } from "vite-plus/test";

import {
  decideHandover,
  MARKER_FUTURE_TOLERANCE_MS,
  type HandoverDecision,
  type HandoverInput,
} from "../../auto-update-ui/notify/handoverDecision";
import { UPDATE_MARKER_STALE_MS } from "../../auto-update-ui/sw-kit/runtime";

const NOW = 1_800_000_000_000;

const fresh = { startedAt: NOW - 10_000 };
const stale = { startedAt: NOW - UPDATE_MARKER_STALE_MS - 1 };

function input(over: Partial<HandoverInput>): HandoverInput {
  return {
    hadSnapshot: false,
    connected: false,
    runActive: false,
    marker: null,
    now: NOW,
    handedOverFor: null,
    // The default is "the poll is NOT armed", which keeps every pre-existing row meaning exactly
    // what it meant: those rows describe tabs with no restart-phase run of their own.
    restartWaitArmed: false,
    ...over,
  };
}

describe("decideHandover — the handover matrix", () => {
  const cases: ReadonlyArray<[string, HandoverInput, HandoverDecision]> = [
    // 1. tab open, healthy, no update
    ["1 · connected, no marker", input({ hadSnapshot: true, connected: true }), "wait"],
    // 2. press → run reaches `restart` → the server dies
    [
      "2 · dropped with a fresh marker after a snapshot",
      input({ hadSnapshot: true, marker: fresh }),
      "reload",
    ],
    // 3. a second tab during the same update behaves identically (same inputs → same verb)
    ["3 · second tab, same drop", input({ hadSnapshot: true, marker: fresh }), "reload"],
    // 4. the update failed BEFORE the restart: the server is alive, so the marker the PRESS wrote
    //    is stale evidence and must go — otherwise the next F5 shows a false «обновляется…».
    [
      "4 · connected, run over (failed), marker left by the press",
      input({ hadSnapshot: true, connected: true, marker: fresh }),
      "clear",
    ],
    // 5. the server stopped for another reason — an ordinary disconnect, the app's own UI owns it
    ["5 · dropped, no marker", input({ hadSnapshot: true, marker: null }), "wait"],
    // 6. F5 / new tab DURING the blind window never reaches this code (the navigation fails and the
    //    SW answers) — and if it does load from cache, a tab with no snapshot must not reload.
    ["6 · never connected, fresh marker", input({ hadSnapshot: false, marker: fresh }), "wait"],
    // 7. THE LOOP: booting with the server UP and a fresh marker. Never handed over; the marker is
    //    cleared the moment the first snapshot lands.
    [
      "7a · booting, not yet connected, fresh marker",
      input({ hadSnapshot: false, marker: fresh }),
      "wait",
    ],
    [
      "7b · first snapshot arrives, no run",
      input({ hadSnapshot: true, connected: true, marker: fresh }),
      "clear",
    ],
    // 8. a STALE marker is a corpse: no handover, and a live server clears it
    ["8a · dropped with a stale marker", input({ hadSnapshot: true, marker: stale }), "wait"],
    [
      "8b · connected with a stale marker",
      input({ hadSnapshot: true, connected: true, marker: stale }),
      "clear",
    ],
    // 9. the restart happened but the port was stolen: the OLD server answers, so this is just a
    //    connected tab with a marker to drop (the journal failure shows on the hero).
    [
      "9 · connected after a port-busy restart",
      input({ hadSnapshot: true, connected: true, marker: fresh }),
      "clear",
    ],
    // 10. a VPN/sleep drop with a fresh marker is indistinguishable from a restart — one reload
    //     settles it (server alive → app clears the marker; dead → the SW updating page).
    ["10 · VPN drop with a fresh marker", input({ hadSnapshot: true, marker: fresh }), "reload"],
    // 11. the latch: one marker moves a given tab at most once, ever
    [
      "11 · already handed over for THIS marker",
      input({ hadSnapshot: true, marker: fresh, handedOverFor: fresh.startedAt }),
      "wait",
    ],
    [
      "11b · a NEW marker still moves the same tab",
      input({ hadSnapshot: true, marker: fresh, handedOverFor: fresh.startedAt - 60_000 }),
      "reload",
    ],
    // 12. first visit ever, app not running: nothing to intercept, and nothing here to do
    ["12 · never connected, no marker", input({}), "wait"],
    // A live run owns the marker: clearing it mid-run would hand the blind window to the down page.
    [
      "run in flight, connected",
      input({ hadSnapshot: true, connected: true, runActive: true, marker: fresh }),
      "wait",
    ],
    // A marker from a clock far ahead of ours is not trusted (mirrors decideNavigateFallback).
    [
      "marker from the future",
      input({
        hadSnapshot: true,
        marker: { startedAt: NOW + MARKER_FUTURE_TOLERANCE_MS + 1 },
      }),
      "wait",
    ],
  ];

  it.each(cases)("%s → %s", (_label, given, expected) => {
    expect(decideHandover(given)).toBe(expected);
  });

  // ── the in-app window must actually get its 5 seconds ──────────────────────────────────────
  //
  // Both mechanisms fire on the same event (the connection dropping under a fresh marker) and this
  // one used to win every time, because it needs no round trip. The result was that
  // UPDATE_INAPP_WAIT_MS never elapsed: a 3-second restart was escalated to the full-screen SW page
  // as though the server had died, and the user lost their place. While the poll is armed it is
  // strictly better informed — it asks /healthz, returns the tab IN PLACE on success, and escalates
  // itself when the budget is spent.
  describe("while the in-app restart poll is armed", () => {
    it("stands down instead of reloading, however fresh the marker", () => {
      for (const age of [0, 1_000, 4_999, 60_000, UPDATE_MARKER_STALE_MS - 1]) {
        expect(
          decideHandover(
            input({ hadSnapshot: true, marker: { startedAt: NOW - age }, restartWaitArmed: true }),
          ),
        ).toBe("wait");
      }
    });

    // Standing down is not going blind: the marker still gets cleared as soon as the run is over.
    // An armed poll always implies a LIVE run (`phase === "restart"`), so the two travel together.
    it("still clears the marker once the run is over and the server is back", () => {
      expect(
        decideHandover(
          input({
            hadSnapshot: true,
            connected: true,
            runActive: true,
            marker: fresh,
            restartWaitArmed: true,
          }),
        ),
      ).toBe("wait"); // the restart is still in flight — the marker is load-bearing
      expect(decideHandover(input({ hadSnapshot: true, connected: true, marker: fresh }))).toBe(
        "clear",
      );
    });

    it("hands over as before the moment the poll is NOT armed (another tab's update, no run here)", () => {
      expect(decideHandover(input({ hadSnapshot: true, marker: fresh }))).toBe("reload");
    });
  });

  it("a marker exactly at the stale boundary still hands over", () => {
    expect(
      decideHandover(
        input({ hadSnapshot: true, marker: { startedAt: NOW - UPDATE_MARKER_STALE_MS } }),
      ),
    ).toBe("reload");
  });

  // The regression itself, stated as a loop: boot → (no snapshot yet) → boot again. If either
  // pass returned "reload" the tab would blink until the marker went stale, five minutes later.
  it("never reloads a tab that has not seen a snapshot, however fresh the marker", () => {
    for (const age of [0, 1_000, 60_000, UPDATE_MARKER_STALE_MS - 1]) {
      expect(decideHandover(input({ marker: { startedAt: NOW - age } }))).toBe("wait");
    }
  });
});
