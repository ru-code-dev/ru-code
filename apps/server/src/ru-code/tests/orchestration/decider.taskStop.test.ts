// ru-code (agentic-flow wave, P3e): the `thread.task.stop` command →
// `thread.task-stop-requested` intent event mapping — the decider hop of the
// per-row background-agent stop (panel button → command → intent →
// ProviderCommandReactor → ProviderService → adapter →
// `qwen/control/session/task/cancel`).
//
// Also pins the two things the decider is responsible for and nothing else:
// the requireThread guard (an unknown thread is rejected, never emitted) and
// that `taskId` is carried through verbatim — it is qwen's own immutable agent
// id, and a decider that reshaped it would break the join between the button,
// the poll snapshot and the row.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
// ru-code: memory MCP secret store for the decider context.
import { McpManagerSecretStoreMemory } from "../../mcp/mcpPorts.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
/** qwen's own id shape: `<subagentType>-<launch toolCallId>` (agent.ts:2839-2842). */
const TASK_ID = "general-purpose-call-bg-1";
const PROJECT_ID = ProjectId.make("project-task-stop");
const THREAD_ID = ThreadId.make("thread-task-stop");

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
      title: "Task Stop Project",
      workspaceRoot: "/tmp/project-task-stop",
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
      title: "Task Stop Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "coder-model" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      chatViewMode: null, // ru-code: thread-state chat view (extended chat)
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

// ru-code: the decider now carries the MCP secret-store port in its context.
it.layer(Layer.mergeAll(NodeServices.layer, McpManagerSecretStoreMemory))(
  "decider task-stop",
  (it) => {
    it.effect("thread.task.stop → thread.task-stop-requested for a known thread", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel;
        const planned = yield* decideOrchestrationCommand({
          command: {
            type: "thread.task.stop",
            commandId: CommandId.make("cmd-task-stop"),
            threadId: THREAD_ID,
            taskId: TASK_ID,
            createdAt: NOW,
          },
          readModel,
        });
        const events = Array.isArray(planned) ? planned : [planned];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.task-stop-requested",
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          commandId: CommandId.make("cmd-task-stop"),
          payload: { threadId: THREAD_ID, taskId: TASK_ID, createdAt: NOW },
        });
      }),
    );

    it.effect("thread.task.stop for an unknown thread is rejected (requireThread)", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel;
        const exit = yield* Effect.exit(
          decideOrchestrationCommand({
            command: {
              type: "thread.task.stop",
              commandId: CommandId.make("cmd-task-stop-ghost"),
              threadId: ThreadId.make("thread-ghost"),
              taskId: TASK_ID,
              createdAt: NOW,
            },
            readModel,
          }),
        );
        expect(exit._tag).toBe("Failure");
      }),
    );
  },
);
