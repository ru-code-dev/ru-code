// ru-code: catalog prime readiness gate. Contract: the composer's catalog
// snapshot RPC may fire ONLY when the primary environment is resolved AND its
// supervisor reports "connected" — every other phase (and an unresolved id)
// keeps the prime parked; already-primed catalogs (items present) never
// re-fetch; the `enabled` provider switch always wins.
import { describe, expect, it } from "vite-plus/test";

import {
  isCatalogPrimeReady,
  shouldPrimeCatalog,
} from "../../../skills-agents/catalog/primeReadiness";

describe("isCatalogPrimeReady", () => {
  it("ready exactly when the id is resolved and the phase is connected", () => {
    expect(isCatalogPrimeReady({ environmentIdResolved: true, connectionPhase: "connected" })).toBe(
      true,
    );
  });

  it("an unresolved primary environment is never ready (boot: catalog not loaded)", () => {
    expect(
      isCatalogPrimeReady({ environmentIdResolved: false, connectionPhase: "connected" }),
    ).toBe(false);
    expect(isCatalogPrimeReady({ environmentIdResolved: false, connectionPhase: null })).toBe(
      false,
    );
  });

  it("every non-connected supervisor phase keeps the prime parked", () => {
    for (const connectionPhase of [
      "available",
      "connecting",
      "offline",
      "backoff",
      "blocked",
      null,
    ] as const) {
      expect(isCatalogPrimeReady({ environmentIdResolved: true, connectionPhase })).toBe(false);
    }
  });
});

describe("shouldPrimeCatalog", () => {
  it("primes only when enabled, ready, and not yet primed", () => {
    expect(shouldPrimeCatalog({ enabled: true, rpcReady: true, itemCount: 0 })).toBe(true);
  });

  it("a primed catalog (items present) never re-fetches", () => {
    expect(shouldPrimeCatalog({ enabled: true, rpcReady: true, itemCount: 3 })).toBe(false);
  });

  it("not ready or not enabled ⇒ parked", () => {
    expect(shouldPrimeCatalog({ enabled: true, rpcReady: false, itemCount: 0 })).toBe(false);
    expect(shouldPrimeCatalog({ enabled: false, rpcReady: true, itemCount: 0 })).toBe(false);
  });
});
