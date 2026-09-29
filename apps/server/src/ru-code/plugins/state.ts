/**
 * ru-code S69 (V2-58): the SERVER half of the state seam — `ctx.publish(name, value)`.
 *
 * WHAT IT OWNS. The last value every plugin published under every name, the compare that decides
 * whether a publish is a CHANGE, the checks every plugin-facing surface has (name, names per plugin,
 * JSON, size), and the fan-out of a change to every tab. A plugin calls `publish` whenever it
 * likes — after every operation, on every tick — and never tracks what it sent: a value equal to the
 * one held stops here and costs no tab anything.
 *
 * ONE TRANSPORT, `plugin.state` (V2-75: the notify transport is gone). Every subscriber gets a
 * SNAPSHOT of every current value first, then one `value` frame per change. Per subscriber the
 * pending frames are LATEST-WINS: at most one per `(plugin, name)`, replaced in place by a newer
 * value, released when the tab takes it. So a plugin publishing faster than a tab reads costs that
 * tab one frame per pull, carrying the newest value — never a queue of stale ones, and never a lost
 * last value.
 *
 * THE POSITION (S104, V2-73). The hub counts every change it accepts (`seq`) and names its process
 * (`boot`, a new one per server start). An invoke answer carries the position when its handler
 * returned (`rpcHandlers.ts`), a snapshot the position it was taken at, and each `value` frame its
 * FLOOR: every change up to it has reached this tab — delivered, or replaced by a frame the tab
 * already took. A pending frame keeps the seq of the FIRST change it covers, so a replacement never
 * lets the floor pass a change the tab has not seen in any form. That is what lets the web host
 * resolve a command only once `ctx.state` holds everything published before its answer, with no
 * timer: every wait ends on a frame or a snapshot this hub already owes the tab.
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
import type { PluginStateFrame, PluginStatePosition, PluginStateValue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The key a value and a pending frame are stored under. NUL cannot occur in either half. */
const keyOf = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/**
 * One value waiting for a tab: the newest value (LATEST WINS), and the seq of the FIRST change it
 * covers — a replacement keeps it, so the tab's floor stays below every change it has not seen.
 */
interface PendingValue {
  readonly entry: PluginStateValue;
  readonly seq: number;
}

/** One subscriber — one open tab's `plugin.state` stream. */
interface StateSink {
  /**
   * The values not yet taken by this tab, per key. A `Map` keeps the order keys were FIRST queued in,
   * which is seq order (a replacement keeps its key's place), so the first entry holds the lowest
   * seq still owed.
   */
  readonly pending: Map<string, PendingValue>;
  readonly queue: Queue.Queue<string>;
}

export interface PluginStateHub {
  /** `ctx.publish(name, value)` for one plugin. Never throws, never waits. */
  readonly publish: (pluginId: PluginId, name: string, value: unknown) => void;
  /** Where the hub stands now: its process and the count of changes it has accepted (S104). */
  readonly position: () => PluginStatePosition;
  /** One subscriber's `plugin.state` stream: the snapshot, then every change. */
  readonly frames: Stream.Stream<PluginStateFrame>;
  /** How many tabs hold a `plugin.state` stream right now. Diagnostics and specs. */
  readonly subscriberCount: () => number;
}

export interface StateHubOptions {
  /** One line per `(pluginId, code)` — the hub de-duplicates. */
  readonly report: (input: {
    readonly pluginId: PluginId;
    readonly code: string;
    readonly message: string;
  }) => void;
  /** This server process's name — a restarted server is a new hub with a new one (S104). */
  readonly boot: string;
}

export const makePluginStateHub = (options: StateHubOptions): PluginStateHub => {
  /** Every current value, in first-publish order — the order a snapshot lists them in. */
  const values = new Map<string, PluginStateValue>();
  /** How many distinct names each plugin holds — the `MAX_STATE_NAMES_PER_PLUGIN` ledger. */
  const namesByPlugin = new Map<string, number>();
  const sinks = new Set<StateSink>();
  const reported = new Set<string>();
  /** Every change this hub accepted, counted. */
  let seq = 0;

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
    seq += 1;
    for (const sink of sinks) {
      // LATEST WINS: a frame for this key still waiting for the tab is REPLACED, not queued behind —
      // and keeps the seq of the first change it covers.
      const waiting = sink.pending.get(key);
      if (waiting !== undefined) {
        sink.pending.set(key, { entry, seq: waiting.seq });
        continue;
      }
      sink.pending.set(key, { entry, seq });
      // An unbounded queue always accepts; `false` is a queue already shut down (the tab went away
      // between the walk and the offer), and the entry is dropped with the sink.
      if (!Queue.offerUnsafe(sink.queue, key)) sink.pending.delete(key);
    }
  };

  const frames: Stream.Stream<PluginStateFrame> = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>();
      const sink: StateSink = { pending: new Map(), queue };
      // Registered and snapshotted in ONE synchronous step: `publish` is synchronous too, so no
      // change can fall between the snapshot and the sink. A change after it is queued, and a
      // change the snapshot already carries arrives again as an equal value the tab drops.
      sinks.add(sink);
      const snapshot: PluginStateFrame = {
        _tag: "snapshot",
        values: Array.from(values.values()),
        boot: options.boot,
        seq,
      };
      return Stream.concat(
        Stream.succeed(snapshot),
        Stream.fromQueue(queue).pipe(
          // Taken ON THE PULL: the entry is whatever is newest NOW, not what was offered first. The
          // floor is just below the first change still owed to this tab, or the whole count.
          Stream.map((key): PluginStateFrame | null => {
            const pending = sink.pending.get(key);
            sink.pending.delete(key);
            if (pending === undefined) return null;
            const owed = sink.pending.values().next();
            const floor = owed.done === true ? seq : owed.value.seq - 1;
            return { _tag: "value", ...pending.entry, floor };
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
    position: () => ({ boot: options.boot, seq }),
    frames,
    subscriberCount: () => sinks.size,
  };
};
