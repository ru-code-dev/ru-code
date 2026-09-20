// ru-code v2 (S28 V2-35, S33 A9): `ctx.connection` is one atom derived from the app's own state —
// `get()` and `subscribe()` read the same thing, so they cannot disagree, and a subscriber sees
// every flip at the moment the registry recomputes.
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makePluginConnectionAtom, makePluginConnectionSignal } from "../../plugins/connectionAtom";

const ENV = "env-1" as EnvironmentId;

const state = (phase: SupervisorConnectionState["phase"]): SupervisorConnectionState =>
  ({ phase }) as SupervisorConnectionState;

const harness = () => {
  const registry = AtomRegistry.make();
  const primary = Atom.make<EnvironmentId | null>(null);
  const envState = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>(
    AsyncResult.initial(),
  );
  const connection = makePluginConnectionAtom({
    primaryEnvironmentId: primary,
    environmentState: () => envState,
  });
  const signal = makePluginConnectionSignal(() => registry, connection);
  return { registry, primary, envState, connection, signal };
};

describe("pluginConnectionAtom", () => {
  it("reads `connecting` before an environment is chosen, then the chosen one's phase", () => {
    const { registry, primary, envState, connection } = harness();
    expect(registry.get(connection)).toBe("connecting");
    registry.set(primary, ENV);
    expect(registry.get(connection), "chosen, but no projection yet").toBe("connecting");
    registry.set(envState, AsyncResult.success(state("connected")));
    expect(registry.get(connection)).toBe("ready");
    registry.set(primary, null);
    expect(registry.get(connection), "the environment went away").toBe("connecting");
  });

  it("a subscriber sees `lost` → `ready` as the state atom moves, and `get()` agrees at each step", () => {
    const { registry, primary, envState, signal } = harness();
    registry.set(primary, ENV);
    registry.set(envState, AsyncResult.success(state("connected")));
    const seen: string[] = [];
    // Subscribed BEFORE any `get()` — the shape a plugin's `activate` writes — and still told.
    const unsubscribe = signal.subscribe(() => {
      seen.push(signal.get());
    });
    registry.set(envState, AsyncResult.success(state("backoff")));
    registry.set(envState, AsyncResult.success(state("connecting")));
    registry.set(envState, AsyncResult.success(state("connected")));
    expect(seen).toEqual(["lost", "connecting", "ready"]);
    unsubscribe();
    registry.set(envState, AsyncResult.success(state("backoff")));
    expect(seen, "nothing after unsubscribe").toHaveLength(3);
    expect(signal.get()).toBe("lost");
  });

  // ru-code S59 F1 / S60: `Signal.subscribe` promises "the listener takes no arguments — read
  // `get()`" (`plugin-sdk/src/host/index.ts`). The registry does NOT: `AtomRegistry.subscribe` is
  // `f: (_: A) => void` and calls a subscriber WITH the atom's value, so forwarding the plugin's
  // listener straight to it broke that promise. What leaked here is a `PluginConnection` string
  // rather than a store — the composer's copy of the same defect handed a plugin the app's whole
  // draft store with its mutators (`composerAttach.ts`, S57 F1) — but the sentence is true of every
  // Signal or of none, so the adapter is the same and so is this case.
  //
  // WHY IT HAS TO CAPTURE `...args` AND NOT JUST READ THE FIRST ONE: the case above subscribes with
  // a ZERO-ARITY arrow, and JavaScript drops extra arguments silently, so it stays green with the
  // adapter reverted. S60 caught exactly that — a flip that produced no red. The assertion is on
  // the ARGUMENT LIST, which is the only thing that moves.
  it("calls the subscriber with NO ARGUMENTS — nothing of the host's crosses the seam", () => {
    const { registry, primary, envState, signal } = harness();
    registry.set(primary, ENV);
    registry.set(envState, AsyncResult.success(state("connected")));
    const rounds: Array<ReadonlyArray<unknown>> = [];
    const unsubscribe = signal.subscribe((...args: ReadonlyArray<unknown>) => {
      rounds.push(args);
    });

    registry.set(envState, AsyncResult.success(state("backoff")));
    registry.set(envState, AsyncResult.success(state("connected")));
    unsubscribe();

    expect(rounds.length, "the listener did run").toBeGreaterThan(0);
    expect(rounds.map((args) => args.length)).toEqual(rounds.map(() => 0));
  });
});
