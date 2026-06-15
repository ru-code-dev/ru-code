import { assert, describe, it } from "@effect/vitest";
import { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";

import { runOneJob } from "../src/drain.ts";
import type { ClaimedJob } from "../src/types.ts";
import { addNode, dyingAcp, failingAcp, makeDeps, makeState, scriptedAcp } from "./fakes.ts";

const dz = DesignerId.make("dz_a");
const node = (s: string) => NodeId.make(s);
const tag = ResultTag.make("html");

const claim = (depsClaim: Effect.Effect<ClaimedJob | undefined>) =>
  Effect.flatMap(depsClaim, (job) => {
    assert.isDefined(job);
    return Effect.succeed(job);
  });

describe("runOneJob", () => {
  it.effect("success → done row with the extracted (unwrapped) text", () =>
    Effect.gen(function* () {
      const state = makeState();
      addNode(state, dz, { nodeId: node("n1"), rootName: "Hero", nodesJson: "{}" });
      const deps = makeDeps(state, scriptedAcp("```\n<div/>\n```"));
      yield* deps.reconcile([{ designerId: dz, nodeId: node("n1"), resultTag: tag }]);
      const job = yield* claim(deps.claimNextPending);
      yield* runOneJob(deps, job, "Make HTML");
      assert.equal(state.rows[0]!.status, "done");
      assert.equal(state.rows[0]!.result, "<div/>");
    }),
  );

  it.effect("ACP failure → error row, loop can continue", () =>
    Effect.gen(function* () {
      const state = makeState();
      addNode(state, dz, { nodeId: node("n1"), rootName: "Hero", nodesJson: "{}" });
      const deps = makeDeps(state, failingAcp("model exploded"));
      yield* deps.reconcile([{ designerId: dz, nodeId: node("n1"), resultTag: tag }]);
      const job = yield* claim(deps.claimNextPending);
      yield* runOneJob(deps, job, "Make HTML");
      assert.equal(state.rows[0]!.status, "error");
      assert.match(state.rows[0]!.error ?? "", /model exploded/);
    }),
  );

  it.effect("a defect is caught → error row (never escapes)", () =>
    Effect.gen(function* () {
      const state = makeState();
      addNode(state, dz, { nodeId: node("n1"), rootName: "Hero", nodesJson: "{}" });
      const deps = makeDeps(state, dyingAcp("boom"));
      yield* deps.reconcile([{ designerId: dz, nodeId: node("n1"), resultTag: tag }]);
      const job = yield* claim(deps.claimNextPending);
      yield* runOneJob(deps, job, "Make HTML");
      assert.equal(state.rows[0]!.status, "error");
    }),
  );

  it.effect("missing node → fail('node missing')", () =>
    Effect.gen(function* () {
      const state = makeState();
      // Row exists but the node was never registered (getForProcessing → undefined).
      const deps = makeDeps(state, scriptedAcp("x"));
      yield* deps.reconcile([{ designerId: dz, nodeId: node("ghost"), resultTag: tag }]);
      const job = yield* claim(deps.claimNextPending);
      yield* runOneJob(deps, job, "Make HTML");
      assert.equal(state.rows[0]!.status, "error");
      assert.equal(state.rows[0]!.error, "node missing");
    }),
  );
});
