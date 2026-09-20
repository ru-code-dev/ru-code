// ru-code S69 (V2-58): the server half of the state seam — the store, the compare, the checks, the
// stream transport's snapshot + latest-wins frames, and the notify transport's trigger and read.
// The wire is `rpcHandlers.test.ts`'s; the web half's rules are the SDK's (`plugin-sdk/tests/state`).
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import type { PluginStateFrame } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { MAX_STATE_NAMES_PER_PLUGIN, MAX_STATE_VALUE_BYTES } from "@smart-tools/plugin-sdk/state";

import { makePluginStateHub } from "../../plugins/state.ts";

const ALPHA = PluginId.make("alpha");
const BETA = PluginId.make("beta");

const hubWithReports = () => {
  const reports: Array<{
    readonly pluginId: string;
    readonly code: string;
    readonly message: string;
  }> = [];
  const changes: Array<string> = [];
  const hub = makePluginStateHub({
    report: (entry) => reports.push(entry),
    onChange: (pluginId, name) => changes.push(`${pluginId}:${name}`),
  });
  return { hub, reports, changes };
};

/** A tab's `plugin.state` stream, collected on a forked fiber — the thing that PULLS. */
const tab = (stream: Stream.Stream<PluginStateFrame>) =>
  Effect.gen(function* () {
    const frames: Array<PluginStateFrame> = [];
    const fiber = yield* Stream.runForEach(stream, (frame) =>
      Effect.sync(() => {
        frames.push(frame);
      }),
    ).pipe(Effect.forkScoped);
    return { frames, fiber };
  });

const settle = Effect.yieldNow.pipe(Effect.replicateEffect(20), Effect.asVoid);

describe("the state hub — the store and the compare (V2-58)", () => {
  it.effect(
    "a publish EQUAL to the value held is not a change: no frame, no notify, no report",
    () =>
      Effect.gen(function* () {
        const { hub, reports, changes } = hubWithReports();
        hub.publish(ALPHA, "scan", { phase: "idle", steps: [1, 2] });
        const one = yield* tab(hub.frames);
        yield* settle;
        // The same value, keys in another order — what two code paths serialising one state produce.
        hub.publish(ALPHA, "scan", { steps: [1, 2], phase: "idle" });
        hub.publish(ALPHA, "scan", { phase: "idle", steps: [1, 2] });
        yield* settle;
        expect(one.frames).toEqual([
          {
            _tag: "snapshot",
            values: [{ pluginId: ALPHA, name: "scan", value: { phase: "idle", steps: [1, 2] } }],
          },
        ]);
        expect(changes).toEqual(["alpha:scan"]);
        expect(reports).toEqual([]);
      }),
  );

  it.effect("stores a COPY: mutating the published object afterwards changes nothing", () =>
    Effect.sync(() => {
      const { hub } = hubWithReports();
      const value = { rows: [1] };
      hub.publish(ALPHA, "rows", value);
      value.rows.push(2);
      expect(hub.read(ALPHA, "rows")).toEqual({ value: { rows: [1] } });
    }),
  );

  it.effect("`read` answers the stored value, and NO `value` key when there is none", () =>
    Effect.sync(() => {
      const { hub } = hubWithReports();
      expect(hub.read(ALPHA, "never")).toEqual({});
      hub.publish(ALPHA, "nothing", null);
      expect(hub.read(ALPHA, "nothing")).toEqual({ value: null });
      expect(hub.read(BETA, "nothing")).toEqual({});
    }),
  );
});

describe("the state hub — the stream transport (V2-58)", () => {
  it.effect(
    "every tab starts from a SNAPSHOT of every plugin's current values, then hears each change",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        hub.publish(ALPHA, "a", 1);
        hub.publish(BETA, "b", "x");
        const one = yield* tab(hub.frames);
        const two = yield* tab(hub.frames);
        yield* settle;
        expect(hub.subscriberCount()).toBe(2);
        hub.publish(ALPHA, "a", 2);
        yield* settle;
        for (const seen of [one.frames, two.frames]) {
          expect(seen).toEqual([
            {
              _tag: "snapshot",
              values: [
                { pluginId: ALPHA, name: "a", value: 1 },
                { pluginId: BETA, name: "b", value: "x" },
              ],
            },
            { _tag: "value", pluginId: ALPHA, name: "a", value: 2 },
          ]);
        }
      }),
  );

  it.effect(
    "an empty store snapshots as NO values — what a tab reconnecting to a restarted server sees",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        const one = yield* tab(hub.frames);
        yield* settle;
        expect(one.frames).toEqual([{ _tag: "snapshot", values: [] }]);
      }),
  );

  // The bound that replaces a rate cap (see `state.ts`): a thousand publishes while one frame is
  // pending cost ONE frame, and it carries the LAST value — never a stale queue, never a lost end.
  it.effect("LATEST WINS: a burst costs a tab one frame per pull, carrying the last value", () =>
    Effect.gen(function* () {
      const { hub, changes } = hubWithReports();
      const one = yield* tab(hub.frames);
      yield* settle;
      for (let index = 1; index <= 1000; index += 1) hub.publish(ALPHA, "count", index);
      yield* settle;
      expect(one.frames).toEqual([
        { _tag: "snapshot", values: [] },
        { _tag: "value", pluginId: ALPHA, name: "count", value: 1000 },
      ]);
      // The notify transport's trigger fires per CHANGE; the notify hub coalesces it per tab.
      expect(changes).toHaveLength(1000);
    }),
  );

  it.effect("a tab that goes away is removed, and a publish after that reaches nobody", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const one = yield* tab(hub.frames);
      yield* settle;
      expect(hub.subscriberCount()).toBe(1);
      yield* Fiber.interrupt(one.fiber);
      expect(hub.subscriberCount()).toBe(0);
      hub.publish(ALPHA, "a", 1);
      expect(hub.read(ALPHA, "a")).toEqual({ value: 1 });
    }),
  );
});

describe("the state hub — refusals: reported once per code, never thrown, previous value stands", () => {
  it.effect("a name outside the pattern", () =>
    Effect.sync(() => {
      const { hub, reports } = hubWithReports();
      expect(() => {
        hub.publish(ALPHA, "no spaces", 1);
        hub.publish(ALPHA, "", 1);
        hub.publish(ALPHA, undefined as never, 1);
      }).not.toThrow();
      expect(reports.map((entry) => entry.code)).toEqual(["state-name-invalid"]);
    }),
  );

  it.effect(
    "a value that is not plain JSON — the same check an rpc answer passes — names the path",
    () =>
      Effect.sync(() => {
        const { hub, reports, changes } = hubWithReports();
        hub.publish(ALPHA, "scan", { ok: true });
        hub.publish(ALPHA, "scan", { at: new Map() });
        hub.publish(ALPHA, "scan", { n: Number.NaN });
        hub.publish(ALPHA, "scan", { hole: undefined });
        hub.publish(ALPHA, "scan", undefined);
        expect(hub.read(ALPHA, "scan")).toEqual({ value: { ok: true } });
        expect(changes).toEqual(["alpha:scan"]);
        expect(reports).toEqual([
          {
            pluginId: ALPHA,
            code: "state-value-invalid",
            message: 'publish("scan") — a Map at value.at; the previous value stands',
          },
        ]);
      }),
  );

  it.effect("a value over the byte cap", () =>
    Effect.sync(() => {
      const { hub, reports } = hubWithReports();
      hub.publish(ALPHA, "big", "x".repeat(MAX_STATE_VALUE_BYTES));
      // Exactly at the cap is accepted: `"` + n characters + `"` is n + 2 bytes.
      hub.publish(ALPHA, "fits", "x".repeat(MAX_STATE_VALUE_BYTES - 2));
      expect(hub.read(ALPHA, "big")).toEqual({});
      expect(hub.read(ALPHA, "fits").value).toHaveLength(MAX_STATE_VALUE_BYTES - 2);
      expect(reports.map((entry) => entry.code)).toEqual(["cap:state-value-bytes"]);
    }),
  );

  it.effect("a name past the per-plugin cap — and the cap is per PLUGIN", () =>
    Effect.sync(() => {
      const { hub, reports } = hubWithReports();
      for (let index = 0; index < MAX_STATE_NAMES_PER_PLUGIN; index += 1) {
        hub.publish(ALPHA, `n${String(index)}`, index);
      }
      hub.publish(ALPHA, "one-too-many", 1);
      // A name already held is not a new name: publishing it again is never refused.
      hub.publish(ALPHA, "n0", 100);
      hub.publish(BETA, "one-too-many", 1);
      expect(hub.read(ALPHA, "one-too-many")).toEqual({});
      expect(hub.read(ALPHA, "n0")).toEqual({ value: 100 });
      expect(hub.read(BETA, "one-too-many")).toEqual({ value: 1 });
      expect(reports.map((entry) => `${entry.pluginId}:${entry.code}`)).toEqual([
        "alpha:cap:state-names",
      ]);
    }),
  );
});
