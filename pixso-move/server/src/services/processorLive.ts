import { AcpRunner, makeProcessor, Processor, processorConfig } from "@pixso-move/processor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NodeStore } from "./nodeStore.ts";
import { ResultStore } from "./resultStore.ts";

// Compose the processor into the server runtime. Its `ProcessorDeps` are built from the
// task-3 stores plus the ACP runner; SQL stays solely in the stores. The processor is
// started (recover + arm the poll timer) when the layer is acquired and stopped when it is
// released (scoped), so it shares one process, one sqlite connection, and one logger.
export const ProcessorLive = Layer.effect(
  Processor,
  Effect.gen(function* () {
    const nodeStore = yield* NodeStore;
    const resultStore = yield* ResultStore;
    const acp = yield* AcpRunner;
    const processor = yield* makeProcessor(
      {
        listNodeIds: nodeStore.listNodeIds,
        getForProcessing: nodeStore.getForProcessing,
        reconcile: resultStore.reconcile,
        claimNextPending: resultStore.claimNextPending,
        complete: resultStore.complete,
        fail: resultStore.fail,
        recoverInFlight: resultStore.recoverInFlight,
        acp,
      },
      { config: processorConfig },
    );
    yield* processor.start;
    yield* Effect.addFinalizer(() => processor.stop);
    return processor;
  }),
);
