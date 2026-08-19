// ru-code: the `thread.context.compact` command → `thread.context-compact-requested`
// intent event mapping — the decider hop of the hidden-compaction pipeline
// (meter button → command → intent → ProviderCommandReactor → adapter). Also
// pins the requireThread guard: an unknown thread is rejected, never emitted.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-compact");
const THREAD_ID = ThreadId.make("thread-compact");

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("evt-project-create"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-project-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: PROJECT_ID,
      title: "Compact Project",
      workspaceRoot: "/tmp/project-compact",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-thread-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Compact Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "coder-model" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

it.layer(NodeServices.layer)("decider context-compact", (it) => {
  it.effect("thread.context.compact → thread.context-compact-requested for a known thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.context.compact",
          commandId: CommandId.make("cmd-compact"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.context-compact-requested",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        commandId: CommandId.make("cmd-compact"),
        payload: { threadId: THREAD_ID, createdAt: NOW },
      });
    }),
  );

  it.effect("thread.context.compact for an unknown thread is rejected (requireThread)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.context.compact",
            commandId: CommandId.make("cmd-compact-ghost"),
            threadId: ThreadId.make("thread-ghost"),
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
