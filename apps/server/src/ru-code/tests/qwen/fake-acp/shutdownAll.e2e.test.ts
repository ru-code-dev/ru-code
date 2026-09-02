// ru-code: coordinated-shutdown coverage (acp-process-pool §2.5 / §4.2
// shutdownAll) over the REAL QwenAdapter + fake ACP agent. One session
// mid-turn, one idle session, two parked warm spares → stopAll():
//   - the idle session and the warm spares are killed instantly (no cancel);
//   - the mid-turn session gets `session/cancel`, its turn settles cancelled,
//     and its child is SIGKILLed after ONE shared grace;
//   - when stopAll returns, every child is dead, every session gone, both
//     threads emitted session.exited, and the pid journal is empty.
// Plus: a stopAll racing a concurrent single stop settles each session
// EXACTLY once (no duplicate session.exited / turn.completed).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PREWARM_GENERIC_INSTANCES } from "@ru-code/qwen/constants";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollForSpawns, pollUntil, pollUntilEffect } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const ACTIVE_THREAD = ThreadId.make("qwen-shutdown-active-thread");
const IDLE_THREAD = ThreadId.make("qwen-shutdown-idle-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-shutdown-all-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const PREWARM = PREWARM_GENERIC_INSTANCES;
// ru-code (chained refill): tiny chain gap so the pool reaches its target fast.
const REFILL_DELAY_MS = 50;

// A LOCAL reader schema — pins the journal's on-disk shape independently of
// the implementation's encoder.
const readJournalFile = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ kind: Schema.String }))),
);

it.effect("stopAll: idle+slot killed instantly, active turn cancelled, journal drained", () => {
  let spawnCount = 0;
  let killCount = 0;
  let cancelCount = 0;
  const script: FakeAcpScript = {
    onCancel: () => {
      cancelCount += 1;
    },
    // Parked prompt for the active thread (resolves only on cancel); the idle
    // thread never sends a turn.
    onPrompt: (steps) => steps.emitText("working..."),
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
    });
    const events: ProviderRuntimeEvent[] = [];
    const streaming = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "content.delta" && event.payload.delta.includes("working")
            ? Deferred.succeed(streaming, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    // The boot chain fills the generic pool one process at a time.
    yield* pollForSpawns(() => spawnCount, PREWARM, "boot chain reached the generic target");
    // Active session (takes a boot spare, schedules one refill) …
    yield* adapter.startSession({
      threadId: ACTIVE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    // … idle session (takes the refilled slot, refills once more) …
    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    // ru-code (warm engine v2.1): boot spares; each start takes one and the
    // CHAIN refills one — leaving 2 session children + PREWARM parked spares.
    yield* pollForSpawns(() => spawnCount, PREWARM + 2, "boot spares + one refill per start (x2)");
    assert.strictEqual(spawnCount, PREWARM + 2, "boot spares + refill per start (x2)");

    // … and a turn in flight on the active session.
    const turnFiber = yield* Effect.forkChild(
      adapter.sendTurn({ threadId: ACTIVE_THREAD, input: "do work" }),
    );
    yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

    // The journal (per-instance file) currently tracks every child.
    const journalPath = `${serverConfig.stateDir}/qwen-pids.qwen.json`;
    const readJournal = fs
      .readFileString(journalPath)
      .pipe(Effect.map(readJournalFile), Effect.orDie);
    // ru-code: a warm child's journal entry is written INSIDE the pool's
    // `makeRuntime`, i.e. STRICTLY AFTER the spawn observer `pollForSpawns`
    // watches — "every spawn observed" does not imply "every entry written".
    // That gap is this test's own synchronization point, so it is waited on
    // explicitly (bounded, dies on timeout) instead of riding the spawn
    // helper's quiet window.
    yield* pollUntilEffect(
      Effect.map(readJournal, (entries) => entries.length >= PREWARM + 2),
      "the pid journal recorded every spawned child",
    );
    const before = yield* readJournal;
    assert.lengthOf(before, PREWARM + 2, "journal tracks 2 sessions + the warm spares");
    assert.lengthOf(
      before.filter((entry) => entry.kind === "warm"),
      PREWARM,
      "exactly the parked spares are warm entries",
    );

    // ── Coordinated shutdown ─────────────────────────────────────────────
    yield* adapter.stopAll().pipe(Effect.timeout("10 seconds"));

    // Everything died within the ONE shared grace: both session children and
    // every parked spare, with exactly one session/cancel (active only).
    assert.strictEqual(killCount, PREWARM + 2, "both sessions + all warm spares were SIGKILLed");
    assert.strictEqual(cancelCount, 1, "only the mid-turn session got session/cancel");
    assert.strictEqual(yield* adapter.hasSession(ACTIVE_THREAD), false);
    assert.strictEqual(yield* adapter.hasSession(IDLE_THREAD), false);

    // The active turn settled cancelled; both threads emitted session.exited.
    yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
    yield* pollUntil(
      () =>
        events.some((e) => e.type === "turn.completed" && e.threadId === ACTIVE_THREAD) &&
        events.filter((e) => e.type === "session.exited").length >= 2,
      "active turn settled + both sessions exited",
    );
    yield* Fiber.interrupt(eventsFiber);
    const completion = events.find(
      (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
        e.type === "turn.completed" && e.threadId === ACTIVE_THREAD,
    );
    assert.strictEqual(completion!.payload.state, "cancelled");
    assert.isDefined(
      events.find((e) => e.type === "session.exited" && e.threadId === ACTIVE_THREAD),
    );
    assert.isDefined(events.find((e) => e.type === "session.exited" && e.threadId === IDLE_THREAD));

    // Every teardown was observed — the journal drained to empty.
    assert.deepStrictEqual(
      readJournalFile(yield* fs.readFileString(journalPath)),
      [],
      "journal empty after stopAll",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(script, {
          onSpawn: () => {
            spawnCount += 1;
          },
          onKill: () => {
            killCount += 1;
          },
        }),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

it.effect("stopAll racing a concurrent single stop settles the session EXACTLY once", () => {
  let cancelCount = 0;
  const script: FakeAcpScript = {
    onCancel: () => {
      cancelCount += 1;
    },
    onPrompt: (steps) => steps.emitText("working..."),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 100 });
    const events: ProviderRuntimeEvent[] = [];
    const streaming = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "content.delta" && event.payload.delta.includes("working")
            ? Deferred.succeed(streaming, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: ACTIVE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    const turnFiber = yield* Effect.forkChild(
      adapter.sendTurn({ threadId: ACTIVE_THREAD, input: "do work" }),
    );
    yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

    // BOTH teardowns at once: whichever claims `ctx.stopped` first owns the
    // settle; the other must no-op — never a double session.exited or a
    // second turn.completed.
    const stopFiber = yield* Effect.forkChild(adapter.interruptTurn(ACTIVE_THREAD));
    const stopAllFiber = yield* Effect.forkChild(adapter.stopAll());
    yield* Fiber.join(stopAllFiber).pipe(Effect.timeout("10 seconds"));
    yield* Effect.ignore(Fiber.await(stopFiber).pipe(Effect.timeout("10 seconds")));
    yield* Effect.ignore(Fiber.await(turnFiber).pipe(Effect.timeout("10 seconds")));

    yield* pollUntil(
      () =>
        events.some((event) => event.type === "session.exited" && event.threadId === ACTIVE_THREAD),
      "the racing teardowns settled the session",
    );
    yield* Fiber.interrupt(eventsFiber);

    assert.lengthOf(
      events.filter((event) => event.type === "session.exited" && event.threadId === ACTIVE_THREAD),
      1,
      "EXACTLY one session.exited despite two racing teardowns",
    );
    assert.lengthOf(
      events.filter((event) => event.type === "turn.completed" && event.threadId === ACTIVE_THREAD),
      1,
      "EXACTLY one turn completion",
    );
    assert.isAtMost(cancelCount, 1, "at most one session/cancel reached the child");
    assert.strictEqual(yield* adapter.hasSession(ACTIVE_THREAD), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});

// ── T18 — stopAll while a chain refill is still PENDING ──────────────────────

it.effect(
  "T18 stopAll with a refill still pending: journal drains and nothing spawns after",
  () => {
    let spawnCount = 0;
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
      // A chain gap far longer than the test: after the start's successful bind
      // the refill is ARMED and is still pending when stopAll lands.
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
      });
      assert.strictEqual(spawnCount, 0, "eager=0: no boot spares");

      yield* adapter.startSession({
        threadId: IDLE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(spawnCount, 1, "one cold spawn; the refill is only SCHEDULED");

      yield* adapter.stopAll().pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(yield* adapter.hasSession(IDLE_THREAD), false);
      const journalPath = `${serverConfig.stateDir}/qwen-pids.qwen.json`;
      assert.deepStrictEqual(
        readJournalFile(yield* fs.readFileString(journalPath)),
        [],
        "journal empty after stopAll",
      );
      // The drain cancelled the pending chain link: a real window (the honest way
      // to assert an absence) shows nothing respawning behind the shutdown.
      yield* Effect.sleep("300 millis");
      assert.strictEqual(spawnCount, 1, "a drained pool never spawns behind the shutdown");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);
