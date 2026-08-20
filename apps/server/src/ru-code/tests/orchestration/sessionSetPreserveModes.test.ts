// ru-code: preserve-modes seam on `thread.session.set` (acp-pool feedback race
// fix). A session write whose lastError/activeTurnId were merely carried over
// from the dispatcher's stale read declares them "preserve"; the DECIDER — the
// single serialized writer — re-resolves those fields against the CURRENT read
// model, so a concurrent writer (the reactor's start-failure banner) can never
// be clobbered by a read-modify-write. These tests pin the seam at its exact
// hop: command in → fully-resolved `thread.session-set` event out.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import { McpManagerSecretStoreMemory } from "../../mcp/mcpPorts.ts";
import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-preserve");
const THREAD_ID = ThreadId.make("thread-preserve");
const TURN_ID = TurnId.make("turn-preserve-1");

const baseSession = (overrides: Partial<OrchestrationSession>): OrchestrationSession => ({
  threadId: THREAD_ID,
  status: "ready",
  providerName: "qwen",
  providerInstanceId: ProviderInstanceId.make("qwen"),
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});

// Seed project + thread, then optionally a CURRENT session via the same
// command hop under test (no preserve flags — plain set).
const seedReadModel = (currentSession: OrchestrationSession | null) =>
  Effect.gen(function* () {
    const initial = createEmptyReadModel(NOW);
    const withProject = yield* projectEvent(initial, {
      sequence: 1,
      eventId: EventId.make("evt-preserve-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-preserve-project"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-preserve-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Preserve Project",
        workspaceRoot: "/tmp/project-preserve",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    let readModel = yield* projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.make("evt-preserve-thread"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-preserve-thread"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-preserve-thread"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Preserve Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    if (currentSession !== null) {
      readModel = yield* projectEvent(readModel, {
        sequence: 3,
        eventId: EventId.make("evt-preserve-session-seed"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.session-set",
        occurredAt: NOW,
        commandId: CommandId.make("cmd-preserve-session-seed"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-preserve-session-seed"),
        metadata: {},
        payload: { threadId: THREAD_ID, session: currentSession },
      });
    }
    return readModel;
  });

const decideSessionSet = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly session: OrchestrationSession;
  readonly preserveLastError?: boolean;
  readonly preserveActiveTurnId?: boolean;
}) =>
  Effect.gen(function* () {
    const planned = yield* decideOrchestrationCommand({
      command: {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-preserve-under-test"),
        threadId: THREAD_ID,
        session: input.session,
        ...(input.preserveLastError !== undefined
          ? { preserveLastError: input.preserveLastError }
          : {}),
        ...(input.preserveActiveTurnId !== undefined
          ? { preserveActiveTurnId: input.preserveActiveTurnId }
          : {}),
        createdAt: NOW,
      },
      readModel: input.readModel,
    });
    const events: OrchestrationEvent[] = Array.isArray(planned) ? planned : [planned];
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("thread.session-set");
    return (event.payload as { session: OrchestrationSession }).session;
  });

it.layer(Layer.mergeAll(NodeServices.layer, McpManagerSecretStoreMemory))(
  "thread.session.set preserve modes",
  (it) => {
    it.effect("preserveLastError keeps the CURRENT banner over the command's stale null", () =>
      Effect.gen(function* () {
        // The exact B3 shape: the reactor wrote a classified banner; a stale
        // "starting" write (lastError computed from an older read) arrives.
        const readModel = yield* seedReadModel(
          baseSession({ lastError: "Could not start the CLI process." }),
        );
        const resolved = yield* decideSessionSet({
          readModel,
          session: baseSession({ status: "starting", lastError: null }),
          preserveLastError: true,
        });
        expect(resolved.lastError).toBe("Could not start the CLI process.");
        expect(resolved.status).toBe("starting"); // status is the event's payload — always applied
      }),
    );

    it.effect("preserveActiveTurnId keeps the CURRENT turn over the command's stale value", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(
          baseSession({ status: "running", activeTurnId: TURN_ID }),
        );
        const resolved = yield* decideSessionSet({
          readModel,
          session: baseSession({ status: "running", activeTurnId: null }),
          preserveActiveTurnId: true,
        });
        expect(resolved.activeTurnId).toBe(TURN_ID);
      }),
    );

    it.effect(
      "preserve keeps a CURRENT null too — it means don't-touch, not only don't-clear",
      () =>
        Effect.gen(function* () {
          const readModel = yield* seedReadModel(baseSession({ lastError: null }));
          const resolved = yield* decideSessionSet({
            readModel,
            session: baseSession({ status: "starting", lastError: "stale text from old read" }),
            preserveLastError: true,
          });
          expect(resolved.lastError).toBeNull();
        }),
    );

    it.effect("without flags the command's values win — byte-identical old semantics", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(
          baseSession({ lastError: "current banner", activeTurnId: TURN_ID }),
        );
        const resolved = yield* decideSessionSet({
          readModel,
          session: baseSession({ status: "ready", lastError: null, activeTurnId: null }),
        });
        expect(resolved.lastError).toBeNull();
        expect(resolved.activeTurnId).toBeNull();
      }),
    );

    it.effect("with NO current session the command's own values stand", () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel(null);
        const resolved = yield* decideSessionSet({
          readModel,
          session: baseSession({ status: "starting", lastError: "from command" }),
          preserveLastError: true,
          preserveActiveTurnId: true,
        });
        expect(resolved.lastError).toBe("from command");
        expect(resolved.activeTurnId).toBeNull();
      }),
    );

    it.effect(
      "preserveActiveTurnId keeps a CURRENT null over the command's stale turn (reactor already cleared it)",
      () =>
        Effect.gen(function* () {
          // The reactor cleared activeTurnId (turn-start failure); a stale
          // lifecycle write still carries the old turn id. Preserve resolves to
          // the CURRENT null — the dead turn must not be resurrected.
          const readModel = yield* seedReadModel(baseSession({ activeTurnId: null }));
          const resolved = yield* decideSessionSet({
            readModel,
            session: baseSession({ status: "running", activeTurnId: TURN_ID }),
            preserveActiveTurnId: true,
          });
          expect(resolved.activeTurnId).toBeNull();
        }),
    );

    it.effect(
      "mixed snapshot is pinned: preserved activeTurnId can ride a stale-derived status, then self-corrects",
      () =>
        Effect.gen(function* () {
          // status is the event's own payload — it is NEVER preserve-resolved —
          // while activeTurnId resolves against the CURRENT session. A write
          // whose status was derived from an older read can therefore land as
          // a transient status/activeTurnId mix. This is deliberate: the
          // activeTurnId is strictly FRESHER than the command's stale value,
          // and the very next lifecycle write restores consistency.
          const readModel = yield* seedReadModel(
            baseSession({ status: "running", activeTurnId: TURN_ID }),
          );
          const mixed = yield* decideSessionSet({
            readModel,
            // A session.started-shaped write from an older read: no turn seen
            // yet ⇒ status "ready", activeTurnId null.
            session: baseSession({ status: "ready", activeTurnId: null }),
            preserveActiveTurnId: true,
          });
          expect(mixed.status).toBe("ready");
          expect(mixed.activeTurnId).toBe(TURN_ID);

          // Self-correction: the next turn-lifecycle write (turn.started ⇒
          // running + its turn id, no preserve on activeTurnId) is applied
          // as-is on top of the mixed row.
          const mixedReadModel = yield* seedReadModel(
            baseSession({ status: "ready", activeTurnId: TURN_ID }),
          );
          const corrected = yield* decideSessionSet({
            readModel: mixedReadModel,
            session: baseSession({ status: "running", activeTurnId: TURN_ID }),
          });
          expect(corrected.status).toBe("running");
          expect(corrected.activeTurnId).toBe(TURN_ID);
        }),
    );
  },
);
