// ru-code: the chatViewMode thread-state SET path — the event-sourced middle the
// e2e suite used to be the only guard for. Pins the whole server hop at its exact
// seams: `thread.chat-view-mode.set` command in → `thread.chat-view-mode-set`
// event out (decider), event in → read-model thread updated (projector), and a
// thread BORN with an explicit choice via `thread.created`.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import { McpManagerSecretStoreMemory } from "../../mcp/mcpPorts.ts";
import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-chat-view");
const THREAD_ID = ThreadId.make("thread-chat-view");

const seedReadModel = (threadChatViewMode: "compact" | "detailed" | null) =>
  Effect.gen(function* () {
    const initial = createEmptyReadModel(NOW);
    const withProject = yield* projectEvent(initial, {
      sequence: 1,
      eventId: EventId.make("evt-chat-view-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-chat-view-project"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-chat-view-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Chat View Project",
        workspaceRoot: "/tmp/project-chat-view",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    return yield* projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.make("evt-chat-view-thread"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-chat-view-thread"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-chat-view-thread"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Chat View Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        chatViewMode: threadChatViewMode,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
  });

const decideChatViewModeSet = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly chatViewMode: "compact" | "detailed";
  readonly threadId?: ThreadId;
}) =>
  Effect.gen(function* () {
    const planned = yield* decideOrchestrationCommand({
      command: {
        type: "thread.chat-view-mode.set",
        commandId: CommandId.make("cmd-chat-view-under-test"),
        threadId: input.threadId ?? THREAD_ID,
        chatViewMode: input.chatViewMode,
        createdAt: NOW,
      },
      readModel: input.readModel,
    });
    const events: OrchestrationEvent[] = Array.isArray(planned) ? planned : [planned];
    expect(events).toHaveLength(1);
    return events[0]!;
  });

it.layer(Layer.mergeAll(NodeServices.layer, McpManagerSecretStoreMemory))(
  "chatViewMode thread-state vertical",
  (it) => {
    it.effect("decider: the set command emits thread.chat-view-mode-set with the choice", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(null);
        const event = yield* decideChatViewModeSet({ readModel, chatViewMode: "detailed" });

        expect(event.type).toBe("thread.chat-view-mode-set");
        expect(event.aggregateKind).toBe("thread");
        expect(event.aggregateId).toBe(THREAD_ID);
        const payload = event.payload as {
          threadId: ThreadId;
          chatViewMode: string;
          updatedAt: string;
        };
        expect(payload.threadId).toBe(THREAD_ID);
        expect(payload.chatViewMode).toBe("detailed");
        // The decider stamps its own clock — the payload timestamp is the event's.
        expect(payload.updatedAt).toBe(event.occurredAt);
      }),
    );

    it.effect("decider: rejects a set for an unknown thread", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(null);
        const exit = yield* Effect.exit(
          decideChatViewModeSet({
            readModel,
            chatViewMode: "detailed",
            threadId: ThreadId.make("thread-missing"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.effect("projector: applying the event pins the choice on the read-model thread", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(null);
        const event = yield* decideChatViewModeSet({ readModel, chatViewMode: "detailed" });

        const projected = yield* projectEvent(readModel, { ...event, sequence: 3 });
        const thread = projected.threads.find((candidate) => candidate.id === THREAD_ID);
        expect(thread?.chatViewMode).toBe("detailed");
        expect(thread?.updatedAt).toBe((event.payload as { updatedAt: string }).updatedAt);

        // And back: an explicit return to compact is a real value, not null.
        const backEvent = yield* decideChatViewModeSet({
          readModel: projected,
          chatViewMode: "compact",
        });
        const projectedBack = yield* projectEvent(projected, { ...backEvent, sequence: 4 });
        expect(
          projectedBack.threads.find((candidate) => candidate.id === THREAD_ID)?.chatViewMode,
        ).toBe("compact");
      }),
    );

    it.effect("projector: thread.created carries an explicit choice from birth", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel("detailed");
        expect(
          readModel.threads.find((candidate) => candidate.id === THREAD_ID)?.chatViewMode,
        ).toBe("detailed");
      }),
    );
  },
);
