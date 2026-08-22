// ru-code: client-side contracts for the "first message of a freshly
// bootstrapped thread" flow.
//
// History: this file used to carry two deliberately-failing pins reproducing
// the first-message loss (torn snapshot / attach-gap). The loss-prevention
// guarantee lives SERVER-side now — the ws subscribe path acquires the live
// event stream BEFORE reading the snapshot, and the HTTP snapshot is read in
// one SQL transaction — so torn snapshots and attach gaps cannot reach this
// store anymore. What the CLIENT still guarantees, pinned here:
//   1. the socket-fallback shape (no cache, no HTTP snapshot) renders the
//      first user message from snapshot + live events;
//   2. events REPLAYED at/below the snapshot sequence are deduped, not
//      doubled — the server-side fix intentionally over-delivers and relies
//      on this;
//   3. a cached/HTTP snapshot resumes the socket subscription with
//      `afterSequence` so the server can replay precisely.
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../../../connection/model.ts";
import * as EnvironmentSupervisor from "../../../connection/supervisor.ts";
import * as Persistence from "../../../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../../../rpc/protocol.ts";
import * as RpcSession from "../../../rpc/session.ts";
import {
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "../../../state/threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const USER_MESSAGE_ID = MessageId.make("message-user-1");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-1");
const USER_TEXT = "Первое сообщение пользователя";

// State of the thread as the projection sees it right after `thread.created`
// but BEFORE the turn.start transaction: no messages yet.
const JUST_CREATED_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Новый диалог",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  chatViewMode: null, // ru-code: thread-state chat view (extended chat)
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  // ru-code: fixture rot (A15) — OrchestrationThread grew these two fields on
  // this base; neutral values, unrelated to what this fixture exercises.
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

// The same thread AFTER the turn.start transaction: the user row is inside.
const THREAD_WITH_USER_MESSAGE: OrchestrationThread = {
  ...JUST_CREATED_THREAD,
  messages: [
    {
      id: USER_MESSAGE_ID,
      role: "user",
      text: USER_TEXT,
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:01.000Z",
    },
  ],
};

const snapshotItem = (
  thread: OrchestrationThread,
  snapshotSequence: number,
): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: { snapshotSequence, thread },
});

const userMessageSent = (sequence: number): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      eventId: EventId.make(`event-user-message-${sequence}`),
      sequence,
      occurredAt: "2026-04-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        role: "user",
        text: USER_TEXT,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T00:00:01.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
      },
    },
  }) as OrchestrationThreadStreamItem;

const turnStartRequested = (sequence: number): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      eventId: EventId.make(`event-turn-start-${sequence}`),
      sequence,
      occurredAt: "2026-04-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.turn-start-requested",
      payload: {
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        runtimeMode: "full-access",
        interactionMode: "default",
        chatViewMode: null, // ru-code: thread-state chat view (extended chat)
        createdAt: "2026-04-01T00:00:01.000Z",
      },
    },
  }) as OrchestrationThreadStreamItem;

const assistantMessageSent = (sequence: number): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      eventId: EventId.make(`event-assistant-message-${sequence}`),
      sequence,
      occurredAt: "2026-04-01T00:00:05.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        role: "assistant",
        text: "Ответ ассистента",
        attachments: [],
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-04-01T00:00:05.000Z",
        updatedAt: "2026-04-01T00:00:05.000Z",
      },
    },
  }) as OrchestrationThreadStreamItem;

const hasAssistantMessage = (state: EnvironmentThreadState): boolean =>
  Option.isSome(state.data) &&
  state.data.value.messages.some((message) => message.id === ASSISTANT_MESSAGE_ID);

const userMessageTexts = (state: EnvironmentThreadState): ReadonlyArray<string> =>
  Option.isSome(state.data)
    ? state.data.value.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    : [];

// Plain factory, NOT Effect.fn: Effect.fn scopes each invocation, which would
// tear down the state machine's forked fibers the moment the harness returns.
const makeHarness = (httpSnapshot: OrchestrationThreadDetailSnapshot | undefined) =>
  Effect.gen(function* () {
    const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
    const subscribeInputs: unknown[] = [];
    const client = {
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: unknown) => {
        subscribeInputs.push(input);
        return Stream.fromQueue(inputs);
      },
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession.RpcSession = {
      client,
      // ru-code: this base gates the thread subscribe on the session config
      // (state/threads.ts:559) — an unresolved config blocks the subscription.
      // Empty config = pre-pagination, pre-completion-marker server, which is
      // what these three fixtures model.
      initialConfig: Effect.succeed({} as never),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const sessionRef = yield* SubscriptionRef.make(Option.some(session));
    // The prepared connection is available — the cold-cache path waits for it
    // before loading the HTTP snapshot / attaching the socket subscription.
    const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    );
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session: sessionRef,
      prepared,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeed(Option.none()),
      saveShell: () => Effect.void,
      // Fresh thread: nothing cached.
      loadThread: () => Effect.succeed(Option.none()),
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeed(Option.none()),
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeed(Option.none()),
      saveVcsRefs: () => Effect.void,
      // ru-code: fixture rot (A15) — EnvironmentCacheStore grew these two
      // members on this base; no-ops, unrelated to what this fixture exercises.
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const loader = ThreadSnapshotLoader.of({
      load: () => Effect.succeed(Option.fromNullishOr(httpSnapshot)),
    });
    const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ThreadSnapshotLoader, loader),
    );
    const observed = yield* Queue.unbounded<EnvironmentThreadState>();
    yield* SubscriptionRef.changes(threadState).pipe(
      Stream.runForEach((state) => Queue.offer(observed, state)),
      Effect.forkScoped,
    );

    const awaitState = (predicate: (state: EnvironmentThreadState) => boolean) =>
      Effect.gen(function* () {
        for (;;) {
          const state = yield* Queue.take(observed);
          if (predicate(state)) return state;
        }
      });

    return { inputs, awaitState, subscribeInputs };
  });

describe("first bootstrapped message — client store contracts", () => {
  it.effect(
    "socket fallback: snapshot at thread.created + live message-sent renders the user row",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(undefined);
        yield* Queue.offer(harness.inputs, snapshotItem(JUST_CREATED_THREAD, 1));
        yield* Queue.offer(harness.inputs, userMessageSent(2));
        yield* Queue.offer(harness.inputs, turnStartRequested(3));
        yield* Queue.offer(harness.inputs, assistantMessageSent(4));

        const state = yield* harness.awaitState(hasAssistantMessage);
        expect(userMessageTexts(state)).toContain(USER_TEXT);

        // No cache and no HTTP snapshot ⇒ the subscribe carries no resume cursor.
        const subscribeInput = harness.subscribeInputs[0] as { afterSequence?: number } | undefined;
        expect(subscribeInput?.afterSequence).toBeUndefined();
      }).pipe(TestClock.withLive),
  );

  it.effect(
    "over-delivery is deduped: events replayed at/below the snapshot sequence do not double the user row",
    () =>
      Effect.gen(function* () {
        // The server-side attach-before-read fix intentionally over-delivers
        // (an event can be both inside the snapshot and in the live buffer);
        // the client's sequence guard must drop the duplicate, not double it.
        const harness = yield* makeHarness(undefined);
        yield* Queue.offer(harness.inputs, snapshotItem(THREAD_WITH_USER_MESSAGE, 3));
        yield* Queue.offer(harness.inputs, userMessageSent(2));
        yield* Queue.offer(harness.inputs, turnStartRequested(3));
        yield* Queue.offer(harness.inputs, assistantMessageSent(4));

        const state = yield* harness.awaitState(hasAssistantMessage);
        expect(userMessageTexts(state)).toEqual([USER_TEXT]);
      }).pipe(TestClock.withLive),
  );

  it.effect(
    "HTTP snapshot: the socket subscription resumes with afterSequence and live events apply on top",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          snapshotSequence: 3,
          thread: THREAD_WITH_USER_MESSAGE,
        });
        yield* Queue.offer(harness.inputs, assistantMessageSent(4));

        const state = yield* harness.awaitState(hasAssistantMessage);
        expect(userMessageTexts(state)).toEqual([USER_TEXT]);

        const subscribeInput = harness.subscribeInputs[0] as { afterSequence?: number } | undefined;
        expect(subscribeInput?.afterSequence).toBe(3);
      }).pipe(TestClock.withLive),
  );
});
