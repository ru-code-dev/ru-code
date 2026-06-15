import { assert, describe, it } from "@effect/vitest";
import { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeProcessor } from "../src/engine.ts";
import type { AcpRunnerShape, ProcessorConfig } from "../src/types.ts";
import { addNode, makeDeps, makeState, scriptedAcp, type FakeState } from "./fakes.ts";

const dz = DesignerId.make("dz_a");
const html = ResultTag.make("html");
const summary = ResultTag.make("summary");
const config: ProcessorConfig = [{ designerId: dz, prompt: "P", resultTag: html }];
const node = (id: string) => ({ nodeId: NodeId.make(id), rootName: "N", nodesJson: "{}" });

const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
  });

const allDone = (state: FakeState, count: number) =>
  state.rows.length === count && state.rows.every((r) => r.status === "done");

describe("makeProcessor — runTickOnce", () => {
  it.effect("reconciles only configured designers and drains them to done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        addNode(state, DesignerId.make("dz_other"), node("nX"));
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.runTickOnce;
        assert.equal(state.rows.length, 1);
        assert.equal(state.rows[0]!.nodeId, "n1");
        assert.equal(state.rows[0]!.status, "done");
        assert.equal(state.rows[0]!.result, "OUT");
      }),
    ),
  );

  it.effect("creates one row per configured tag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        const twoTags: ProcessorConfig = [
          { designerId: dz, prompt: "P1", resultTag: html },
          { designerId: dz, prompt: "P2", resultTag: summary },
        ];
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), {
          config: twoTags,
        });
        yield* processor.runTickOnce;
        assert.isTrue(allDone(state, 2));
      }),
    ),
  );

  it.effect("is idempotent across ticks (no duplicate rows)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.runTickOnce;
        yield* processor.runTickOnce;
        assert.equal(state.rows.length, 1);
      }),
    ),
  );

  it.effect("backfills nodes added after an earlier tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.runTickOnce;
        addNode(state, dz, node("n2"));
        yield* processor.runTickOnce;
        assert.isTrue(allDone(state, 2));
      }),
    ),
  );

  it.effect("fails a pending row that has no configured prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        state.rows.push({
          id: "r0",
          designerId: dz,
          nodeId: NodeId.make("n1"),
          resultTag: ResultTag.make("other"),
          status: "pending",
          attempts: 0,
          result: null,
          error: null,
        });
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.runTickOnce;
        assert.equal(state.rows[0]!.status, "error");
        assert.equal(state.rows[0]!.error, "no configured prompt");
      }),
    ),
  );

  it.effect("contains a tick defect — never throws", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        const deps = {
          ...makeDeps(state, scriptedAcp("OUT")),
          listNodeIds: () => Effect.die("kaboom"),
        };
        const processor = yield* makeProcessor(deps, { config });
        const proof: Effect.Effect<void> = processor.runTickOnce;
        yield* proof;
        assert.ok(true);
      }),
    ),
  );
});

describe("makeProcessor — lifecycle", () => {
  it.effect("notify drives a tick that processes pending work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.notify;
        yield* settle(() => allDone(state, 1));
        assert.isTrue(allDone(state, 1));
      }),
    ),
  );

  it.effect("start recovers interrupted work (processing→pending, attempts kept)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        state.rows.push({
          id: "r0",
          designerId: dz,
          nodeId: NodeId.make("n1"),
          resultTag: html,
          status: "processing",
          attempts: 1,
          result: null,
          error: null,
        });
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.start;
        assert.equal(state.rows[0]!.status, "pending");
        assert.equal(state.rows[0]!.attempts, 1);
      }),
    ),
  );

  it.effect("stop is safe before start and interrupts the timer after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        const processor = yield* makeProcessor(makeDeps(state, scriptedAcp("OUT")), { config });
        yield* processor.stop;
        yield* processor.start;
        yield* processor.stop;
        assert.ok(true);
      }),
    ),
  );

  it.effect("serializes ticks: a re-run picks up work added mid-tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        addNode(state, dz, node("n1"));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let first = true;
        const acp: AcpRunnerShape = {
          run: () =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return { text: "OUT", stopReason: "end_turn" };
            }),
        };
        const processor = yield* makeProcessor(makeDeps(state, acp), { config });
        yield* processor.notify;
        yield* Deferred.await(entered);
        yield* processor.notify;
        addNode(state, dz, node("n2"));
        yield* Deferred.succeed(release, undefined);
        yield* settle(() => allDone(state, 2));
        assert.isTrue(allDone(state, 2));
      }),
    ),
  );
});
