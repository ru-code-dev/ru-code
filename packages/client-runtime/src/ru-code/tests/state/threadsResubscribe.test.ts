// ru-code: pins the RE-SUBSCRIBE contract after the reconnect-loop fixes
// (boot-performance.md S2 live cursor + S3 capped backoff; defect history in
// production-error.md §5).
//
//   S2 — the subscribe input is an EFFECT re-evaluated per (re)subscribe: each
//        reconnect resumes from the last APPLIED sequence, so progress
//        accumulates and any loop self-drains. (Before: the cursor was captured
//        once at page load and replayed verbatim forever.)
//   S3 — expected-failure resubscribes back off exponentially to a cap.
//        (Before: a deleted thread was re-requested every 250 ms, forever.)
import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../../../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../../../connection/model.ts";
import * as EnvironmentSupervisor from "../../../connection/supervisor.ts";
import * as Persistence from "../../../platform/persistence.ts";
import * as RpcSession from "../../../rpc/session.ts";
import { makeEnvironmentThreadState, ThreadSnapshotLoader } from "../../../state/threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  chatViewMode: null,
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  settledOverride: null,
  settledAt: null,
};

interface SubscribeInput {
  readonly threadId: ThreadId;
  readonly afterSequence?: number;
}

const titleEvent = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title: `Title ${sequence}`,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

/**
 * Harness: every subscribe records its input and reads items from a fresh
 * queue; `emit` feeds the CURRENT subscription; `reconnect` swaps the session
 * (what a transport reconnect does); `failNotFound` makes every subscribe fail
 * the way the server fails a missing thread.
 */
const makeHarness = Effect.fn("threadsResubscribe.makeHarness")(function* (options?: {
  readonly failNotFound?: boolean;
  readonly withBaseSnapshot?: boolean;
}) {
  const subscribeInputs = yield* Queue.unbounded<SubscribeInput>();
  const attempts = yield* Ref.make(0);
  const currentItems = yield* Ref.make<Queue.Queue<OrchestrationThreadStreamItem> | null>(null);
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: SubscribeInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Ref.update(attempts, (count) => count + 1);
          yield* Queue.offer(subscribeInputs, input);
          if (options?.failNotFound === true) {
            return Stream.fail(
              new OrchestrationGetSnapshotError({
                message: `Thread ${THREAD_ID} was not found`,
                cause: THREAD_ID,
              }),
            );
          }
          const items = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
          yield* Ref.set(currentItems, items);
          return Stream.fromQueue(items);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session = (): RpcSession.RpcSession => ({
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: false,
      threadSnapshotPagination: false,
    } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(session()),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: () =>
      Effect.succeed(
        options?.withBaseSnapshot === true
          ? Option.some<OrchestrationThreadDetailSnapshot>({
              snapshotSequence: 5,
              thread: BASE_THREAD,
            })
          : Option.none<OrchestrationThreadDetailSnapshot>(),
      ),
  });
  yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
  );

  return {
    subscribeInputs,
    attempts,
    emit: (item: OrchestrationThreadStreamItem) =>
      Ref.get(currentItems).pipe(
        Effect.flatMap((items) =>
          items === null ? Effect.die("no live subscription") : Queue.offer(items, item),
        ),
      ),
    reconnect: SubscriptionRef.set(supervisorSession, Option.some(session())),
  };
});

describe("re-subscribe contract (S2 live cursor + S3 capped backoff)", () => {
  it.effect("S2: a reconnect resumes from the last APPLIED sequence, not the initial one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ withBaseSnapshot: true });

      const first = yield* Queue.take(harness.subscribeInputs);
      expect(first.afterSequence).toBe(5);

      // Live events advance the applied cursor…
      yield* harness.emit(titleEvent(6));
      yield* harness.emit(titleEvent(9));
      yield* TestClock.adjust("1 millis");

      // …and the NEXT subscribe carries the advanced cursor: the replay window
      // strictly shrinks — the property that makes reconnect loops self-drain.
      yield* harness.reconnect;
      const second = yield* Queue.take(harness.subscribeInputs);
      expect(second.afterSequence).toBe(9);
    }),
  );

  it.effect("S2: cold with no progress still subscribes bare (initial semantics preserved)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* Queue.take(harness.subscribeInputs);
      expect(first.afterSequence).toBeUndefined();

      yield* harness.reconnect;
      const second = yield* Queue.take(harness.subscribeInputs);
      expect(second.afterSequence).toBeUndefined();
    }),
  );

  it.effect("S3: not-found resubscribes back off to the cap instead of hammering at 4/s", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failNotFound: true });

      // First attempt fires immediately.
      yield* Queue.take(harness.subscribeInputs);

      // 60 virtual seconds. Old behavior: ~241 attempts (250 ms fixed). New:
      // 250ms·2^n capped at 30 s ⇒ delays 0.25+0.5+1+2+4+8+16+30… ≈ 9-10
      // attempts. Bounds are generous so scheduler details can't flake this.
      for (let tick = 0; tick < 240; tick++) {
        yield* TestClock.adjust("250 millis");
      }
      const attempts = yield* Ref.get(harness.attempts);
      expect(attempts).toBeGreaterThanOrEqual(4);
      expect(attempts).toBeLessThanOrEqual(14);
    }),
  );

  it.effect("S3: the retry chain keeps running at the cap (bounded, never stopped)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failNotFound: true });
      yield* Queue.take(harness.subscribeInputs);
      for (let tick = 0; tick < 240; tick++) {
        yield* TestClock.adjust("250 millis");
      }
      const afterFirstMinute = yield* Ref.get(harness.attempts);
      // Another virtual minute at the 30 s cap ⇒ exactly ~2 more attempts.
      for (let tick = 0; tick < 240; tick++) {
        yield* TestClock.adjust("250 millis");
      }
      const afterSecondMinute = yield* Ref.get(harness.attempts);
      expect(afterSecondMinute - afterFirstMinute).toBeGreaterThanOrEqual(1);
      expect(afterSecondMinute - afterFirstMinute).toBeLessThanOrEqual(3);
    }),
  );
});
