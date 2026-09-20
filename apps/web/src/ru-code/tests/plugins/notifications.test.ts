// ru-code S53 (V2-54) → S69 (V2-58): the WEB end of `plugin.notifications`, which is the state
// seam's NOTIFY TRANSPORT now and nothing else. `ctx.onNotify` left the SDK contract, and with it
// the listener registry this file used to pin (routing, the 32-listener cap, the four report
// codes): a name is routed to the state seam's reader for it, and the READER's rules are the SDK's
// (`plugin-sdk/tests/state.test.ts`) and the web state seam's (`state.test.ts`, both transports).
//
// WHAT THIS FILE STILL PROVES is the one thing only it can: the SUBSCRIPTION is opened lazily, once,
// and by `mount` — the S53 defect a real browser found — for the pages that use this transport.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { AtomRegistry } from "effect/unstable/reactivity";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import {
  resetPluginNotifications,
  setPluginNotificationsMountForTests,
  setPluginNotificationsRegistryForTests,
  stopPluginNotifications,
} from "../../plugins/notifications";
import { resetPluginProblems } from "../../plugins/problems";
import {
  makePluginState,
  resetPluginState,
  setPluginStateConnectionForTests,
  setPluginStateReadForTests,
  setPluginStateTransportForTests,
} from "../../plugins/state";

/** A connection that is NOT ready, so creating a cell starts no read — the mount is the subject. */
const down = {
  get: () => "connecting" as const,
  subscribe: () => () => {},
};

beforeEach(() => {
  resetPluginNotifications();
  resetPluginState();
  setPluginNotificationsMountForTests(null);
  resetPluginProblems();
  setPluginStateTransportForTests("notify");
  setPluginStateConnectionForTests(down);
  setPluginStateReadForTests(async () => undefined);
});

describe("the notify transport's subscription is HELD, and held once (V2-54, V2-58)", () => {
  /**
   * THE DEFECT THIS PINS, measured in a real browser before it was fixed
   * (`WORKFLOW/logs/S53/9-probe-no-subscribe-frame.log`): the driver used
   * `registry.subscribe(atom, noop)`, which registers a listener and never calls `node.value()`
   * — so a DERIVED atom is never COMPUTED, its `get(subscription)` never runs, and not one
   * `plugin.notifications` frame ever left the tab. `registry.mount` is the same call WITH
   * `immediate: true`, which is the whole difference between a transport that works and one that
   * is silently inert.
   *
   * The unit tier cannot see the wire, so what it pins is the CONTRACT around the mount: it
   * happens on the first `ctx.state` of the notify transport, exactly once, and `stop` releases it.
   */
  const spyMount = () => {
    const calls = { mounted: 0, released: 0 };
    setPluginNotificationsMountForTests(() => {
      calls.mounted += 1;
      return () => {
        calls.released += 1;
      };
    });
    return calls;
  };

  it("mounts on the FIRST state name and not before", () => {
    const calls = spyMount();
    expect(calls.mounted).toBe(0);
    makePluginState("alpha")("notes");
    expect(calls.mounted).toBe(1);
  });

  it("mounts ONCE however many names and plugins ask", () => {
    const calls = spyMount();
    makePluginState("alpha")("notes");
    makePluginState("alpha")("runs");
    makePluginState("beta")("notes");
    expect(calls.mounted).toBe(1);
  });

  it("releases the mount on stop, and mounts again on the next name", () => {
    const calls = spyMount();
    makePluginState("alpha")("notes");
    stopPluginNotifications();
    expect(calls.released).toBe(1);
    makePluginState("alpha")("runs");
    expect(calls.mounted).toBe(2);
  });

  it("a refused name does NOT open a stream nothing will read", () => {
    const calls = spyMount();
    makePluginState("alpha")("not a name");
    expect(calls.mounted).toBe(0);
  });

  it("the STREAM transport never opens it", () => {
    const calls = spyMount();
    setPluginStateTransportForTests("stream");
    makePluginState("alpha")("notes");
    expect(calls.mounted).toBe(0);
  });

  /**
   * THE REAL DRIVER, and the cases above cannot see it: each installs a stand-in through
   * `setPluginNotificationsMountForTests`, so all of them stay green with the production
   * expression reverted to `registry.subscribe(atom, noop)` — the exact defect the browser found.
   * This one runs the production expression itself, against a registry of the test's own, and
   * asserts the thing `subscribe` does not do: EVALUATE the atom — observed as the node of
   * `primaryEnvironmentIdAtom`, which only the atom's BODY reads.
   */
  it("the REAL driver EVALUATES the atom — `mount`, not `subscribe` (S53, V2-54)", () => {
    const registry = AtomRegistry.make();
    setPluginNotificationsRegistryForTests(registry);
    try {
      expect(registry.getNodes().has(primaryEnvironmentIdAtom)).toBe(false);
      makePluginState("alpha")("scanState");
      expect(registry.getNodes().has(primaryEnvironmentIdAtom)).toBe(true);
    } finally {
      stopPluginNotifications();
      setPluginNotificationsRegistryForTests(null);
      registry.dispose();
    }
  });
});
