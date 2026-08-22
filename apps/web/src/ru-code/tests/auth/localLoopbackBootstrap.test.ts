// ru-code: loopback auto-auth client flow. Contract: the helper authenticates
// ONLY when the target is loopback AND the endpoint grants a credential AND the
// exchange + session wait both succeed; every other outcome returns false
// without side effects beyond the attempted steps — the caller then falls
// through to the /pair flow unchanged.
import { describe, expect, it } from "vite-plus/test";

import {
  tryLocalLoopbackBootstrapWith,
  type LocalLoopbackBootstrapIo,
} from "../../auth/localLoopbackBootstrap";

interface Recorded {
  readonly fetched: Array<string>;
  readonly exchanged: Array<string>;
  waited: number;
}

const makeIo = (
  overrides: Partial<LocalLoopbackBootstrapIo>,
): [LocalLoopbackBootstrapIo, Recorded] => {
  const recorded: Recorded = { fetched: [], exchanged: [], waited: 0 };
  const io: LocalLoopbackBootstrapIo = {
    resolveEndpointUrl: () => "http://127.0.0.1:3773/api/auth/local-bootstrap",
    fetchImpl: (input) => {
      recorded.fetched.push(input);
      return Promise.resolve(
        new Response(JSON.stringify({ credential: "TESTCRED1" }), { status: 200 }),
      );
    },
    exchangeBootstrapCredential: (credential) => {
      recorded.exchanged.push(credential);
      return Promise.resolve(undefined);
    },
    waitForAuthenticatedSession: () => {
      recorded.waited += 1;
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
  return [io, recorded];
};

describe("tryLocalLoopbackBootstrapWith", () => {
  it("exchanges a granted credential and reports authenticated", async () => {
    const [io, recorded] = makeIo({});
    await expect(tryLocalLoopbackBootstrapWith(io)).resolves.toBe(true);
    expect(recorded.fetched).toEqual(["http://127.0.0.1:3773/api/auth/local-bootstrap"]);
    expect(recorded.exchanged).toEqual(["TESTCRED1"]);
    expect(recorded.waited).toBe(1);
  });

  it("never probes a non-loopback target", async () => {
    const [io, recorded] = makeIo({
      resolveEndpointUrl: () => "https://build.example.com/api/auth/local-bootstrap",
    });
    await expect(tryLocalLoopbackBootstrapWith(io)).resolves.toBe(false);
    expect(recorded.fetched).toEqual([]);
    expect(recorded.exchanged).toEqual([]);
  });

  it("a 404 (endpoint dark: remote bind / desktop / flag off) falls through", async () => {
    const [io, recorded] = makeIo({
      fetchImpl: (input) => {
        recorded.fetched.push(input);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    await expect(tryLocalLoopbackBootstrapWith(io)).resolves.toBe(false);
    expect(recorded.exchanged).toEqual([]);
    expect(recorded.waited).toBe(0);
  });

  it("a malformed or empty payload never reaches the exchange", async () => {
    for (const body of ["{}", JSON.stringify({ credential: "" }), "not json", "[1]"]) {
      const [io, recorded] = makeIo({
        fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
      });
      await expect(tryLocalLoopbackBootstrapWith(io)).resolves.toBe(false);
      expect(recorded.exchanged).toEqual([]);
    }
  });

  it("a failed exchange or network error reports unauthenticated", async () => {
    const [rejectingExchange] = makeIo({
      exchangeBootstrapCredential: () => Promise.reject(new Error("invalid_credential")),
    });
    await expect(tryLocalLoopbackBootstrapWith(rejectingExchange)).resolves.toBe(false);

    const [failingFetch, recordedFetch] = makeIo({
      fetchImpl: () => Promise.reject(new TypeError("network down")),
    });
    await expect(tryLocalLoopbackBootstrapWith(failingFetch)).resolves.toBe(false);
    expect(recordedFetch.exchanged).toEqual([]);
  });

  it("a session that never establishes after the exchange reports unauthenticated", async () => {
    const [io, recorded] = makeIo({
      waitForAuthenticatedSession: () => Promise.reject(new Error("timeout")),
    });
    await expect(tryLocalLoopbackBootstrapWith(io)).resolves.toBe(false);
    expect(recorded.exchanged).toEqual(["TESTCRED1"]);
  });
});
