// ru-fork: read model for the MCP panel — catalog + bindings snapshot and an
// authored-change stream. Config rows already hold secret refs only, so no
// client-side redaction pass is needed. The change stream is low-frequency
// (admin edits), so it re-reads the full snapshot per change rather than
// tracking cascade deltas — simplest correct behaviour.

import {
  McpError,
  type McpProjectionStreamEvent,
  type McpSnapshot,
  type OrchestrationEvent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { McpBindingRepository } from "../../persistence/Services/McpBinding.ts";
import { McpCatalogRepository } from "../../persistence/Services/McpCatalog.ts";

export interface McpProjectionQueryShape {
  readonly getSnapshot: (projectId: ProjectId | null) => Effect.Effect<McpSnapshot, McpError>;
  /** Initial snapshot followed by a snapshot on every authored change. */
  readonly subscriptionStream: Stream.Stream<McpProjectionStreamEvent, McpError>;
}

export class McpProjectionQuery extends Context.Service<
  McpProjectionQuery,
  McpProjectionQueryShape
>()("@ru-code/ru-code/ru-fork/mcp/McpProjectionQuery") {}

function isProjectionRelevant(event: OrchestrationEvent): boolean {
  return event.type.startsWith("mcp.") || event.type === "project.deleted";
}

const makeMcpProjectionQuery = Effect.gen(function* () {
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const engine = yield* OrchestrationEngineService;

  const getSnapshot: McpProjectionQueryShape["getSnapshot"] = (projectId) =>
    Effect.gen(function* () {
      const catalog = yield* catalogRepository.listAll();
      const bindings =
        projectId === null
          ? yield* bindingRepository.listAll()
          : yield* bindingRepository.listByProject({ projectId });
      return { catalog, bindings } satisfies McpSnapshot;
    }).pipe(
      Effect.mapError((cause) => new McpError({ detail: "Failed to read MCP snapshot", cause })),
    );

  const changeSnapshots: Stream.Stream<McpProjectionStreamEvent, McpError> =
    engine.streamDomainEvents.pipe(
      Stream.filter(isProjectionRelevant),
      Stream.mapEffect(() =>
        getSnapshot(null).pipe(
          Effect.map((snapshot): McpProjectionStreamEvent | null => ({ type: "snapshot", snapshot })),
          // A transient snapshot read failure drops THIS update instead of ending the subscription
          // (matches McpRuntime's resilience); the next event re-reads fresh.
          Effect.catch(() => Effect.succeed(null)),
        ),
      ),
      Stream.filter((event): event is McpProjectionStreamEvent => event !== null),
    );

  const subscriptionStream: Stream.Stream<McpProjectionStreamEvent, McpError> = Stream.concat(
    Stream.fromEffect(getSnapshot(null)).pipe(
      Stream.map((snapshot): McpProjectionStreamEvent => ({ type: "snapshot", snapshot })),
    ),
    changeSnapshots,
  );

  return { getSnapshot, subscriptionStream } satisfies McpProjectionQueryShape;
});

export const McpProjectionQueryLive = Layer.effect(McpProjectionQuery, makeMcpProjectionQuery);
