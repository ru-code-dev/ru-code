// ru-code S69 (V2-58): the WEB half of the state seam, `ctx.state(name)`, over `plugin.state` (the
// one transport since V2-75), against one fake server that holds the last published value per name.
//
// The subscription itself (an atom over the wire) is not drivable in this node project; what is
// driven is the delivery it calls — `deliverPluginStateFrame`. The wire is
// `apps/server/.../rpcHandlers.test.ts`'s.
import type { Json } from "@smart-tools/plugin-sdk/host";
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { MAX_STATE_NAMES_PER_PLUGIN } from "@smart-tools/plugin-sdk/state";
import { resetPluginProblems } from "../../plugins/problems";
import { addLoadedPlugin, resetLoadedPlugins } from "../../plugins/registry";
import {
  deliverPluginStateFrame,
  makePluginState,
  pluginStateListenerCount,
  resetPluginState,
  setPluginStateStreamMountForTests,
  type PluginStateSource,
} from "../../plugins/state";
import { getPluginProblems } from "../../plugins/status";

/** Let every pending continuation run. */
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * The server: the last value per `(plugin, name)` — the store `state.ts` on the server owns — and its
 * position (S104): every change counted, each frame's floor the count so far. Its stream to this tab
 * is one source, and — like every run of the real stream — starts with a snapshot.
 */
const makeServer = () => {
  const values = new Map<string, { pluginId: string; name: string; value: Json }>();
  const key = (pluginId: string, name: string) => `${pluginId}:${name}`;
  const source: PluginStateSource = { boot: null };
  let seq = 0;
  let boot = "boot-1";
  const snapshot = (): void => {
    deliverPluginStateFrame(
      {
        _tag: "snapshot",
        values: Array.from(values.values()).map((entry) => ({
          pluginId: PluginId.make(entry.pluginId),
          name: entry.name,
          value: entry.value,
        })),
        boot,
        seq,
      },
      source,
    );
  };
  snapshot();
  return {
    /** `ctx.publish` on the server. The server's own compare is not modelled: every call is sent. */
    publish: (pluginId: string, name: string, value: Json) => {
      values.set(key(pluginId, name), { pluginId, name, value });
      seq += 1;
      deliverPluginStateFrame(
        { _tag: "value", pluginId: PluginId.make(pluginId), name, value, floor: seq },
        source,
      );
    },
    /** A change made while this tab's socket is down: stored, never delivered to it. */
    changeWhileDown: (pluginId: string, name: string, value: Json) => {
      values.set(key(pluginId, name), { pluginId, name, value });
      seq += 1;
    },
    /** The server restarted: it holds nothing, and it is a new process. */
    restart: () => {
      values.clear();
      seq = 0;
      boot = "boot-2";
    },
    /** The socket dropped and came back: the new session's stream starts with a snapshot. */
    reconnect: snapshot,
  };
};

const problemCodes = (): Array<string> => getPluginProblems().map((row) => row.code);

beforeEach(() => {
  resetPluginState();
  resetPluginProblems();
  resetLoadedPlugins();
  // The app loads a plugin before it builds its ctx.
  for (const [order, id] of ["alpha", "beta"].entries()) {
    addLoadedPlugin({ id, name: id, plugin: {}, ctx: {} as never, order } as never);
  }
  setPluginStateStreamMountForTests(() => () => {});
});

afterEach(() => {
  setPluginStateStreamMountForTests(null);
  resetPluginState();
});

describe("ctx.state over plugin.state (V2-58)", () => {
  const setup = makeServer;

  it("is `undefined` until the server publishes, then follows it — every listener told once per change", async () => {
    const server = setup();
    const scan = makePluginState("alpha")("scanState");
    await flush();
    expect(scan.get()).toBeUndefined();
    const seen: Array<unknown> = [];
    scan.subscribe(() => seen.push(scan.get()));
    server.publish("alpha", "scanState", { phase: "running" });
    await flush();
    server.publish("alpha", "scanState", { phase: "idle" });
    await flush();
    expect(seen).toEqual([{ phase: "running" }, { phase: "idle" }]);
  });

  it("an EQUAL value — the echo of this tab's own call — changes nothing and renders nothing", async () => {
    const server = setup();
    const scan = makePluginState("alpha")("scanState");
    server.publish("alpha", "scanState", { phase: "idle", n: [1] });
    await flush();
    const held = scan.get();
    let calls = 0;
    scan.subscribe(() => {
      calls += 1;
    });
    server.publish("alpha", "scanState", { n: [1], phase: "idle" });
    await flush();
    expect(calls).toBe(0);
    expect(scan.get()).toBe(held);
  });

  it("a name asked for AFTER the value was published starts from the current value", async () => {
    const server = setup();
    makePluginState("alpha")("warm");
    server.publish("alpha", "late", 7);
    await flush();
    const late = makePluginState("alpha")("late");
    await flush();
    expect(late.get()).toBe(7);
  });

  it("the same Signal for the same name, and a plugin sees only its OWN names", async () => {
    const server = setup();
    const alpha = makePluginState("alpha");
    const beta = makePluginState("beta");
    expect(alpha("rows")).toBe(alpha("rows"));
    const betaRows = beta("rows");
    server.publish("alpha", "rows", [1]);
    await flush();
    expect(alpha("rows").get()).toEqual([1]);
    expect(betaRows.get()).toBeUndefined();
  });

  it("a RECONNECT brings the current value once — equal renders nothing", async () => {
    const server = setup();
    const rows = makePluginState("alpha")("rows");
    server.publish("alpha", "rows", [1]);
    await flush();
    const held = rows.get();
    let calls = 0;
    rows.subscribe(() => {
      calls += 1;
    });
    server.reconnect();
    await flush();
    expect(calls).toBe(0);
    expect(rows.get()).toBe(held);
  });

  it("a change made while this tab was DISCONNECTED arrives with the reconnect, once", async () => {
    const server = setup();
    const rows = makePluginState("alpha")("rows");
    server.publish("alpha", "rows", [1]);
    await flush();
    const seen: Array<unknown> = [];
    rows.subscribe(() => seen.push(rows.get()));
    server.changeWhileDown("alpha", "rows", [1, 2]);
    server.reconnect();
    await flush();
    expect(seen).toEqual([[1, 2]]);
  });

  it("a server that holds NO value any more (restarted) turns the signal back to `undefined`", async () => {
    const server = setup();
    const rows = makePluginState("alpha")("rows");
    server.publish("alpha", "rows", [1]);
    await flush();
    server.restart();
    server.reconnect();
    await flush();
    expect(rows.get()).toBeUndefined();
  });

  it("refuses a bad name and a name past the cap with an inert signal, reported once each", async () => {
    const server = setup();
    const state = makePluginState("alpha");
    const bad = state("no spaces");
    for (let index = 0; index < MAX_STATE_NAMES_PER_PLUGIN; index += 1) state(`n${String(index)}`);
    const over = state("one-too-many");
    state("one-too-many");
    server.publish("alpha", "one-too-many", 1);
    await flush();
    expect(bad.get()).toBeUndefined();
    expect(over.get()).toBeUndefined();
    expect(problemCodes()).toEqual(["state-name-invalid", "cap:state-names"]);
  });

  it("a listener that THROWS is reported once and the other listeners still run", async () => {
    const server = setup();
    const rows = makePluginState("alpha")("rows");
    const ran: Array<string> = [];
    rows.subscribe(() => {
      throw new Error("boom");
    });
    rows.subscribe(() => ran.push("after"));
    server.publish("alpha", "rows", 1);
    await flush();
    server.publish("alpha", "rows", 2);
    await flush();
    expect(ran).toEqual(["after", "after"]);
    expect(problemCodes()).toEqual(["state-listener-threw"]);
  });

  it("an unsubscribe leaves nothing behind", async () => {
    setup();
    const rows = makePluginState("alpha")("rows");
    const stop = rows.subscribe(() => {});
    expect(pluginStateListenerCount("alpha", "rows")).toBe(1);
    stop();
    stop();
    expect(pluginStateListenerCount("alpha", "rows")).toBe(0);
  });
});

// S69: the stream's driver is `mount`, not `subscribe` — the S53 defect. The real driver against a registry of the test's own; its BODY is
// the only thing that reads `primaryEnvironmentIdAtom`, so that node is the evidence it ran.
describe("the plugin.state subscription (V2-58)", () => {
  it("the REAL driver EVALUATES the atom — `mount`, not `subscribe`", async () => {
    const { AtomRegistry } = await import("effect/unstable/reactivity");
    const { primaryEnvironmentIdAtom } = await import("~/state/primaryEnvironment");
    const { setPluginStateRegistryForTests } = await import("../../plugins/state");
    const registry = AtomRegistry.make();
    setPluginStateStreamMountForTests(null);
    setPluginStateRegistryForTests(registry);
    try {
      expect(registry.getNodes().has(primaryEnvironmentIdAtom)).toBe(false);
      makePluginState("alpha")("rows");
      expect(registry.getNodes().has(primaryEnvironmentIdAtom)).toBe(true);
    } finally {
      resetPluginState();
      setPluginStateRegistryForTests(null);
      registry.dispose();
    }
  });
});
