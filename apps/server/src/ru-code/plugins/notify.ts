/**
 * ru-code S53 (V2-54): the server→web NOTIFY hub. Since S69 (V2-58) it is the state seam's NOTIFY
 * TRANSPORT and nothing else — a plugin cannot reach it (`ctx.notify` left the SDK contract).
 *
 * WHAT IT CARRIES. A NAME: "this plugin's state value `name` changed". The state hub (`state.ts`)
 * hands every change here (`onChange`), and a tab on the notify transport hears the name over the
 * app's OWN push path — the `plugin.notifications` stream RPC over the websocket it already holds
 * (`apps/server/src/ws.ts`, `packages/contracts/src/ru-code/plugins/rpc.ts`) — and reads the value
 * through `plugin.state.read`. No socket is added, and the wire carries the name and nothing else.
 * On the STREAM transport no tab subscribes here, and a name with no sink costs nothing.
 *
 * ── THE TWO PROPERTIES THIS FILE OWNS ─────────────────────────────────────────────────────────
 *
 * FAN-OUT. One sink per SUBSCRIBER, i.e. one per open tab per environment (each tab holds its own
 * websocket and its own `plugin.notifications` stream). `notify` walks every sink, so one call
 * reaches all ten of the owner's tabs. A name with no sink at all is DISCARDED, not queued: a name
 * only ever means "re-read this", and a tab that opens (or reconnects) later reads every name it
 * holds anyway (`apps/web/src/ru-code/plugins/state.ts`, the ready edge).
 *
 * EVERY sink, the tab whose own `plugin.invoke` caused the change included — nothing here tracks
 * whose change it was (V2-54, as amended when V2-57 was withdrawn in S63). The causing tab reads
 * once and its cell applies only a value that differs from what it holds, so its own change costs
 * one read and no state change. The app does not suppress its own echo either: every tab applies the config
 * push its own write caused (`client-runtime/src/state/server.ts`, `subscribeServerConfig`).
 *
 * COALESCING, AND WHY IT IS NOT A DROP. A sink holds at most ONE pending notification per
 * `(pluginId, name)`: a second one, while the first is still on its way, is redundant by
 * construction — the tab's read happens AFTER the delivery, so it sees the newer state too. The key
 * is released when the item is PULLED from the queue, so a change made after that re-queues and is
 * delivered again. The error is therefore always in the safe direction (one redundant read, never a
 * missed one), and a burst of changes to one name costs one frame per tab in flight.
 *
 * That bound is also why there is no rate cap and no timer here (rule 38): the queue cannot grow
 * past (plugins × distinct names), which `MAX_STATE_NAMES_PER_PLUGIN` (imported from
 * `@smart-tools/plugin-sdk/state`, and enforced by the state hub before this hub is reached) makes a
 * small constant.
 */
import type { PluginId } from "@smart-tools/plugin-sdk/contracts";
import { MAX_STATE_NAMES_PER_PLUGIN, STATE_NAME_PATTERN } from "@smart-tools/plugin-sdk/state";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * One notification, as it crosses the wire and reaches a tab. A name, and whose it is.
 *
 * `pluginId` is the BRANDED id, not a bare string — the same brand the folder name, the storage
 * path and the asset route are built on, and the one the contract's `PluginNotification` demands.
 * It is never minted here: it comes from the manifest the host decoded at boot, so an id that
 * could never name a plugin cannot reach a tab's routing table.
 */
export interface PluginNotification {
  readonly pluginId: PluginId;
  readonly name: string;
}

/** One subscriber — one open tab's `plugin.notifications` stream. */
interface NotifySink {
  /** The coalescing key of every notification queued and not yet pulled. */
  readonly queued: Set<string>;
  readonly queue: Queue.Queue<PluginNotification>;
}

export interface PluginNotifyHub {
  /** One changed name for one plugin (the state hub's `onChange`). Never throws, never waits. */
  readonly notify: (pluginId: PluginId, name: string) => void;
  /**
   * One subscriber's stream. Registers its sink when the stream is pulled and removes it when the
   * stream ends — the request's own end (the tab closed, the socket dropped, the server stopped).
   */
  readonly notifications: Stream.Stream<PluginNotification>;
  /** How many tabs are subscribed right now. For the host's own diagnostics and its specs. */
  readonly subscriberCount: () => number;
}

/**
 * The key a sink coalesces on.
 *
 * The separator is a NUL, which neither half can contain: a plugin id is
 * `PLUGIN_ID_PATTERN`-branded and a name is `STATE_NAME_PATTERN`-checked (by the state hub before
 * this hub is reached, and again in `admitName` below), so `("a", "b.c")`
 * and `("a.b", "c")` cannot collide however the two are spelled.
 */
const keyOf = (pluginId: PluginId, name: string): string => `${pluginId}\u0000${name}`;

export interface NotifyHubOptions {
  /**
   * How the host says a plugin got this wrong: ONE line per `(pluginId, code)`, like the web's
   * problem channel (V2-42). The hub does the de-duplication; the caller only writes the line.
   */
  readonly report: (input: {
    readonly pluginId: PluginId;
    readonly code: string;
    readonly message: string;
  }) => void;
}

export const makePluginNotifyHub = (options: NotifyHubOptions): PluginNotifyHub => {
  const sinks = new Set<NotifySink>();
  /** Which names each plugin has used — the `MAX_STATE_NAMES_PER_PLUGIN` ledger. */
  const namesByPlugin = new Map<string, Set<string>>();
  /** Every `<pluginId>:<code>` already reported — the host says each thing once. */
  const reported = new Set<string>();

  const reportOnce = (pluginId: PluginId, code: string, message: string): void => {
    const key = `${pluginId}:${code}`;
    if (reported.has(key)) return;
    reported.add(key);
    options.report({ pluginId, code, message });
  };

  const admitName = (pluginId: PluginId, name: string): boolean => {
    // `typeof` as well as the pattern: a plugin's server half is plain JavaScript by the time the
    // host loads it, so `notify(undefined)` is a call a real author makes.
    if (typeof name !== "string" || !STATE_NAME_PATTERN.test(name)) {
      reportOnce(
        pluginId,
        "notify-name-invalid",
        `notify(${JSON.stringify(name)}) — a name matches ${String(STATE_NAME_PATTERN)}`,
      );
      return false;
    }
    const names = namesByPlugin.get(pluginId) ?? new Set<string>();
    if (!names.has(name)) {
      if (names.size >= MAX_STATE_NAMES_PER_PLUGIN) {
        reportOnce(
          pluginId,
          "cap:notify-names",
          `at most ${String(MAX_STATE_NAMES_PER_PLUGIN)} distinct notify names per plugin; "${name}" is dropped`,
        );
        return false;
      }
      names.add(name);
      namesByPlugin.set(pluginId, names);
    }
    return true;
  };

  const notify = (pluginId: PluginId, name: string): void => {
    if (!admitName(pluginId, name)) return;
    const key = keyOf(pluginId, name);
    for (const sink of sinks) {
      // COALESCED: an identical notification is already on its way to this tab. See the header for
      // why dropping it cannot lose a change.
      if (sink.queued.has(key)) continue;
      sink.queued.add(key);
      // `offerUnsafe` because `notify` is synchronous and must never block a plugin's own code. An
      // unbounded queue always accepts; the `false` arm is a queue that has already been shut down
      // (the tab went away between the walk and the offer), and the key is released so the sink is
      // left consistent even though it is about to be discarded.
      if (!Queue.offerUnsafe(sink.queue, { pluginId, name })) sink.queued.delete(key);
    }
  };

  const notifications: Stream.Stream<PluginNotification> = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<PluginNotification>();
      const sink: NotifySink = { queued: new Set<string>(), queue };
      sinks.add(sink);
      return Stream.fromQueue(queue).pipe(
        // Released ON THE PULL, not on the write: see the header. This is the one line that makes
        // the coalescing lossless, so it belongs downstream of the queue and upstream of nothing.
        Stream.map((notification) => {
          sink.queued.delete(keyOf(notification.pluginId, notification.name));
          return notification;
        }),
        // The request's own end, whichever way it comes — the tab closed, the socket dropped, the
        // plugin host's scope closed under it. No timer, and nothing to leak: the sink is the only
        // reference the hub holds.
        Stream.ensuring(
          Effect.sync(() => {
            sinks.delete(sink);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
        ),
      );
    }),
  );

  return { notify, notifications, subscriberCount: () => sinks.size };
};
