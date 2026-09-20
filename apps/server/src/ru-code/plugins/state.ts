/**
 * ru-code S69 (V2-58): the SERVER half of the state seam — `ctx.publish(name, value)`.
 *
 * WHAT IT OWNS. The last value every plugin published under every name, the compare that decides
 * whether a publish is a CHANGE, the checks every plugin-facing surface has (name, names per plugin,
 * JSON, size), and the fan-out of a change to both transports. A plugin calls `publish` whenever it
 * likes — after every operation, on every tick — and never tracks what it sent: a value equal to the
 * one held stops here and costs no tab anything.
 *
 * TWO TRANSPORTS, ONE STORE (the web host's `PLUGIN_STATE_TRANSPORT` picks which one a tab uses):
 *
 *   · STREAM — `plugin.state`. Every subscriber gets a SNAPSHOT of every current value first, then
 *     one `value` frame per change. Per subscriber the pending frames are LATEST-WINS: at most one
 *     per `(plugin, name)`, replaced in place by a newer value, released when the tab takes it. So
 *     a plugin publishing faster than a tab reads costs that tab one frame per read, carrying the
 *     newest value — never a queue of stale ones, and never a lost last value.
 *   · NOTIFY — every change is handed to `onChange`, which the host wires to the notify hub
 *     (`notify.ts`): the tab hears the name and reads the value through `plugin.state.read`
 *     ({@link PluginStateHub.read}), one read in flight per name (the SDK's `makeStateReader`).
 *
 * THE COMPARE IS STRUCTURAL (`@smart-tools/plugin-sdk/state` `sameJson`) and runs on the value as it
 * will be SENT — the JSON text parsed back — so a value that differs only in a key the wire drops,
 * or in key order, is not a change.
 *
 * NO RATE CAP, AND NO TIMER (rule 38). A rate cap refuses a publish, and with no timer nothing would
 * ever deliver the value it refused: a burst's LAST publish — the one that says where the state
 * ended up — could be the refused one, and a daemon that then goes quiet would leave every tab on a
 * stale value for good. What a rate cap exists to bound is bounded here by construction instead: the
 * wire by latest-wins (one pending frame per name per tab), the work per publish by the byte cap.
 */
import type { PluginId } from "@smart-tools/plugin-sdk/contracts";
import {
  MAX_STATE_NAMES_PER_PLUGIN,
  MAX_STATE_VALUE_BYTES,
  STATE_NAME_PATTERN,
  describeNonJson,
  findNonJson,
  sameJson,
} from "@smart-tools/plugin-sdk/state";
import type { PluginStateFrame, PluginStateValue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The key a value and a pending frame are stored under. NUL cannot occur in either half. */
const keyOf = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** One subscriber — one open tab's `plugin.state` stream. */
interface StateSink {
  /** The newest value not yet taken by this tab, per key: LATEST WINS. */
  readonly pending: Map<string, PluginStateValue>;
  readonly queue: Queue.Queue<string>;
}

export interface PluginStateHub {
  /** `ctx.publish(name, value)` for one plugin. Never throws, never waits. */
  readonly publish: (pluginId: PluginId, name: string, value: unknown) => void;
  /** `plugin.state.read`: the stored value, or no `value` key when there is none. */
  readonly read: (pluginId: string, name: string) => { readonly value?: unknown };
  /** One subscriber's `plugin.state` stream: the snapshot, then every change. */
  readonly frames: Stream.Stream<PluginStateFrame>;
  /** How many tabs hold a `plugin.state` stream right now. Diagnostics and specs. */
  readonly subscriberCount: () => number;
}

export interface StateHubOptions {
  /** One line per `(pluginId, code)` — the hub de-duplicates, like the notify hub's. */
  readonly report: (input: {
    readonly pluginId: PluginId;
    readonly code: string;
    readonly message: string;
  }) => void;
  /** A value CHANGED — the notify transport's trigger (the host wires it to the notify hub). */
  readonly onChange: (pluginId: PluginId, name: string) => void;
}

export const makePluginStateHub = (options: StateHubOptions): PluginStateHub => {
  /** Every current value, in first-publish order — the order a snapshot lists them in. */
  const values = new Map<string, PluginStateValue>();
  /** How many distinct names each plugin holds — the `MAX_STATE_NAMES_PER_PLUGIN` ledger. */
  const namesByPlugin = new Map<string, number>();
  const sinks = new Set<StateSink>();
  const reported = new Set<string>();

  const reportOnce = (pluginId: PluginId, code: string, message: string): void => {
    const key = `${pluginId}:${code}`;
    if (reported.has(key)) return;
    reported.add(key);
    options.report({ pluginId, code, message });
  };

  const publish = (pluginId: PluginId, name: string, value: unknown): void => {
    // `typeof` as well as the pattern: the server half is plain JavaScript once loaded.
    if (typeof name !== "string" || !STATE_NAME_PATTERN.test(name)) {
      reportOnce(
        pluginId,
        "state-name-invalid",
        `publish(${JSON.stringify(name)}) — a name matches ${String(STATE_NAME_PATTERN)}`,
      );
      return;
    }
    // The same check every `rpc` answer passes (`PluginHost.ts` `invoke`, rule 37), for the same
    // reason: past this point the value is inside the RPC encoder, where a non-JSON value dies as
    // an untyped defect on the wire instead of a line that names the plugin, the name and the path.
    const offending = findNonJson(value, "value");
    if (offending !== null) {
      reportOnce(
        pluginId,
        "state-value-invalid",
        `publish(${JSON.stringify(name)}) — ${describeNonJson(offending.found)} at ${offending.path}; the previous value stands`,
      );
      return;
    }
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_STATE_VALUE_BYTES) {
      reportOnce(
        pluginId,
        "cap:state-value-bytes",
        `publish(${JSON.stringify(name)}) — ${String(bytes)} bytes of JSON; at most ${String(MAX_STATE_VALUE_BYTES)} (publish the summary, fetch the detail)`,
      );
      return;
    }
    const key = keyOf(pluginId, name);
    const held = values.get(key);
    if (held === undefined) {
      const count = namesByPlugin.get(pluginId) ?? 0;
      if (count >= MAX_STATE_NAMES_PER_PLUGIN) {
        reportOnce(
          pluginId,
          "cap:state-names",
          `at most ${String(MAX_STATE_NAMES_PER_PLUGIN)} distinct state names per plugin; "${name}" is dropped`,
        );
        return;
      }
      namesByPlugin.set(pluginId, count + 1);
    }
    // The value as a tab will receive it — the text parsed back — which is also a COPY: a plugin
    // that mutates the object it published after the call cannot change what the host holds.
    const stored = JSON.parse(text) as unknown;
    if (held !== undefined && sameJson(held.value, stored)) return;
    const entry: PluginStateValue = { pluginId, name, value: stored };
    values.set(key, entry);
    for (const sink of sinks) {
      // LATEST WINS: a frame for this key still waiting for the tab is REPLACED, not queued behind.
      if (sink.pending.has(key)) {
        sink.pending.set(key, entry);
        continue;
      }
      sink.pending.set(key, entry);
      // An unbounded queue always accepts; `false` is a queue already shut down (the tab went away
      // between the walk and the offer), and the entry is dropped with the sink.
      if (!Queue.offerUnsafe(sink.queue, key)) sink.pending.delete(key);
    }
    options.onChange(pluginId, name);
  };

  const frames: Stream.Stream<PluginStateFrame> = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>();
      const sink: StateSink = { pending: new Map(), queue };
      // Registered and snapshotted in ONE synchronous step: `publish` is synchronous too, so no
      // change can fall between the snapshot and the sink. A change after it is queued, and a
      // change the snapshot already carries arrives again as an equal value the tab drops.
      sinks.add(sink);
      const snapshot: PluginStateFrame = { _tag: "snapshot", values: Array.from(values.values()) };
      return Stream.concat(
        Stream.succeed(snapshot),
        Stream.fromQueue(queue).pipe(
          // Taken ON THE PULL: the entry is whatever is newest NOW, not what was offered first.
          Stream.map((key): PluginStateFrame | null => {
            const entry = sink.pending.get(key);
            sink.pending.delete(key);
            return entry === undefined ? null : { _tag: "value", ...entry };
          }),
          Stream.filter((frame): frame is PluginStateFrame => frame !== null),
        ),
      ).pipe(
        // The request's own end — the tab closed, the socket dropped, the host's scope closed.
        Stream.ensuring(
          Effect.sync(() => {
            sinks.delete(sink);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
        ),
      );
    }),
  );

  return {
    publish,
    read: (pluginId, name) => {
      const entry = values.get(keyOf(pluginId, name));
      return entry === undefined ? {} : { value: entry.value };
    },
    frames,
    subscriberCount: () => sinks.size,
  };
};
