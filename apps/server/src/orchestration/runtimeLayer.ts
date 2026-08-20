import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
// ru-code: the decider's mcp.* branches consume the MCP secret-store port. The host
// secret store is provided here (self-contained, like the rest of the engine graph);
// its remaining requirements (ServerConfig / FileSystem / Path / Crypto) stay ambient.
import { mcpSecretStoreLayer } from "../ru-code/mcp/mcpPorts.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  // Shared background-liveness and plan-progress registries: written by
  // runtime ingestion, read by the snapshot query. provideMerge feeds the
  // same instance to the snapshot query here and re-exports it for runtime
  // ingestion.
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    // ru-code: MCP secret-store port for the decider's mcp.* branches (host store inside,
    // so consumers like the offline project CLI stay unaware of it).
    Layer.provide(mcpSecretStoreLayer.pipe(Layer.provide(ServerSecretStore.layer))),
  ),
);
