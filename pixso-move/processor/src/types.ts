import type { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A configured processing rule: a designer whose stored nodes get `prompt` run through
// the LLM, with the output stored under `resultTag`. The designer id / prompt / tag are the
// ONLY hardcoded values (see config.ts); CLI path + auth come from the server config/env.
export interface ConfigEntry {
  readonly designerId: DesignerId;
  readonly prompt: string;
  readonly resultTag: ResultTag;
}
export type ProcessorConfig = ReadonlyArray<ConfigEntry>;

// A pending job claimed for processing (mirrors the server's ResultStore.ClaimedJob).
export interface ClaimedJob {
  readonly id: string;
  readonly designerId: DesignerId;
  readonly nodeId: NodeId;
  readonly resultTag: ResultTag;
}

// A reconcile row: one (node × configured tag) to ensure a result row exists for.
export interface ReconcileRow {
  readonly designerId: DesignerId;
  readonly nodeId: NodeId;
  readonly resultTag: ResultTag;
}

// The node payload the processor builds a prompt from.
export interface NodeForProcessing {
  readonly nodeId: NodeId;
  readonly rootName: string;
  readonly nodesJson: string;
}

// Failure of a single ACP run, mapped from effect-acp's AcpError. Stored as the error text.
export class AcpRunError extends Schema.TaggedErrorClass<AcpRunError>()("AcpRunError", {
  message: Schema.String,
}) {}

// The narrow ACP seam: run one prompt, get text + stopReason. Isolates all effect-acp detail
// so the engine is testable with a scripted fake.
export interface AcpRunnerShape {
  readonly run: (input: {
    readonly prompt: string;
  }) => Effect.Effect<{ readonly text: string; readonly stopReason: string }, AcpRunError>;
}

// Everything the engine needs, injected. The server satisfies it at embed time from its
// stores + the ACP runner — there is no SQL and no `@pixso-move/server` import here.
export interface ProcessorDeps {
  readonly listNodeIds: (designerId: DesignerId) => Effect.Effect<ReadonlyArray<NodeId>>;
  readonly getForProcessing: (
    nodeId: NodeId,
  ) => Effect.Effect<NodeForProcessing | undefined>;
  readonly reconcile: (rows: ReadonlyArray<ReconcileRow>) => Effect.Effect<number>;
  readonly claimNextPending: Effect.Effect<ClaimedJob | undefined>;
  readonly complete: (id: string, result: string) => Effect.Effect<void>;
  readonly fail: (id: string, error: string) => Effect.Effect<void>;
  readonly recoverInFlight: Effect.Effect<number>;
  readonly acp: AcpRunnerShape;
}

export interface ProcessorOptions {
  readonly config: ProcessorConfig;
  readonly pollIntervalMs?: number;
}
