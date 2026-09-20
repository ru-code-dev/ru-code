// ru-code S53 (V2-54): the server→web notify hub — fan-out, coalescing, the two caps and the
// release path. Every claim the seam makes about the SERVER half is pinned here; the wire is
// `rpcHandlers.test.ts`'s and the routing is the web host's.
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { MAX_STATE_NAMES_PER_PLUGIN } from "@smart-tools/plugin-sdk/state";

import { makePluginNotifyHub, type PluginNotification } from "../../plugins/notify.ts";

interface Reported {
  readonly pluginId: string;
  readonly code: string;
  readonly message: string;
}

const hubWithReports = () => {
  const reports: Array<Reported> = [];
  const hub = makePluginNotifyHub({ report: (entry) => reports.push(entry) });
  return { hub, reports };
};

const ALPHA = PluginId.make("alpha");
const BETA = PluginId.make("beta");

/**
 * Collect notifications into an array as they arrive, on a forked fiber, and hand back a reader.
 *
 * `Effect.forkScoped` and not `Effect.fork`: the fiber has to die with the test's own scope, and
 * the collector is what stands in for a tab's socket — it is the thing that PULLS, which is what
 * releases a coalescing key.
 */
const subscriber = (stream: Stream.Stream<PluginNotification>) =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const fiber = yield* Stream.runForEach(stream, (notification) =>
      Effect.sync(() => {
        seen.push(`${notification.pluginId}:${notification.name}`);
      }),
    ).pipe(Effect.forkScoped);
    return { seen, fiber };
  });

/** Let the forked collector run: a notification crosses a queue, so it lands on a later turn. */
const settle = Effect.yieldNow.pipe(Effect.replicateEffect(20), Effect.asVoid);

describe("the notify hub — fan-out (V2-54)", () => {
  it.effect("delivers one `notify` to EVERY subscriber", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const one = yield* subscriber(hub.notifications);
      const two = yield* subscriber(hub.notifications);
      const three = yield* subscriber(hub.notifications);
      yield* settle;
      expect(hub.subscriberCount()).toBe(3);

      hub.notify(ALPHA, "scanState");
      yield* settle;

      // The whole point of the seam: ten tabs, one reconcile, ten refreshes.
      expect(one.seen).toEqual(["alpha:scanState"]);
      expect(two.seen).toEqual(["alpha:scanState"]);
      expect(three.seen).toEqual(["alpha:scanState"]);
    }),
  );

  it.effect("carries the plugin id it was notified under, and nothing else", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;
      hub.notify(ALPHA, "one");
      hub.notify(BETA, "two");
      yield* settle;
      // One stream carries every plugin's names; the WEB host routes them (no plugin can read
      // another's, because `ctx.state` is bound to an id).
      expect(tab.seen).toEqual(["alpha:one", "beta:two"]);
    }),
  );

  it.effect("discards a notification when no tab is subscribed — it is never queued", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      expect(() => hub.notify(ALPHA, "scanState")).not.toThrow();
      expect(hub.subscriberCount()).toBe(0);

      const late = yield* subscriber(hub.notifications);
      yield* settle;
      // NO REPLAY: a tab that opens later reads everything anyway, so a name from before it
      // existed would only be a redundant read — and the contract says it will not get one.
      expect(late.seen).toEqual([]);
    }),
  );

  it.effect(
    "releases the sink when the subscriber's stream ends — a closed tab leaks nothing",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        const tab = yield* subscriber(hub.notifications);
        yield* settle;
        expect(hub.subscriberCount()).toBe(1);

        yield* Fiber.interrupt(tab.fiber);
        yield* settle;
        expect(hub.subscriberCount()).toBe(0);

        // And the hub is still usable for the tabs that remain.
        const other = yield* subscriber(hub.notifications);
        yield* settle;
        hub.notify(ALPHA, "scanState");
        yield* settle;
        expect(other.seen).toEqual(["alpha:scanState"]);
      }),
  );
});

describe("the notify hub — coalescing (V2-54)", () => {
  it.effect("collapses a burst of the SAME name into the one delivery that is pending", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;

      // SYNCHRONOUS: the loop never yields, so the collector fiber cannot pull between calls and
      // the coalescing key stays set for the whole burst. This is exactly the shape the seam has
      // to survive — `plugin-auto-coder` notifies per output line while a run is producing them.
      for (let index = 0; index < 1000; index += 1) hub.notify(ALPHA, "run.output");
      yield* settle;

      // One frame for a thousand calls. Without the coalescing rule this array has 1000 entries.
      expect(tab.seen).toEqual(["alpha:run.output"]);
    }),
  );

  it.effect("still delivers the name AGAIN once the pending one has been pulled", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;

      hub.notify(ALPHA, "run.output");
      yield* settle;
      // The key is released on the PULL, so a change made after it is a new notification. This is
      // the property that makes coalescing lossless rather than a drop.
      hub.notify(ALPHA, "run.output");
      yield* settle;
      expect(tab.seen).toEqual(["alpha:run.output", "alpha:run.output"]);
    }),
  );

  it.effect("never coalesces two DIFFERENT names, or two plugins' same name", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;
      hub.notify(ALPHA, "one");
      hub.notify(ALPHA, "two");
      hub.notify(BETA, "one");
      yield* settle;
      expect(tab.seen).toEqual(["alpha:one", "alpha:two", "beta:one"]);
    }),
  );
});

describe("the notify hub — caps (V2-54)", () => {
  it.effect("drops a name the pattern refuses and reports it ONCE per (plugin, code)", () =>
    Effect.gen(function* () {
      const { hub, reports } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;

      hub.notify(ALPHA, "");
      hub.notify(ALPHA, ".leading-dot");
      hub.notify(ALPHA, "has space");
      hub.notify(ALPHA, "x".repeat(65));
      // A server half is plain JavaScript by the time the host loads it.
      hub.notify(ALPHA, undefined as unknown as string);
      yield* settle;

      expect(tab.seen).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.code).toBe("notify-name-invalid");

      // A GOOD name still goes through — the refusal is per call, not a shutdown.
      hub.notify(ALPHA, "good.name_1");
      yield* settle;
      expect(tab.seen).toEqual(["alpha:good.name_1"]);
    }),
  );

  it.effect("caps the DISTINCT names one plugin may use, and says so once", () =>
    Effect.gen(function* () {
      const { hub, reports } = hubWithReports();
      const tab = yield* subscriber(hub.notifications);
      yield* settle;

      for (let index = 0; index < MAX_STATE_NAMES_PER_PLUGIN; index += 1) {
        hub.notify(ALPHA, `name${String(index)}`);
        // Pull between calls so nothing coalesces and the count is the delivery count.
        yield* settle;
      }
      expect(tab.seen).toHaveLength(MAX_STATE_NAMES_PER_PLUGIN);

      hub.notify(ALPHA, "one-too-many");
      hub.notify(ALPHA, "and-another");
      yield* settle;
      expect(tab.seen).toHaveLength(MAX_STATE_NAMES_PER_PLUGIN);
      expect(reports.filter((entry) => entry.code === "cap:notify-names")).toHaveLength(1);

      // A name already in the ledger is unaffected — the cap is on the KEY SPACE, not the rate.
      hub.notify(ALPHA, "name0");
      yield* settle;
      expect(tab.seen).toHaveLength(MAX_STATE_NAMES_PER_PLUGIN + 1);

      // And it is PER PLUGIN: another plugin's ledger is its own.
      hub.notify(BETA, "one-too-many");
      yield* settle;
      expect(tab.seen.at(-1)).toBe("beta:one-too-many");
    }),
  );
});
