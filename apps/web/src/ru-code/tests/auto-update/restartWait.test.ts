// ru-code: the in-app restart wait — the pure /healthz decision the tab runs while its server is
// being replaced (notify/restartWait.ts). Four verbs, one table.
//
// The design this encodes: a restart is 3–10 s, so the tab STAYS on the card the user pressed and
// polls; it hands the screen to the SW-served page only when the budget is blown, because past
// that point the server is not "restarting", it is DOWN — and the SW page is the surface built for
// a dead server. The app deliberately grows no manual screen of its own.
import { describe, expect, it } from "vite-plus/test";

import { UPDATE_INAPP_WAIT_MS, UPDATE_RESTART_CEILING_MS } from "@ru-code/branding";

import {
  restartWaitDecision,
  type HealthzResponse,
  type RestartWaitDecision,
} from "../../auto-update-ui/notify/restartWait";

const TARGET = "1.4.2";
const OLD = "1.4.1";

const healthz = (over: Partial<HealthzResponse> = {}): HealthzResponse => ({
  ok: true,
  version: OLD,
  pid: 4242,
  lastApply: null,
  ...over,
});

const failedApply = {
  targetVersion: TARGET,
  fromVersion: OLD,
  outcome: "failed" as const,
  reasonCode: "port-busy",
  at: 1_800_000_000_000,
};

/** The two clocks the decision reads: how long unreachable, and how long since the restart began. */
const at = (unreachableMs: number, elapsedMs = unreachableMs) => ({ unreachableMs, elapsedMs });

describe("restartWaitDecision", () => {
  const cases: ReadonlyArray<
    [
      string,
      HealthzResponse | null,
      { readonly unreachableMs: number; readonly elapsedMs: number },
      RestartWaitDecision["kind"],
    ]
  > = [
    ["server unreachable, inside the budget", null, at(0), "wait"],
    ["server unreachable, near the budget", null, at(UPDATE_INAPP_WAIT_MS - 1), "wait"],
    ["server unreachable, budget blown", null, at(UPDATE_INAPP_WAIT_MS), "escalate"],
    // THE change: a server that ANSWERS is alive, however long the swap is taking. Escalating a
    // slow-but-healthy restart to a full-screen page is the experience this removes.
    ["old server answering, restart taking a while", healthz(), at(0, 30_000), "wait"],
    [
      "old server answering forever — the ceiling still ends it",
      healthz(),
      at(0, UPDATE_RESTART_CEILING_MS),
      "escalate",
    ],
    ["NEW version answers", healthz({ version: TARGET }), at(0), "success"],
    [
      "new version answers late — success still wins over escalate",
      healthz({ version: TARGET }),
      at(99_999),
      "success",
    ],
    ["old version + journalled failure", healthz({ lastApply: failedApply }), at(0), "failed"],
    [
      "not-ok response is no answer at all — it counts as unreachable",
      healthz({ ok: false, version: TARGET }),
      at(UPDATE_INAPP_WAIT_MS),
      "escalate",
    ],
  ];

  it.each(cases)("%s → %s", (_label, response, time, expected) => {
    expect(restartWaitDecision(response, TARGET, time).kind).toBe(expected);
  });

  // A server that comes back mid-wait resets the countdown — the tab is not punished for a blip.
  it("a blip does not spend the budget", () => {
    expect(restartWaitDecision(null, TARGET, at(UPDATE_INAPP_WAIT_MS - 1)).kind).toBe("wait");
    // …the server answers, so `unreachableMs` returns to 0 even though more time has passed…
    expect(restartWaitDecision(healthz(), TARGET, at(0, UPDATE_INAPP_WAIT_MS * 2)).kind).toBe(
      "wait",
    );
    // …and only a fresh full window of silence escalates.
    expect(
      restartWaitDecision(null, TARGET, at(UPDATE_INAPP_WAIT_MS, UPDATE_INAPP_WAIT_MS * 3)).kind,
    ).toBe("escalate");
  });

  it("carries the version on success and the reason code on failure", () => {
    const success = restartWaitDecision(healthz({ version: TARGET }), TARGET, at(0));
    expect(success).toEqual({ kind: "success", version: TARGET });

    const failed = restartWaitDecision(healthz({ lastApply: failedApply }), TARGET, at(0));
    expect(failed).toEqual({ kind: "failed", reasonCode: "port-busy" });
  });

  // The journal is only meaningful about a version that is NOT the one we are waiting for. If the
  // target itself answers, the update worked — whatever an older journal entry says.
  it("a successful target answer beats a stale failed journal", () => {
    const decision = restartWaitDecision(
      healthz({ version: TARGET, lastApply: failedApply }),
      TARGET,
      at(0),
    );
    expect(decision.kind).toBe("success");
  });

  it("an empty target never reports success", () => {
    expect(restartWaitDecision(healthz({ version: "" }), "", at(0)).kind).toBe("wait");
  });

  it("a failed apply with no reason code still reports failed", () => {
    const decision = restartWaitDecision(
      healthz({ lastApply: { ...failedApply, reasonCode: null } }),
      TARGET,
      at(0),
    );
    expect(decision).toEqual({ kind: "failed", reasonCode: "" });
  });
});
