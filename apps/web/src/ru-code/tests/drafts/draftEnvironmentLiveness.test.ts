// ru-code: dead-environment draft retirement — the strict liveness rule.
// Contract: retire ONLY what is provably dead — catalog finished loading AND
// the draft's environmentId is absent from the registration entries. A loading
// catalog or an offline-but-registered environment must NEVER retire a draft.
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";

import { shouldRetireDraftForDeadEnvironment } from "../../drafts/draftEnvironmentLiveness";

const LIVE = "d4691646-660f-4df8-9c7b-194032303600" as EnvironmentId;
const DEAD = "0297f5b1-896b-4fac-a24f-573f199d6593" as EnvironmentId;

describe("shouldRetireDraftForDeadEnvironment", () => {
  it("retires a draft whose environment is absent from a LOADED catalog", () => {
    expect(
      shouldRetireDraftForDeadEnvironment({
        catalogReady: true,
        draftEnvironmentId: DEAD,
        liveEnvironmentIds: new Set([LIVE]),
      }),
    ).toBe(true);
  });

  it("keeps a draft whose environment is registered (connected OR offline)", () => {
    expect(
      shouldRetireDraftForDeadEnvironment({
        catalogReady: true,
        draftEnvironmentId: LIVE,
        liveEnvironmentIds: new Set([LIVE]),
      }),
    ).toBe(false);
  });

  it("NEVER retires while the catalog is still loading — even on an empty map", () => {
    expect(
      shouldRetireDraftForDeadEnvironment({
        catalogReady: false,
        draftEnvironmentId: DEAD,
        liveEnvironmentIds: new Set(),
      }),
    ).toBe(false);
  });

  it("a loaded but EMPTY catalog retires any draft (no environments exist at all)", () => {
    expect(
      shouldRetireDraftForDeadEnvironment({
        catalogReady: true,
        draftEnvironmentId: DEAD,
        liveEnvironmentIds: new Set(),
      }),
    ).toBe(true);
  });

  it("no draft, no retirement", () => {
    expect(
      shouldRetireDraftForDeadEnvironment({
        catalogReady: true,
        draftEnvironmentId: null,
        liveEnvironmentIds: new Set([LIVE]),
      }),
    ).toBe(false);
  });
});
