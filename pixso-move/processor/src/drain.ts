import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { extractText } from "./extract.ts";
import { buildPrompt } from "./prompt.ts";
import type { ClaimedJob, ProcessorDeps } from "./types.ts";

// Run one claimed job to completion. This is the single contained unit: ANY failure or
// defect (ACP error, missing node became invalid, store defect) is logged and written as an
// `error` row — it never escapes, so the drain loop and the process keep going.
export const runOneJob = (deps: ProcessorDeps, job: ClaimedJob, promptText: string) =>
  Effect.gen(function* () {
    const node = yield* deps.getForProcessing(job.nodeId);
    if (node === undefined) {
      yield* deps.fail(job.id, "node missing");
      yield* Effect.logDebug("job skipped: node missing", {
        nodeId: job.nodeId,
        resultTag: job.resultTag,
      });
      return;
    }
    const prompt = buildPrompt({
      prompt: promptText,
      rootName: node.rootName,
      nodesJson: node.nodesJson,
    });
    const response = yield* deps.acp.run({ prompt });
    yield* deps.complete(job.id, extractText(response.text).text);
    yield* Effect.logDebug("job done", {
      nodeId: job.nodeId,
      resultTag: job.resultTag,
      stopReason: response.stopReason,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("job failed", {
          nodeId: job.nodeId,
          resultTag: job.resultTag,
          cause: Cause.pretty(cause),
        });
        yield* deps.fail(job.id, Cause.pretty(cause));
      }),
    ),
  );
