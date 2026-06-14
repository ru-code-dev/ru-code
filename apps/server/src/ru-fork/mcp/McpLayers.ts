// ru-fork: MCP layer composition, kept out of the shared runtime/server wiring
// so those files only reference one or two named layers.

import * as Layer from "effect/Layer";

import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { McpBindingRepositoryLive } from "../../persistence/Layers/ProjectionMcpBinding.ts";
import { McpCatalogRepositoryLive } from "../../persistence/Layers/ProjectionMcpCatalog.ts";
import { McpProbeCacheRepositoryLive } from "../../persistence/Layers/ProjectionMcpProbeCache.ts";
import { McpOverlayLive } from "./McpOverlay.ts";
import { McpProjectionQueryLive } from "./McpProjectionQuery.ts";
import { McpReactorLive } from "./McpReactor.ts";
import { McpRuntimeLive } from "./McpRuntime.ts";
import { McpSupervisorLive } from "./McpSupervisor.ts";

/** Catalog + binding + probe-cache repos — shared by the pipeline, snapshot query, and runtime services. */
export const McpRepositoriesLive = Layer.mergeAll(
  McpCatalogRepositoryLive,
  McpBindingRepositoryLive,
  McpProbeCacheRepositoryLive,
);

/**
 * Runtime MCP services: the supervisor (singleton instance registry), the
 * reactor that keeps it reconciled to authored state, the runtime projection of
 * its state, and the read-model query. The supervisor is provided to the reactor
 * + runtime here; the repos, engine, snapshot query, settings, and secret store
 * are consumed from / shared with the outer runtime graph.
 */
export const McpRuntimeServicesLive = Layer.mergeAll(
  McpRuntimeLive,
  McpProjectionQueryLive,
  McpReactorLive,
).pipe(
  // Overlay writer — provided to the reactor (restart-on-change) and exposed for
  // ProviderCommandReactor (spawn-time overlay). Provided before the repos /
  // secret store below so those reach it.
  Layer.provideMerge(McpOverlayLive),
  Layer.provideMerge(McpSupervisorLive),
  // Repos + secret store (memoized → the same instances the pipeline / snapshot
  // query / engine already use).
  Layer.provideMerge(McpRepositoriesLive),
  Layer.provideMerge(ServerSecretStoreLive),
);
