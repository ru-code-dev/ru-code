// ru-code: the readiness gate's host half. This hook is the single input that decides
// whether the analytics panel issues RPCs at all — if it ever answers `false` forever,
// the panel sits at «loading» and issues NOTHING: a silent hang no other gate can see.
// So the mapping is pinned against the REAL `connectionProjectionPhase` (the supervisor's
// own projection), phase by phase: exactly `connected` may answer true.
//
// `useEnvironmentQuery` and the catalog atom are mocked — they are the hook's only React
// coupling, and mocking them makes the mapping a plain function of the connection state.
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  data: null as SupervisorConnectionState | null,
  receivedAtom: undefined as unknown,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    testState.receivedAtom = atom;
    return { data: testState.data, error: null, isPending: false, refresh: () => {} };
  },
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    stateAtom: (environmentId: unknown) => ({ marker: "stateAtom", environmentId }),
  },
}));

import { useAnalyticsConnectionPhase } from "../../analytics/analyticsActions";

const ENV_ID = "env-1" as EnvironmentId;

const stateWithPhase = (phase: SupervisorConnectionState["phase"]): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  phase,
});

beforeEach(() => {
  testState.data = null;
  testState.receivedAtom = undefined;
});

describe("useAnalyticsConnectionPhase", () => {
  it("no primary environment → disconnected, and the query gets a NULL atom (stable hook order)", () => {
    expect(useAnalyticsConnectionPhase(null)).toBe("disconnected");
    expect(testState.receivedAtom).toBeNull();
  });

  it("no connection state yet (data null) → disconnected", () => {
    expect(useAnalyticsConnectionPhase(ENV_ID)).toBe("disconnected");
    // And it asked for THIS environment's catalog atom, not something else.
    expect(testState.receivedAtom).toMatchObject({ marker: "stateAtom", environmentId: ENV_ID });
  });

  // THREE states, not a boolean. `connecting` is a transient the panel should wait
  // through; the rest are conditions it should report. Collapsing both to `false` made
  // them indistinguishable downstream, so a disconnected user saw the same endless
  // spinner as someone two seconds from connected — with the ⟳ disabled and no message.
  it("maps every supervisor phase onto the projection the panel renders", () => {
    const expectations: ReadonlyArray<
      [SupervisorConnectionState["phase"], "disconnected" | "synchronizing" | "ready"]
    > = [
      ["connected", "ready"],
      ["connecting", "synchronizing"],
      ["available", "disconnected"],
      ["offline", "disconnected"],
      ["backoff", "disconnected"],
      ["blocked", "disconnected"],
    ];
    for (const [phase, expected] of expectations) {
      testState.data = stateWithPhase(phase);
      expect(useAnalyticsConnectionPhase(ENV_ID), `phase=${phase}`).toBe(expected);
    }
  });

  it("only `connected` permits an RPC — every other phase must not", () => {
    for (const phase of ["connecting", "available", "offline", "backoff", "blocked"] as const) {
      testState.data = stateWithPhase(phase);
      expect(useAnalyticsConnectionPhase(ENV_ID), `phase=${phase}`).not.toBe("ready");
    }
  });
});
