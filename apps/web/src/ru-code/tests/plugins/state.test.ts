// ru-code S69 (V2-58): the WEB half of the state seam, `ctx.state(name)`, on BOTH transports.
//
// Every case runs twice — once with the server's value PUSHED (`plugin.state`), once with the NAME
// pushed and the value READ (`plugin.notifications` + `plugin.state.read`) — against one fake server
// that holds the last published value per name. What a plugin can observe must be identical: that
// is the claim the transport switch (`caps.ts` `PLUGIN_STATE_TRANSPORT`) rests on.
//
// The subscriptions themselves (atoms over the wire) are not drivable in this node project; what is
// driven is the delivery each one calls — `deliverPluginStateFrame` and `deliverPluginNotification`
// — and the read the notify transport makes. The wire is `apps/server/.../rpcHandlers.test.ts`'s.
import type { Json, Signal } from "@smart-tools/plugin-sdk/host";
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { MAX_STATE_NAMES_PER_PLUGIN } from "@smart-tools/plugin-sdk/state";
import {
  deliverPluginNotification,
  resetPluginNotifications,
  setPluginNotificationsMountForTests,
} from "../../plugins/notifications";
import { resetPluginProblems } from "../../plugins/problems";
import { addLoadedPlugin, resetLoadedPlugins } from "../../plugins/registry";
import {
  deliverPluginStateFrame,
  makePluginState,
  pluginStateListenerCount,
  resetPluginState,
  setPluginStateConnectionForTests,
  setPluginStateReadForTests,
  setPluginStateStreamMountForTests,
  setPluginStateTransportForTests,
} from "../../plugins/state";
import { getPluginProblems } from "../../plugins/status";

type Transport = "stream" | "notify";
type Phase = "connecting" | "ready" | "lost";

/** Let the notify transport's reads (promises) and their continuations run. */
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** `ctx.connection`, drivable. */
const connection = (() => {
  let value: Phase = "ready";
  const listeners = new Set<() => void>();
  const signal: Signal<Phase> & { set(next: Phase): void } = {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
  return signal;
})();

/**
 * The server: the last value per `(plugin, name)` — the store `state.ts` on the server owns — and
 * the two ways it reaches this tab, one per transport.
 */
const makeServer = (transport: Transport) => {
  const values = new Map<string, { pluginId: string; name: string; value: Json }>();
  const reads: Array<string> = [];
  const key = (pluginId: string, name: string) => `${pluginId}:${name}`;
  setPluginStateReadForTests(async (pluginId, name) => {
    reads.push(key(pluginId, name));
    return values.get(key(pluginId, name))?.value;
  });
  return {
    reads,
    /** `ctx.publish` on the server. The server's own compare is not modelled: every call is sent. */
    publish: (pluginId: string, name: string, value: Json) => {
      values.set(key(pluginId, name), { pluginId, name, value });
      if (transport === "stream") {
        deliverPluginStateFrame({ _tag: "value", pluginId: PluginId.make(pluginId), name, value });
      } else {
        deliverPluginNotification({ pluginId: PluginId.make(pluginId), name });
      }
    },
    /** A change made while this tab's socket is down: stored, never delivered to it. */
    changeWhileDown: (pluginId: string, name: string, value: Json) => {
      values.set(key(pluginId, name), { pluginId, name, value });
    },
    /** The server restarted: it holds nothing. */
    restart: () => {
      values.clear();
    },
    /** The socket dropped and came back — whatever each transport does on a new session. */
    reconnect: () => {
      connection.set("lost");
      connection.set("ready");
      if (transport === "stream") {
        deliverPluginStateFrame({
          _tag: "snapshot",
          values: Array.from(values.values()).map((entry) => ({
            pluginId: PluginId.make(entry.pluginId),
            name: entry.name,
            value: entry.value,
          })),
        });
      }
    },
  };
};

const problemCodes = (): Array<string> => getPluginProblems().map((row) => row.code);

beforeEach(() => {
  resetPluginState();
  resetPluginNotifications();
  resetPluginProblems();
  resetLoadedPlugins();
  // The app loads a plugin before it builds its ctx; a name for a plugin this tab never loaded is
  // a different case (reported by `notifications.ts`), not this suite's.
  for (const [order, id] of ["alpha", "beta"].entries()) {
    addLoadedPlugin({ id, name: id, plugin: {}, ctx: {} as never, order } as never);
  }
  setPluginStateStreamMountForTests(() => () => {});
  setPluginNotificationsMountForTests(() => () => {});
  setPluginStateConnectionForTests(connection);
  connection.set("ready");
});

afterEach(() => {
  setPluginStateTransportForTests(null);
  setPluginStateReadForTests(null);
  setPluginStateStreamMountForTests(null);
  setPluginNotificationsMountForTests(null);
  setPluginStateConnectionForTests(null);
  resetPluginState();
});

describe.each(["stream", "notify"] as const)(
  "ctx.state over the %s transport (V2-58)",
  (transport) => {
    const setup = () => {
      setPluginStateTransportForTests(transport);
      return makeServer(transport);
    };

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
      for (let index = 0; index < MAX_STATE_NAMES_PER_PLUGIN; index += 1)
        state(`n${String(index)}`);
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
  },
);

describe("the notify transport's reads (V2-58)", () => {
  it("reads once at creation when connected, once per edge into `ready`, and not while down", async () => {
    setPluginStateTransportForTests("notify");
    const server = makeServer("notify");
    connection.set("connecting");
    makePluginState("alpha")("rows");
    await flush();
    expect(server.reads).toEqual([]);
    connection.set("ready");
    await flush();
    expect(server.reads).toEqual(["alpha:rows"]);
    connection.set("lost");
    connection.set("ready");
    await flush();
    expect(server.reads).toEqual(["alpha:rows", "alpha:rows"]);
  });

  it("a burst of names during one read costs ONE more read, and the last value lands", async () => {
    setPluginStateTransportForTests("notify");
    const values: Array<Json> = [];
    let release: () => void = () => {};
    let reads = 0;
    let current: Json = 0;
    setPluginStateReadForTests(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return current;
    });
    const rows = makePluginState("alpha")("rows");
    rows.subscribe(() => values.push(rows.get() as Json));
    await flush();
    current = 1;
    deliverPluginNotification({ pluginId: PluginId.make("alpha"), name: "rows" });
    for (current = 2; current <= 6; current += 1) {
      deliverPluginNotification({ pluginId: PluginId.make("alpha"), name: "rows" });
    }
    current = 6;
    release();
    await flush();
    await flush();
    // One at creation, the one the first name started, and ONE more for the five that joined it.
    expect(reads).toBe(3);
    expect(rows.get()).toBe(6);
    expect(values).toEqual([0, 6]);
  });
});

// S69: the STREAM transport's driver is `mount`, not `subscribe` — the S53 defect, for the second
// subscription the page can hold. The real driver against a registry of the test's own; its BODY is
// the only thing that reads `primaryEnvironmentIdAtom`, so that node is the evidence it ran.
describe("the stream transport's subscription (V2-58)", () => {
  it("the REAL driver EVALUATES the atom — `mount`, not `subscribe`", async () => {
    const { AtomRegistry } = await import("effect/unstable/reactivity");
    const { primaryEnvironmentIdAtom } = await import("~/state/primaryEnvironment");
    const { setPluginStateRegistryForTests } = await import("../../plugins/state");
    const registry = AtomRegistry.make();
    setPluginStateStreamMountForTests(null);
    setPluginStateRegistryForTests(registry);
    setPluginStateTransportForTests("stream");
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
