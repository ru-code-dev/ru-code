// ru-code S53 (V2-54): the WEB end of the `plugin.notifications` stream. Since S69 (V2-58) it is the
// state seam's NOTIFY TRANSPORT and nothing else — `ctx.onNotify` left the SDK contract.
//
// WHAT IT IS. The server host pushes `{ pluginId, name }` — "this plugin's state value `name`
// changed" — over `plugin.notifications`, a `stream: true` RPC on the websocket this tab already
// holds (`packages/contracts/src/ru-code/plugins/rpc.ts`, served in `apps/server/src/ws.ts`). This
// file is the tab's end of it: ONE subscription for the whole page, and every name handed to the
// state seam (`./state.ts` `deliverPluginStateName`), whose reader for that name reads the value.
//
// WHY IT STARTS LAZILY. The subscription is opened by the FIRST `ctx.state` call made while the
// transport is `notify` (`caps.ts` `PLUGIN_STATE_TRANSPORT`), not at boot: on the stream transport
// nothing here is ever opened, and with no name held there is nothing to deliver.
//
// NOTHING IS QUEUED AND NOTHING IS RETRIED. A name for a name no cell holds — a plugin this tab did
// not load, a name nobody asked for — changes nothing; the stream transport treats such a value the
// same way.

import type { PluginNotification } from "@t3tools/contracts";
import { PLUGIN_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { deliverPluginStateName } from "./state";

/**
 * Route one notification to the state seam. Exported because it IS the delivery — the
 * subscription's `transform` calls it, and a unit test drives it directly.
 */
export function deliverPluginNotification(notification: PluginNotification): void {
  deliverPluginStateName(notification.pluginId, notification.name);
}

// --------------------------------------------------------------------------
// The subscription
// --------------------------------------------------------------------------

/**
 * The app's OWN push path, taken verbatim: one `plugin.notifications` stream per tab, opened by
 * `subscribe` (`packages/client-runtime/src/rpc/client.ts`), which re-opens it on every new
 * session by itself — `SubscriptionRef.changes(supervisor.session)` + `switchMap`, no timer here.
 *
 * The DELIVERY happens in the `transform`, not off the atom's value: an atom holds the LAST event,
 * and two identical notifications in a row (the same plugin, the same name) are indistinguishable
 * to a value watcher — exactly the case this seam exists to carry. A `Stream.tap` runs once per
 * frame, which is the contract.
 */
const notificationsSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "ru-code:plugins:notifications",
    tag: PLUGIN_METHODS.pluginNotifications,
    transform: (stream) =>
      stream.pipe(
        Stream.tap((notification) =>
          Effect.sync(() => {
            deliverPluginNotification(notification);
          }),
        ),
      ),
  },
);

/**
 * The PRIMARY environment's stream, and it follows a switch.
 *
 * Same shape as `autoUpdateWireStateAtom`: read the primary environment, then read that
 * environment's subscription. Reading the inner atom is what MOUNTS it, and the derived atom
 * re-reads when the primary environment changes, so the old environment's stream is released and
 * the new one's is opened with no code of ours in between.
 */
const pluginNotificationsAtom = Atom.make((get): null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  get(notificationsSubscription({ environmentId, input: {} }));
  return null;
}).pipe(Atom.withLabel("ru-code:plugins:notifications:driver"));

/** What keeps the atom — and therefore the stream — alive. Released by `stop` below. */
let unsubscribeDriver: (() => void) | null = null;

/**
 * Which registry the REAL driver mounts into. The app's singleton, always, except that a unit test
 * may hand in a registry of its own — which is the only way to run the real driver (below) rather
 * than a stand-in for it, and therefore the only way to pin `mount` against `subscribe` off the
 * wire. Narrowed to the one member the driver uses.
 */
let driverRegistry: Pick<AtomRegistry.AtomRegistry, "mount"> | null = null;

/** Test seam. Pass `null` to restore the app's registry. */
export function setPluginNotificationsRegistryForTests(
  next: Pick<AtomRegistry.AtomRegistry, "mount"> | null,
): void {
  driverRegistry = next;
}

/**
 * THE REAL DRIVER — one expression, named, so a test can run THIS and not a copy of it.
 *
 * `mount` and NOT `subscribe(atom, noop)`: see `startPluginNotifications` for the measurement.
 */
const mountDriverDefault = (): (() => void) =>
  (driverRegistry ?? appAtomRegistry).mount(pluginNotificationsAtom);

/**
 * How the driver atom is held. A seam, so the unit tier can prove "mounted lazily, exactly once"
 * without an environment to subscribe to (`notifications.test.ts`).
 */
let mountDriver: () => () => void = mountDriverDefault;

/** Test seam. Pass `null` to restore the real mount. */
export function setPluginNotificationsMountForTests(next: (() => () => void) | null): void {
  mountDriver = next ?? mountDriverDefault;
}

/**
 * Open the tab's notification stream. IDEMPOTENT — every notify-transport `ctx.state` calls it.
 *
 * `registry.mount` and NOT `registry.subscribe(atom, noop)`, and the difference is the whole
 * mechanism: `subscribe` without `immediate` registers a listener and never calls `node.value()`
 * (`effect/unstable/reactivity/AtomRegistry.js` · `subscribe`), so a DERIVED atom is never
 * COMPUTED — its `get(subscription)` never runs, the stream is never opened, and nothing arrives.
 * Measured: with `subscribe`, not one `plugin.notifications` frame left the tab in a real browser
 * (`WORKFLOW/logs/S53/9-probe-no-subscribe-frame.log`). `mount` IS
 * `subscribe(atom, constVoid, { immediate: true })` — the API made for holding an atom whose value
 * nobody reads, which is exactly this one: the delivery is the `transform`'s, not the value's.
 */
export function startPluginNotifications(): void {
  if (unsubscribeDriver !== null) return;
  unsubscribeDriver = mountDriver();
}

/** Close it. The tests' teardown, and the one seam an embedder could use to shut the page down. */
export function stopPluginNotifications(): void {
  unsubscribeDriver?.();
  unsubscribeDriver = null;
}

/** Test seam — the driver is a module-level singleton, like every other one in the host. */
export function resetPluginNotifications(): void {
  stopPluginNotifications();
}
