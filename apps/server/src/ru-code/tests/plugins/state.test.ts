// ru-code S69 (V2-58): the server half of the state seam — the store, the compare, the checks, and
// the `plugin.state` stream's snapshot + latest-wins frames. The wire is `rpcHandlers.test.ts`'s;
// the web half's rules are the SDK's (`plugin-sdk/tests/state`).
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import type { PluginStateFrame } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { MAX_STATE_NAMES_PER_PLUGIN, MAX_STATE_VALUE_BYTES } from "@smart-tools/plugin-sdk/state";

import { makePluginStateHub, type PluginStateHub } from "../../plugins/state.ts";

const ALPHA = PluginId.make("alpha");
const BETA = PluginId.make("beta");

const hubWithReports = () => {
  const reports: Array<{
    readonly pluginId: string;
    readonly code: string;
    readonly message: string;
  }> = [];
  const hub = makePluginStateHub({
    report: (entry) => reports.push(entry),
    boot: "boot-test",
  });
  return { hub, reports };
};

/** What the hub holds now, as a tab opening NOW would receive it: its snapshot, by `plugin:name`. */
const held = (hub: PluginStateHub) =>
  Effect.map(Stream.runHead(hub.frames), (head) => {
    const frame = Option.getOrThrow(head);
    if (frame._tag !== "snapshot") throw new Error("the first frame is not the snapshot");
    return Object.fromEntries(
      frame.values.map((entry) => [`${entry.pluginId}:${entry.name}`, entry.value]),
    );
  });

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
  it.effect("a publish EQUAL to the value held is not a change: no frame, no report", () =>
    Effect.gen(function* () {
      const { hub, reports } = hubWithReports();
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
          boot: "boot-test",
          seq: 1,
        },
      ]);
      expect(reports).toEqual([]);
    }),
  );

  it.effect("stores a COPY: mutating the published object afterwards changes nothing", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const value = { rows: [1] };
      hub.publish(ALPHA, "rows", value);
      value.rows.push(2);
      expect(yield* held(hub)).toEqual({ "alpha:rows": { rows: [1] } });
    }),
  );
});

describe("the state hub — the plugin.state stream (V2-58)", () => {
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
              boot: "boot-test",
              seq: 2,
            },
            { _tag: "value", pluginId: ALPHA, name: "a", value: 2, floor: 3 },
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
        expect(one.frames).toEqual([{ _tag: "snapshot", values: [], boot: "boot-test", seq: 0 }]);
      }),
  );

  // The bound that replaces a rate cap (see `state.ts`): a thousand publishes while one frame is
  // pending cost ONE frame, and it carries the LAST value — never a stale queue, never a lost end.
  it.effect("LATEST WINS: a burst costs a tab one frame per pull, carrying the last value", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const one = yield* tab(hub.frames);
      yield* settle;
      for (let index = 1; index <= 1000; index += 1) hub.publish(ALPHA, "count", index);
      yield* settle;
      expect(one.frames).toEqual([
        { _tag: "snapshot", values: [], boot: "boot-test", seq: 0 },
        { _tag: "value", pluginId: ALPHA, name: "count", value: 1000, floor: 1000 },
      ]);
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
      expect(yield* held(hub)).toEqual({ "alpha:a": 1 });
    }),
  );
});

// S104 (V2-73, option 1): the hub's POSITION — what lets the web host resolve a command only once the
// tab holds everything published before the answer. `seq` counts every ACCEPTED change, `boot` names
// the process; a snapshot carries the position it was taken at, an invoke answer the position when
// its handler returned (`rpcHandlers.test.ts`), and a `value` frame the `floor`: every change up to
// it has reached this tab — delivered, or replaced by a frame this tab already took.
describe("the state hub — its position: seq, boot and each frame's floor (S104)", () => {
  it.effect(
    "seq counts accepted CHANGES only; a snapshot carries the position it was taken at",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        expect(hub.position()).toEqual({ boot: "boot-test", seq: 0 });
        hub.publish(ALPHA, "a", 1);
        hub.publish(ALPHA, "a", 1); // equal: not a change
        hub.publish(ALPHA, "no spaces", 1); // refused
        hub.publish(ALPHA, "b", 2);
        expect(hub.position()).toEqual({ boot: "boot-test", seq: 2 });
        const one = yield* tab(hub.frames);
        yield* settle;
        expect(one.frames[0]).toMatchObject({ _tag: "snapshot", boot: "boot-test", seq: 2 });
      }),
  );

  it.effect("a frame's floor never passes a change still pending for this tab", () =>
    Effect.gen(function* () {
      const { hub } = hubWithReports();
      const one = yield* tab(hub.frames);
      yield* settle;
      hub.publish(ALPHA, "a", 1); // seq 1
      hub.publish(ALPHA, "b", 2); // seq 2
      yield* settle;
      expect(one.frames.slice(1)).toEqual([
        { _tag: "value", pluginId: ALPHA, name: "a", value: 1, floor: 1 },
        { _tag: "value", pluginId: ALPHA, name: "b", value: 2, floor: 2 },
      ]);
    }),
  );

  it.effect(
    "LATEST-WINS keeps the floor honest: a replaced frame's change is covered only when its replacement is taken",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        const one = yield* tab(hub.frames);
        yield* settle;
        // THE ANSWER'S CASE (I3): this tab's start publishes `running` (seq 1) and answers at seq 1;
        // another tab's cancel replaces it with `idle` (seq 2) before this tab pulls.
        hub.publish(ALPHA, "scan", "running");
        const answeredAt = hub.position().seq;
        hub.publish(ALPHA, "scan", "idle");
        yield* settle;
        const frames = one.frames.slice(1);
        expect(frames).toEqual([
          { _tag: "value", pluginId: ALPHA, name: "scan", value: "idle", floor: 2 },
        ]);
        expect(answeredAt).toBe(1);
      }),
  );

  // S104 R2 flip Q2: the replacement's PLACE and SEQ. Pulled in first-queued order, a replaced key
  // still waiting behind ANOTHER key must hold that key's frame at the replaced change's seq: its
  // newer value is not in the tab yet, so no answer at or past that change may be released.
  it.effect(
    "a replaced value still waiting keeps the seq of the change it replaced: the other key's frame stops below it",
    () =>
      Effect.gen(function* () {
        const { hub } = hubWithReports();
        const one = yield* tab(hub.frames);
        yield* settle;
        hub.publish(ALPHA, "a", 1); // seq 1 — taken
        yield* settle;
        hub.publish(ALPHA, "b", 1); // seq 2 — queued first
        hub.publish(ALPHA, "a", 2); // seq 3 — queued behind b
        hub.publish(ALPHA, "a", 3); // seq 4 — REPLACES seq 3 before the pull
        yield* settle;
        expect(one.frames.slice(1)).toEqual([
          { _tag: "value", pluginId: ALPHA, name: "a", value: 1, floor: 1 },
          // Change 3 (a = 2) is owed until a's frame is taken: the floor stays at 2.
          { _tag: "value", pluginId: ALPHA, name: "b", value: 1, floor: 2 },
          { _tag: "value", pluginId: ALPHA, name: "a", value: 3, floor: 4 },
        ]);
      }),
  );

  it.effect("each hub is its own process: a new boot, and the count starts again", () =>
    Effect.sync(() => {
      const first = makePluginStateHub({ report: () => {}, boot: "boot-a" });
      const second = makePluginStateHub({ report: () => {}, boot: "boot-b" });
      first.publish(ALPHA, "a", 1);
      expect(first.position()).toEqual({ boot: "boot-a", seq: 1 });
      expect(second.position()).toEqual({ boot: "boot-b", seq: 0 });
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
      Effect.gen(function* () {
        const { hub, reports } = hubWithReports();
        hub.publish(ALPHA, "scan", { ok: true });
        hub.publish(ALPHA, "scan", { at: new Map() });
        hub.publish(ALPHA, "scan", { n: Number.NaN });
        hub.publish(ALPHA, "scan", { hole: undefined });
        hub.publish(ALPHA, "scan", undefined);
        expect(yield* held(hub)).toEqual({ "alpha:scan": { ok: true } });
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
    Effect.gen(function* () {
      const { hub, reports } = hubWithReports();
      hub.publish(ALPHA, "big", "x".repeat(MAX_STATE_VALUE_BYTES));
      // Exactly at the cap is accepted: `"` + n characters + `"` is n + 2 bytes.
      hub.publish(ALPHA, "fits", "x".repeat(MAX_STATE_VALUE_BYTES - 2));
      const now = yield* held(hub);
      expect(Object.keys(now)).toEqual(["alpha:fits"]);
      expect(now["alpha:fits"]).toHaveLength(MAX_STATE_VALUE_BYTES - 2);
      expect(reports.map((entry) => entry.code)).toEqual(["cap:state-value-bytes"]);
    }),
  );

  it.effect("a name past the per-plugin cap — and the cap is per PLUGIN", () =>
    Effect.gen(function* () {
      const { hub, reports } = hubWithReports();
      for (let index = 0; index < MAX_STATE_NAMES_PER_PLUGIN; index += 1) {
        hub.publish(ALPHA, `n${String(index)}`, index);
      }
      hub.publish(ALPHA, "one-too-many", 1);
      // A name already held is not a new name: publishing it again is never refused.
      hub.publish(ALPHA, "n0", 100);
      hub.publish(BETA, "one-too-many", 1);
      const now = yield* held(hub);
      expect(now["alpha:one-too-many"]).toBeUndefined();
      expect(now["alpha:n0"]).toBe(100);
      expect(now["beta:one-too-many"]).toBe(1);
      expect(reports.map((entry) => `${entry.pluginId}:${entry.code}`)).toEqual([
        "alpha:cap:state-names",
      ]);
    }),
  );
});
