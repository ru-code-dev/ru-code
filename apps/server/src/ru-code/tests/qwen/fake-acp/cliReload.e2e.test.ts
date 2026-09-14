// ru-code (cli-reload): the reload engine over the REAL QwenAdapter + REAL text generation and
// the fake CLI children. A fork of shutdownAll.e2e.test.ts — same harness, same oracles (the
// spawner's onSpawn/onKill observers and the per-instance pid-journal FILE) — extended with
// the things `stopAll` alone never covered:
//
//   · D1  the kill pass reaches text-generation children too (research A-G3), the sweep runs
//         exactly once, and a later start works;
//   · C-G1 a `startSession` racing the reload WAITS and leaves NO refill armed behind it;
//   · D2  the spawn gate: while `authOk` is false only ONE CLI child exists at a time, the
//         permit is returned at the `authenticate` reply, and a successful text-generation run
//         sets the flag while a failing one leaves it alone;
//   · D4  an idle reset clears the flag, and (branding flag on) removes the listed files
//         before the next child exists;
//   · R2  a second reload while one runs is a no-op that resolves with the running one.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CliReloadError,
  ModelSelection,
  ProviderInstanceId,
  QwenSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PREWARM_GENERIC_INSTANCES } from "@ru-code/qwen/constants";

import * as ServerConfig from "../../../../config.ts";
import { makeCliReloadEngineWith } from "../../../cli-reload/CliReloadService.ts";
import {
  listLiveCliChildren,
  listLiveCliChildrenUnsafe,
  registerLiveCliChild,
  resetLiveCliChildrenForTests,
} from "../../../cli-reload/liveCliChildren.ts";
import {
  hasOutstandingSpawnClients,
  markAuthOk,
  readAuthOk,
  readAuthOkUnsafe,
  resetCliSpawnSchedulerForTests,
  withAcpSpawnReservation,
  withCliSpawnPermit,
} from "../../../cli-reload/cliSpawnScheduler.ts";
import {
  listQwenInstances,
  registerQwenInstance,
  resetCliReloadRuntimeForTests,
} from "../../../cli-reload/reloadRuntime.ts";
import { withQwenTurnStartReservationUsing } from "../../../cli-reload/turnStartReservation.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { makeQwenTextGeneration } from "../../../qwen/QwenTextGeneration.ts";
import type { TextGenerationShape } from "../../../../textGeneration/TextGeneration.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import {
  cliReloadSpawnerLayer,
  makeTextGenSpawnObserver,
  textGenJsonOutput,
} from "./cliReloadHarness.ts";
import { pollForSpawns, pollUntil, pollUntilEffect } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const ACTIVE_THREAD = ThreadId.make("qwen-reload-active-thread");
const IDLE_THREAD = ThreadId.make("qwen-reload-idle-thread");
const AFTER_THREAD = ThreadId.make("qwen-reload-after-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-cli-reload-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const PREWARM = PREWARM_GENERIC_INSTANCES;
const REFILL_DELAY_MS = 50;

const readJournalFile = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ kind: Schema.String }))),
);

const TITLE_MODEL = Schema.decodeSync(ModelSelection)({ instanceId: "qwen", model: "" });

/** The REAL title generator, built over whatever spawner the test installed. */
const makeTitleGenerator = makeQwenTextGeneration("/fake/cli.js", "", decodeQwenSettings({}), {
  PATH: process.env["PATH"] ?? "",
});

const generateTitle = (textGeneration: TextGenerationShape, message: string) =>
  textGeneration.generateThreadTitle({ cwd: process.cwd(), message, modelSelection: TITLE_MODEL });

// ── D1 — the whole kill pass, including the text-generation child ────────────

it.effect(
  "reload: sessions + spares + a live text-generation child all die, sweep runs once, a later start works",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    let acpSpawns = 0;
    let acpKills = 0;
    let cancelCount = 0;
    let sweepRuns = 0;
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = {
      onCancel: () => {
        cancelCount += 1;
      },
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
      });
      const reload = yield* makeCliReloadEngineWith({
        sweep: Effect.sync(() => {
          sweepRuns += 1;
        }),
      });
      const textGeneration = yield* makeTitleGenerator;

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

      yield* pollForSpawns(() => acpSpawns, PREWARM, "boot chain reached the generic target");
      yield* adapter.startSession({
        threadId: ACTIVE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.startSession({
        threadId: IDLE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* pollForSpawns(() => acpSpawns, PREWARM + 2, "boot spares + one refill per start");
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: ACTIVE_THREAD, input: "do work" }),
      );
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

      // A title generation that is genuinely IN FLIGHT: its child is parked, so only the
      // reload's SIGKILL can end it. `authOk` is already true (the ACP binds authenticated),
      // so the gate lets it spawn immediately.
      const titleFiber = yield* Effect.forkChild(
        Effect.exit(generateTitle(textGeneration, "name this thread")),
      );
      yield* pollUntil(() => textGen.spawnCount() === 1, "the text-generation child spawned");
      assert.isTrue(textGen.children[0]!.isLive(), "the -p child is parked, not finished");

      const journalPath = `${serverConfig.stateDir}/qwen-pids.qwen.json`;
      const readJournal = fs
        .readFileString(journalPath)
        .pipe(Effect.map(readJournalFile), Effect.orDie);
      yield* pollUntilEffect(
        Effect.map(readJournal, (entries) => entries.length >= PREWARM + 2),
        "the pid journal recorded every ACP child",
      );

      // ── THE RELOAD ────────────────────────────────────────────────────────
      yield* reload.reload.pipe(Effect.timeout("10 seconds"));

      assert.strictEqual(acpKills, PREWARM + 2, "both sessions + every warm spare were SIGKILLed");
      assert.strictEqual(textGen.killCount(), 1, "the text-generation child was SIGKILLed too");
      assert.strictEqual(
        acpKills + textGen.killCount(),
        PREWARM + 3,
        "every CLI child this server owned is dead",
      );
      assert.strictEqual(cancelCount, 1, "only the mid-turn session got session/cancel");
      assert.strictEqual(sweepRuns, 1, "the sweep ran exactly once");
      assert.isFalse(textGen.children[0]!.isLive(), "no text-generation handle is left alive");
      assert.isFalse(yield* readAuthOk, "the auth flag is cleared for the next spawn");
      assert.strictEqual(yield* adapter.hasSession(ACTIVE_THREAD), false);
      assert.strictEqual(yield* adapter.hasSession(IDLE_THREAD), false);
      assert.deepStrictEqual(
        readJournalFile(yield* fs.readFileString(journalPath)),
        [],
        "journal empty after the reload",
      );

      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
      yield* pollUntil(
        () => events.filter((e) => e.type === "session.exited").length >= 2,
        "both sessions exited",
      );
      assert.isDefined(
        events.find((e) => e.type === "session.exited" && e.threadId === ACTIVE_THREAD),
      );
      assert.isDefined(
        events.find((e) => e.type === "session.exited" && e.threadId === IDLE_THREAD),
      );

      // And the server is usable again: a fresh start spawns and binds.
      const spawnsBefore = acpSpawns;
      yield* adapter.startSession({
        threadId: AFTER_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(yield* adapter.hasSession(AFTER_THREAD), true, "a new session is live");
      assert.isAbove(acpSpawns, spawnsBefore, "the new session really spawned a CLI child");
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          cliReloadSpawnerLayer(
            script,
            {
              onSpawn: () => {
                acpSpawns += 1;
              },
              onKill: () => {
                acpKills += 1;
              },
            },
            textGen,
          ),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

// ── C-G1 — nothing is armed behind the drain, and a racing start waits ───────

it.effect("reload leaves no refill armed behind the drain, and a racing start waits for it", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  let acpSpawns = 0;
  let sweepRuns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  // Set for the SECOND reload only: parks the pass so a start can race it.
  let parkSweep: Deferred.Deferred<void> | null = null;
  let sweepEntered: Deferred.Deferred<void> | null = null;
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      // A chain gap far longer than the test: an armed refill is still PENDING at the end,
      // so `pendingRefills` is a real observable and not a timing accident.
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.suspend(() => {
        sweepRuns += 1;
        const entered = sweepEntered;
        const park = parkSweep;
        return (entered === null ? Effect.void : Deferred.succeed(entered, undefined)).pipe(
          Effect.andThen(park === null ? Effect.void : Deferred.await(park)),
        );
      }),
    });

    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(acpSpawns, 1, "one cold spawn; its refill is only SCHEDULED");
    const instance = (yield* listQwenInstances)[0]!;
    const armed = yield* instance.readPool;
    assert.strictEqual(armed!.state, "active", "the successful bind made the pool ACTIVE");
    assert.strictEqual(armed!.pendingRefills, 1, "…and ARMED one chain link — the C-G1 hazard");

    // ── Reload #1: nothing racing it. The drain must leave the pool dead AND disarmed.
    yield* reload.reload.pipe(Effect.timeout("10 seconds"));
    const drained = yield* instance.readPool;
    assert.strictEqual(drained!.state, "expired", "the pool is EXPIRED after the reload");
    assert.strictEqual(drained!.pendingRefills, 0, "no chain link survived the drain");
    assert.strictEqual(drained!.total, 0, "no spare survived the drain");

    // ── Reload #2: parked, so a send can genuinely race the kill pass.
    parkSweep = yield* Deferred.make<void>();
    sweepEntered = yield* Deferred.make<void>();
    const reloadFiber = yield* Effect.forkChild(reload.reload);
    yield* Deferred.await(sweepEntered).pipe(Effect.timeout("10 seconds"));

    const spawnsAtRace = acpSpawns;
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId: AFTER_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      }),
    );
    // A real window — the honest way to assert an absence.
    yield* Effect.sleep("200 millis");
    assert.strictEqual(acpSpawns, spawnsAtRace, "the racing start spawned nothing mid-reload");
    assert.isUndefined(startFiber.pollUnsafe(), "the racing start is parked on the reload latch");

    yield* Deferred.succeed(parkSweep, undefined);
    yield* Fiber.join(reloadFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));

    assert.strictEqual(sweepRuns, 2, "two presses, two passes — they did not overlap");
    assert.strictEqual(
      yield* adapter.hasSession(AFTER_THREAD),
      true,
      "the waiting start ran after",
    );
    assert.strictEqual(acpSpawns, spawnsAtRace + 1, "exactly ONE spawn after the reload");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── D1 — a start that would take a WARM SPARE waits too ─────────────────────
//
// A start that finds a parked spare NEVER SPAWNS, so nothing downstream of the permit can
// cover it. What does is the reload wait the `acp` permit wrapper performs on its way IN:
// without it the start would take a spare the drain is about to kill and then run
// `ensureAfterSuccess` — arming a refill BEHIND the drain, which is exactly C-G1. The window is made deterministic by parking the reload inside STEP 2
// (before the drain), which is only reachable by re-registering this instance with a `stopAll`
// that waits — the registry's own public API.

it.effect("a start that would take a warm spare also waits for the reload", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  let acpSpawns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      // ONE eager spare and a chain gap far longer than the test: the pool holds exactly one
      // parked slot for the whole run, so `total` is an exact oracle and not a race.
      poolOptions: { eagerOnExpired: 1, refillDelayMs: 30_000 },
    });
    yield* pollForSpawns(() => acpSpawns, 1, "the eager prewarm parked one spare");
    const real = (yield* listQwenInstances)[0]!;
    assert.strictEqual((yield* real.readPool)!.total, 1, "the spare is parked");

    const stopEntered = yield* Deferred.make<void>();
    const releaseStop = yield* Deferred.make<void>();
    yield* Effect.sync(() => {
      resetCliReloadRuntimeForTests();
      resetCliSpawnSchedulerForTests();
    });
    yield* registerQwenInstance({
      ...real,
      stopAll: Deferred.succeed(stopEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStop)),
        Effect.andThen(real.stopAll),
      ),
    });
    const reload = yield* makeCliReloadEngineWith({ sweep: Effect.void });
    const reloadFiber = yield* Effect.forkChild(reload.reload);
    yield* Deferred.await(stopEntered).pipe(Effect.timeout("10 seconds"));

    // The pool is still FULL here — a start that did not wait would take a spare.
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId: AFTER_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      }),
    );
    yield* Effect.sleep("200 millis");
    assert.strictEqual(
      (yield* real.readPool)!.total,
      1,
      "the racing start TOOK THE SPARE mid-reload — startSession did not wait on the latch",
    );
    assert.isUndefined(startFiber.pollUnsafe(), "the racing start is parked on the reload latch");

    yield* Deferred.succeed(releaseStop, undefined);
    yield* Fiber.join(reloadFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(
      yield* adapter.hasSession(AFTER_THREAD),
      true,
      "the waiting start ran after",
    );
    assert.strictEqual((yield* real.readPool)!.total, 0, "the drain still emptied the pool");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── R2 — a second reload joins the running one ───────────────────────────────

it.effect("a second reload while one runs is a no-op that resolves with the running one", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  let sweepRuns = 0;
  const order: string[] = [];
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const sweepEntered = yield* Deferred.make<void>();
    const releaseSweep = yield* Deferred.make<void>();
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.sync(() => {
        sweepRuns += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(sweepEntered, undefined)),
        Effect.andThen(Deferred.await(releaseSweep)),
        Effect.andThen(Effect.sync(() => order.push("the running pass finished"))),
      ),
    });

    const first = yield* Effect.forkChild(
      reload.reload.pipe(Effect.andThen(Effect.sync(() => order.push("first")))),
    );
    yield* Deferred.await(sweepEntered).pipe(Effect.timeout("10 seconds"));
    const second = yield* Effect.forkChild(
      reload.reload.pipe(Effect.andThen(Effect.sync(() => order.push("second")))),
    );

    yield* Effect.sleep("200 millis");
    assert.strictEqual(sweepRuns, 1, "the second press started NO second pass");
    assert.isUndefined(second.pollUnsafe(), "the second press is still awaiting the first");

    yield* Deferred.succeed(releaseSweep, undefined);
    yield* Fiber.join(first).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(second).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(sweepRuns, 1, "still exactly one pass after both resolved");
    // The contract is "the second press returns WHEN THE RUNNING ONE FINISHES" (owner ruling
    // R2) — not an ordering between the two callers' own continuations, which is fiber
    // scheduling. So: the running pass completed FIRST, and both callers then resolved.
    assert.strictEqual(order[0], "the running pass finished");
    assert.includeMembers(order, ["first", "second"], "both presses resolved");
    assert.lengthOf(order, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
    TestClock.withLive,
  );
});

// ── D2 — the spawn gate ──────────────────────────────────────────────────────

it.effect(
  "gate: with authOk false, a second CLI spawn waits for the first authenticate reply",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    let acpSpawns = 0;
    const textGen = makeTextGenSpawnObserver();
    const authenticateReached = { hit: false };
    // Park the handshake INSIDE `authenticate`: the gate's permit is held exactly across
    // this reply, so holding it here is the only way to observe the queue behind it.
    const heldAuthenticate = Deferred.makeUnsafe<void>();
    const script: FakeAcpScript = {
      onAuthenticate: () => {
        authenticateReached.hit = true;
      },
      onAuthenticateEffect: () => Deferred.await(heldAuthenticate),
      onPrompt: (steps) => steps.respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
      });
      const textGeneration = yield* makeTitleGenerator;
      assert.isFalse(yield* readAuthOk, "the flag starts false at server start");

      // A cold session start: spawns, then parks in `authenticate` holding the permit.
      const startFiber = yield* Effect.forkChild(
        adapter.startSession({
          threadId: ACTIVE_THREAD,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );
      yield* pollUntil(() => authenticateReached.hit, "the first child reached authenticate");

      // A title generation fired NOW must not spawn: exactly one CLI child exists.
      const titleFiber = yield* Effect.forkChild(
        Effect.exit(generateTitle(textGeneration, "name this thread")),
      );
      yield* Effect.sleep("200 millis");
      assert.strictEqual(acpSpawns, 1, "only the ACP child exists");
      assert.strictEqual(textGen.spawnCount(), 0, "the gate held the text-generation spawn");

      // Release the reply → the permit is returned and the queued spawn proceeds.
      yield* Deferred.succeed(heldAuthenticate, undefined);
      yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(yield* readAuthOk, "a completed authenticate sets the flag");
      yield* pollUntil(() => textGen.spawnCount() === 1, "the queued spawn went through");
      yield* textGen.children[0]!.complete(textGenJsonOutput("A title"));
      yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          cliReloadSpawnerLayer(
            script,
            {
              onSpawn: () => {
                acpSpawns += 1;
              },
            },
            textGen,
          ),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "gate: a lone text generation spawns at once; success sets authOk, failure does not",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const textGeneration = yield* makeTitleGenerator;
      assert.isFalse(yield* readAuthOk);

      // Nothing else holds the permit, so the guarded spawn happens immediately.
      const failing = yield* Effect.forkChild(
        Effect.exit(generateTitle(textGeneration, "first attempt")),
      );
      yield* pollUntil(() => textGen.spawnCount() === 1, "the -p child spawned with no wait");
      yield* textGen.children[0]!.complete("boom", 1);
      const failed = yield* Fiber.join(failing).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(failed._tag === "Failure", "a non-zero exit is a text-generation failure");
      assert.isFalse(yield* readAuthOk, "a FAILED run says nothing about authorization");

      const succeeding = yield* Effect.forkChild(
        Effect.exit(generateTitle(textGeneration, "second attempt")),
      );
      yield* pollUntil(() => textGen.spawnCount() === 2, "the retry spawned");
      yield* textGen.children[1]!.complete(textGenJsonOutput("Generated title"));
      const ok = yield* Fiber.join(succeeding).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(ok._tag === "Success", "output without an error");
      assert.isTrue(yield* readAuthOk, "output without an error sets the flag");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
      TestClock.withLive,
    );
  },
);

// ── ADVERSARY A-1 — a spawn ALREADY parked on the permit must not spawn mid-reload ──
//
// The window the old shape missed: a client that passed the reload check on its way IN and then
// parked on the permit. When the reload's kill pass frees the permit, the old scheduler handed
// it over and a brand-new CLI child appeared BEHIND the kill — re-opening research C-G1.

it.effect("a spawn already parked on the permit does not spawn during a reload", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let acpSpawns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  let parkSweep: Deferred.Deferred<void> | null = null;
  let sweepEntered: Deferred.Deferred<void> | null = null;
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.suspend(() => {
        const entered = sweepEntered;
        const park = parkSweep;
        return (entered === null ? Effect.void : Deferred.succeed(entered, undefined)).pipe(
          Effect.andThen(park === null ? Effect.void : Deferred.await(park)),
        );
      }),
    });
    const textGeneration = yield* makeTitleGenerator;
    assert.isFalse(yield* readAuthOk, "server start: the gate is live");

    // A text generation takes the permit and parks — its `-p` child is LIVE.
    const titleFiber = yield* Effect.forkChild(
      Effect.exit(generateTitle(textGeneration, "the holder")),
    );
    yield* pollUntil(() => textGen.spawnCount() === 1, "the -p child holds the permit");

    // A session start arrives BEFORE any reload exists and parks on the PERMIT.
    const startFiber = yield* Effect.forkChild(
      Effect.exit(
        adapter.startSession({
          threadId: ACTIVE_THREAD,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      ),
    );
    yield* Effect.sleep("150 millis");
    assert.strictEqual(acpSpawns, 0, "the session start is parked on the permit");

    // THE RELOAD, parked inside its sweep so the window after the kill pass is deterministic.
    parkSweep = yield* Deferred.make<void>();
    sweepEntered = yield* Deferred.make<void>();
    const reloadFiber = yield* Effect.forkChild(reload.reload);
    yield* Deferred.await(sweepEntered).pipe(Effect.timeout("10 seconds"));

    // The kill pass is OVER (the sweep follows it) and the reload is still running. The permit
    // is free — the holder's `-p` child was just killed — and the parked start must STILL wait.
    yield* Effect.sleep("300 millis");
    assert.strictEqual(acpSpawns, 0, "a CLI child spawned BEHIND the reload's kill pass");
    assert.deepStrictEqual(
      (yield* listLiveCliChildren).map((child) => child.kind),
      [],
      "the reload left a live CLI child registered",
    );

    // The pool the kill pass left behind, read BEFORE the reload releases: dead and disarmed.
    // (After the reload the parked start proceeds and legitimately makes the pool ACTIVE again
    // — that is the whole point of it having waited.)
    const midReloadPool = yield* (yield* listQwenInstances)[0]!.readPool;
    assert.strictEqual(midReloadPool!.state, "expired", "the pool is EXPIRED during the reload");
    assert.strictEqual(midReloadPool!.pendingRefills, 0, "no chain link survived the drain (C-G1)");

    yield* Deferred.succeed(parkSweep, undefined);
    yield* Fiber.join(reloadFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(acpSpawns, 1, "the parked start ran exactly once, AFTER the reload");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── ADVERSARY A-2 — a session start still inside its ACP handshake is killed ─────────
//
// `stopAll` enumerates the adapter's `sessions` map, which a start only joins AFTER the whole
// handshake. A CLI parked in `authenticate` on a lapsed token — the exact reason a user presses
// Reload CLI — was therefore invisible to it. The live-child registry sees it: it registers at
// the SPAWN.

it.effect("a session start parked mid-handshake is killed by the reload", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let acpSpawns = 0;
  let acpKills = 0;
  const textGen = makeTextGenSpawnObserver();
  const heldAuthenticate = Deferred.makeUnsafe<void>();
  const script: FakeAcpScript = {
    onAuthenticateEffect: () => Deferred.await(heldAuthenticate),
    onPrompt: (steps) => steps.respondOk(),
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const reload = yield* makeCliReloadEngineWith({ sweep: Effect.void });

    const startFiber = yield* Effect.forkChild(
      Effect.exit(
        adapter.startSession({
          threadId: ACTIVE_THREAD,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      ),
    );
    yield* pollUntil(() => acpSpawns === 1, "the CLI child spawned");
    yield* pollUntil(
      () => listLiveCliChildrenUnsafe().length === 1,
      "the mid-handshake child is in the live registry",
    );
    assert.strictEqual(
      yield* adapter.hasSession(ACTIVE_THREAD),
      false,
      "…and is NOT in the adapter's sessions map — which is why stopAll alone cannot see it",
    );

    yield* reload.reload.pipe(Effect.timeout("10 seconds"));

    assert.strictEqual(acpKills, 1, "the mid-handshake CLI child was SIGKILLed by the reload");
    assert.deepStrictEqual(
      (yield* listLiveCliChildren).map((child) => child.kind),
      [],
      "the live registry is empty — the reload's zero-oracle",
    );
    yield* Deferred.succeed(heldAuthenticate, undefined);
    yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));

    // The pid journal is the write-only FILE mirror, and its entry rides the runtime scope, so
    // it drains only once the killed start finishes unwinding — which is why the live registry,
    // not the journal, is the reload's zero-oracle (the journal is also warm-engine-gated).
    const journalPath = `${serverConfig.stateDir}/qwen-pids.qwen.json`;
    yield* pollUntilEffect(
      Effect.map(
        fs.readFileString(journalPath).pipe(Effect.map(readJournalFile), Effect.orDie),
        (entries) => entries.length === 0,
      ),
      "the pid journal drained once the killed start unwound",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
            },
            onKill: () => {
              acpKills += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── ADVERSARY A-3 — a failed or interrupted reload still re-arms and still sweeps ────

it.effect("a reload that FAILS after the kill pass still cleared the flag and still swept", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let sweepRuns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    // The sweep runs, and then the pass FAILS — the delete step is where a real reload can
    // fail, and everything before it must still have happened.
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.sync(() => {
        sweepRuns += 1;
      }),
    });
    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.isTrue(yield* readAuthOk, "the bind authenticated");

    const outcome = yield* Effect.exit(
      reload.reload.pipe(Effect.andThen(Effect.fail(new CliReloadError()))),
    );
    assert.isTrue(outcome._tag === "Failure");
    assert.isFalse(
      yield* readAuthOk,
      "a reload whose tail failed left the gate DISARMED with every CLI dead",
    );
    assert.strictEqual(sweepRuns, 1, "the parked work was closed even though the pass failed");
    assert.strictEqual(yield* adapter.hasSession(IDLE_THREAD), false);
    assert.deepStrictEqual(
      (yield* listLiveCliChildren).map((c) => c.kind),
      [],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
    TestClock.withLive,
  );
});

it.effect("an INTERRUPTED reload request still completes the reload (it is server-owned)", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let sweepRuns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  const sweepEntered = Deferred.makeUnsafe<void>();
  const releaseSweep = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.sync(() => {
        sweepRuns += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(sweepEntered, undefined)),
        Effect.andThen(Deferred.await(releaseSweep)),
      ),
    });
    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.isTrue(yield* readAuthOk);

    // The RPC caller — a browser that then reloads its page (owner ruling R8).
    const callerFiber = yield* Effect.forkChild(reload.reload);
    yield* Deferred.await(sweepEntered).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(callerFiber);

    // The operation belongs to the SERVER, not to the request: it finishes regardless.
    yield* Deferred.succeed(releaseSweep, undefined);
    yield* pollUntilEffect(
      Effect.map(listLiveCliChildren, (children) => children.length === 0),
      "the reload finished its kill pass after the caller vanished",
    );
    assert.strictEqual(sweepRuns, 1, "the sweep ran");
    assert.isFalse(yield* readAuthOk, "the gate is re-armed");
    assert.strictEqual(yield* adapter.hasSession(IDLE_THREAD), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
    TestClock.withLive,
  );
});

// ── ADVERSARY R2-1 — a reload always ENDS with the gate armed ───────────────────────
//
// `clearAuthOk` runs once, at the start of the pass. That is only sound if nothing can set the
// flag again while the pass runs — and a `-p` run exiting 0, or an `authenticate` replying, in
// that window is the common case (a title generation in flight when the user presses Reload).

it.effect("a markAuthOk landing DURING a reload does not leave the gate disarmed", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let sweepRuns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  const sweepEntered = Deferred.makeUnsafe<void>();
  const releaseSweep = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.sync(() => {
        sweepRuns += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(sweepEntered, undefined)),
        Effect.andThen(Deferred.await(releaseSweep)),
      ),
    });
    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.isTrue(yield* readAuthOk, "the bind authenticated");

    const reloadFiber = yield* Effect.forkChild(reload.reload);
    yield* Deferred.await(sweepEntered).pipe(Effect.timeout("10 seconds"));
    assert.isFalse(yield* readAuthOk, "step 1 cleared the flag");

    // The straggler: an in-flight CLI proving the token WHILE the reload runs.
    yield* markAuthOk;
    assert.isFalse(
      yield* readAuthOk,
      "a markAuthOk during the pass re-armed nothing — the gate is disarmed mid-reload",
    );

    yield* Deferred.succeed(releaseSweep, undefined);
    yield* Fiber.join(reloadFiber).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(sweepRuns, 1);
    assert.isFalse(
      yield* readAuthOk,
      "the reload resolved with the gate DISARMED and every CLI dead",
    );
    // And the scheduler is usable again: the next spawn authenticates and sets it.
    yield* adapter.startSession({
      threadId: AFTER_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.isTrue(yield* readAuthOk, "a real post-reload bind sets it again");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
    TestClock.withLive,
  );
});

// ── ADVERSARY R2-2 — the kill pass is a FIXPOINT, not a snapshot ────────────────────
//
// A client granted the permit BEFORE the scheduler flipped to `reloading` is already past the
// gate. Its child appears inside the kill window — after a single-snapshot pass would have
// looked. The pass must repeat until nothing is alive and nothing is still granted.

it.effect(
  "a CLI child that appears after the first kill sweep is still dead when the reload resolves",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    resetLiveCliChildrenForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
      });
      // A first bind sets the auth flag, so the scheduler waves the next client straight
      // through — GRANTED, which is the state R2-2 is about.
      yield* adapter.startSession({
        threadId: IDLE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.isTrue(yield* readAuthOk);

      const granted = Deferred.makeUnsafe<void>();
      const spawnNow = Deferred.makeUnsafe<void>();
      const wasKilled = Deferred.makeUnsafe<void>();
      let killedLateChild = false;
      // A client that is past the gate BEFORE the reload flips the scheduler, and whose CLI
      // child is created later — inside the kill window. Built from the production API
      // (`withCliSpawnPermit` + `registerLiveCliChild`) so it is a real scheduler client.
      const clientFiber = yield* Effect.forkChild(
        withCliSpawnPermit(
          "acp",
          Effect.gen(function* () {
            yield* Deferred.succeed(granted, undefined);
            yield* Deferred.await(spawnNow);
            yield* registerLiveCliChild({
              pid: 424_242,
              kind: "acp",
              forceKill: Effect.suspend(() => {
                killedLateChild = true;
                return Effect.asVoid(Deferred.succeed(wasKilled, undefined));
              }),
              waitForExit: Effect.void,
            });
            yield* Deferred.await(wasKilled);
          }).pipe(Effect.scoped),
        ),
      );
      yield* Deferred.await(granted).pipe(Effect.timeout("10 seconds"));

      const killPassEntered = Deferred.makeUnsafe<void>();
      const releaseKillPass = Deferred.makeUnsafe<void>();
      const real = (yield* listQwenInstances)[0]!;
      yield* Effect.sync(() => {
        resetCliReloadRuntimeForTests();
      });
      let parkOnce = true;
      yield* registerQwenInstance({
        ...real,
        stopAll: Effect.suspend(() => {
          if (!parkOnce) return real.stopAll;
          parkOnce = false;
          return Deferred.succeed(killPassEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseKillPass)),
            Effect.andThen(real.stopAll),
          );
        }),
      });
      const reload = yield* makeCliReloadEngineWith({ sweep: Effect.void });

      const reloadFiber = yield* Effect.forkChild(reload.reload);
      yield* Deferred.await(killPassEntered).pipe(Effect.timeout("10 seconds"));
      // Let the kill pass run its FIRST sweep with the registry still empty …
      yield* Deferred.succeed(releaseKillPass, undefined);
      yield* Effect.sleep("50 millis");
      // … and only then let the granted client create its child. A single-snapshot pass has
      // already looked and finished; a fixpoint has not, because the client is still outstanding.
      yield* Deferred.succeed(spawnNow, undefined);

      yield* Fiber.join(reloadFiber).pipe(Effect.timeout("20 seconds"));

      assert.isTrue(
        killedLateChild,
        "the child created after the first sweep was never killed — the pass was a snapshot",
      );
      assert.deepStrictEqual(
        (yield* listLiveCliChildren).map((child) => child.kind),
        [],
        "a CLI child survived the reload",
      );
      assert.isFalse(
        yield* hasOutstandingSpawnClients,
        "a client is still mid-spawn after the reload",
      );
      yield* Fiber.join(clientFiber).pipe(Effect.timeout("10 seconds"));

      // The scheduler is back open and serving.
      yield* adapter.startSession({
        threadId: AFTER_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(
        yield* adapter.hasSession(AFTER_THREAD),
        true,
        "the scheduler stayed shut",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
      TestClock.withLive,
    );
  },
);

// ── THE FIXPOINT IS EVENT-DRIVEN, NOT A SPIN (adversary R3-1) ───────────────────────
//
// A granted client that has not spawned yet keeps the pass non-quiescent. Re-testing that in a
// loop re-ran the ENTIRE kill pass — every `stopAll`, the pool-mutex drain, `killAll` — at memory
// speed inside the uninterruptible unit, bounded only by that client's own ceiling. The loop must
// instead wait for one of the two owners to report a real change.
//
// The oracle is the number of kill passes: `stopAll` is called once per registered instance per
// iteration, so a counting instance counts iterations. The bound is children + holders + 1.

it.effect(
  "the kill pass waits for a change instead of spinning while a granted client has not spawned",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    resetLiveCliChildrenForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
      });
      // A first bind sets the auth flag, so the next client is waved through GRANTED.
      yield* adapter.startSession({
        threadId: IDLE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.isTrue(yield* readAuthOk);

      const granted = Deferred.makeUnsafe<void>();
      const spawnNow = Deferred.makeUnsafe<void>();
      const wasKilled = Deferred.makeUnsafe<void>();
      // A holder that is past the gate and deliberately does NOT spawn until told to.
      const clientFiber = yield* Effect.forkChild(
        withCliSpawnPermit(
          "acp",
          Effect.gen(function* () {
            yield* Deferred.succeed(granted, undefined);
            yield* Deferred.await(spawnNow);
            yield* registerLiveCliChild({
              pid: 616_161,
              kind: "acp",
              forceKill: Effect.asVoid(Deferred.succeed(wasKilled, undefined)),
              waitForExit: Effect.void,
            });
            yield* Deferred.await(wasKilled);
          }).pipe(Effect.scoped),
        ),
      );
      yield* Deferred.await(granted).pipe(Effect.timeout("10 seconds"));

      // One `stopAll` per instance per iteration — this counts kill passes.
      let passes = 0;
      const real = (yield* listQwenInstances)[0]!;
      yield* Effect.sync(() => {
        resetCliReloadRuntimeForTests();
      });
      yield* registerQwenInstance({
        ...real,
        stopAll: Effect.suspend(() => {
          passes += 1;
          return real.stopAll;
        }),
      });
      const reload = yield* makeCliReloadEngineWith({ sweep: Effect.void });
      const reloadFiber = yield* Effect.forkChild(reload.reload);

      // NOTHING changes during this window: the holder is granted and has not spawned. A spinning
      // pass burns the whole window re-killing an empty fleet; an event-driven one is asleep.
      yield* Effect.sleep("150 millis");
      assert.isAtMost(
        passes,
        1,
        `the kill pass ran ${passes} times while no quiescence state changed — it is spinning`,
      );

      // Now give it a real change, and let the pass finish.
      yield* Deferred.succeed(spawnNow, undefined);
      yield* Fiber.join(reloadFiber).pipe(Effect.timeout("20 seconds"));
      yield* Fiber.join(clientFiber).pipe(Effect.timeout("10 seconds"));

      // children (1) + holders (1) + 1.
      assert.isAtMost(passes, 3, `the kill pass ran ${passes} times for one child and one holder`);
      assert.deepStrictEqual(
        (yield* listLiveCliChildren).map((child) => child.kind),
        [],
        "a CLI child survived the reload",
      );
      assert.isFalse(
        yield* hasOutstandingSpawnClients,
        "a client is still mid-spawn after the reload",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
      TestClock.withLive,
    );
  },
);

// ── THE KILL PASS EMPTIES THE REGISTRY ITSELF — the fixpoint's PROGRESS guarantee ───
//
// `killAllLiveCliChildren` drops each entry after the kill instead of waiting for the owning
// scope to unwind. Under a single-snapshot pass that was a freshness argument. Under the
// FIXPOINT it is the termination argument: the loop re-tests the registry, so if removal were
// left to the registrant's scope, a registrant whose scope does NOT close promptly would spin
// the loop forever — inside the uninterruptible unit, where nothing can break it. The kill pass
// must therefore be the authority that the registry is empty, independent of registrant
// behaviour. This spec holds a registrant's scope open across the whole reload.

it.effect(
  "the kill pass empties the registry itself, even if the owner's scope never closes",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    resetLiveCliChildrenForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const registered = Deferred.makeUnsafe<void>();
      let killed = false;
      // A child whose owning scope is parked forever: it registers and then never unwinds, so
      // the scoped release can NEVER be what empties the registry.
      const ownerFiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* registerLiveCliChild({
            pid: 515_151,
            kind: "acp",
            forceKill: Effect.sync(() => {
              killed = true;
            }),
            waitForExit: Effect.void,
          });
          yield* Deferred.succeed(registered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      );
      yield* Deferred.await(registered).pipe(Effect.timeout("10 seconds"));
      assert.strictEqual((yield* listLiveCliChildren).length, 1, "the child never registered");

      const reload = yield* makeCliReloadEngineWith({ sweep: Effect.void });
      // The whole point: this RESOLVES. If the pass did not drop the entry, the fixpoint would
      // never reach quiescence and this join would never return.
      yield* reload.reload.pipe(Effect.timeout("20 seconds"));

      assert.isTrue(killed, "the registered child was never killed");
      assert.deepStrictEqual(
        (yield* listLiveCliChildren).map((child) => child.kind),
        [],
        "the kill pass left its own entry behind — the fixpoint had to wait on a scope close",
      );
      yield* Fiber.interrupt(ownerFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
      TestClock.withLive,
    );
  },
);

// ── SERVER SHUTDOWN MID-RELOAD — the one case the uninterruptible unit exists for ───
//
// The reload fiber lives in the SERVICE's scope. Closing that scope is server shutdown, and it
// is the only thing that can interrupt a reload in flight. The kill pass and the sweep are one
// uninterruptible unit precisely so this cannot leave the fleet half-killed with the parked
// work still open.

it.effect("server shutdown mid-reload still finishes the kill pass and the sweep", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let sweepRuns = 0;
  let acpKills = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  const killPassEntered = Deferred.makeUnsafe<void>();
  const releaseKillPass = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    // The service gets a scope of its OWN here — the test closes it to stand in for shutdown.
    const serviceScope = yield* Scope.make("sequential");
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    // A registered instance whose stopAll PARKS: that is "the reload is inside step 2".
    const real = (yield* listQwenInstances)[0]!;
    yield* Effect.sync(() => {
      resetCliReloadRuntimeForTests();
    });
    yield* registerQwenInstance({
      ...real,
      stopAll: Deferred.succeed(killPassEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseKillPass)),
        Effect.andThen(real.stopAll),
      ),
    });
    const reload = yield* makeCliReloadEngineWith({
      sweep: Effect.sync(() => {
        sweepRuns += 1;
      }),
    }).pipe(Scope.provide(serviceScope));

    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.isTrue(yield* readAuthOk);

    const callerFiber = yield* Effect.forkChild(Effect.exit(reload.reload));
    yield* Deferred.await(killPassEntered).pipe(Effect.timeout("10 seconds"));

    // SHUTDOWN, mid kill pass.
    const closing = yield* Effect.forkChild(Scope.close(serviceScope, Exit.void));
    yield* Effect.sleep("100 millis");
    yield* Deferred.succeed(releaseKillPass, undefined);
    yield* Fiber.join(closing).pipe(Effect.timeout("20 seconds"));
    yield* Fiber.join(callerFiber).pipe(Effect.timeout("20 seconds"));

    // The unit ran to the end despite the interrupt: fleet dead AND parked work closed.
    assert.strictEqual(sweepRuns, 1, "the sweep was skipped — the fleet died with work still open");
    assert.isAbove(acpKills, 0, "the kill pass did not finish");
    assert.deepStrictEqual(
      (yield* listLiveCliChildren).map((c) => c.kind),
      [],
    );
    assert.isFalse(yield* readAuthOk, "the gate is re-armed");
    // And the scheduler is not left shut: a later spawn is servable.
    yield* adapter.startSession({
      threadId: AFTER_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(yield* adapter.hasSession(AFTER_THREAD), true, "the scheduler stayed shut");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onKill: () => {
              acpKills += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── ADVERSARY A-5b — a FAILED authenticate releases the permit at the reply ──────────

it.effect("a REJECTED authenticate does not stall the queue behind it", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  resetLiveCliChildrenForTests();
  let acpSpawns = 0;
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = {
    authenticateBehavior: "error",
    onPrompt: (steps) => steps.respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      // A start ceiling far longer than this spec: if the permit were held to the END of the
      // session start, the queued text generation would wait it out instead of milliseconds.
      sessionStartTimeoutMs: 60_000,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const textGeneration = yield* makeTitleGenerator;

    const startFiber = yield* Effect.forkChild(
      Effect.exit(
        adapter.startSession({
          threadId: ACTIVE_THREAD,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      ),
    );
    yield* pollUntil(() => acpSpawns === 1, "the session child spawned holding the permit");

    const titleFiber = yield* Effect.forkChild(
      Effect.exit(generateTitle(textGeneration, "queued behind a failing auth")),
    );
    // The authenticate reply is a REJECTION. The permit comes back with it (owner ruling D2,
    // `releaseCliSpawnPermitEarly`) and, because a rejected handshake also fails the start
    // promptly, the end-of-start release covers the same window — so this asserts the
    // OBSERVABLE fact both produce: the queue behind a failed auth is not stalled. The release
    // POINT itself is not independently observable; see OPEN-I-11.
    yield* pollUntil(
      () => textGen.spawnCount() === 1,
      "the queued -p run was stalled behind a rejected authenticate",
    );
    assert.isFalse(yield* readAuthOk, "a REJECTED authenticate never sets the flag");

    yield* textGen.children[0]!.complete(textGenJsonOutput("Title"));
    yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.join(startFiber).pipe(Effect.timeout("20 seconds"));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── OWNER PRIORITY RULING — acp before textgen in the spawn scheduler ───────
//
// The three cases the owner named. They are about ORDER, so every one of them asserts the
// SPAWN SEQUENCE recorded by the spawner observers — not a flag, not a count.

it.effect(
  "priority 1: on a first send the SESSION spawns first, the title generation after",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    const order: string[] = [];
    const textGen = makeTextGenSpawnObserver(() => order.push("textgen"));
    const authenticateReached = { hit: false };
    const heldAuthenticate = Deferred.makeUnsafe<void>();
    const script: FakeAcpScript = {
      onAuthenticate: () => {
        authenticateReached.hit = true;
      },
      onAuthenticateEffect: () => Deferred.await(heldAuthenticate),
      onPrompt: (steps) => steps.respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
      });
      const textGeneration = yield* makeTitleGenerator;
      assert.isFalse(yield* readAuthOk, "the flag starts false at server start");

      // The REAL turn-start shape: the reservation is taken, the title generation is fired
      // FIRST (ProviderCommandReactor forks it before it ensures the session), and the session
      // start follows. Without the reservation the `-p` child would win the permit.
      const turn = withAcpSpawnReservation(
        Effect.gen(function* () {
          const titleFiber = yield* Effect.forkChild(
            Effect.exit(generateTitle(textGeneration, "name this thread")),
          );
          // Give the title generation a real head start — it is the racer we must beat.
          yield* Effect.sleep("150 millis");
          assert.strictEqual(
            textGen.spawnCount(),
            0,
            "the title generation spawned BEFORE the session — the reservation did not hold",
          );
          const startFiber = yield* Effect.forkChild(
            adapter.startSession({
              threadId: ACTIVE_THREAD,
              cwd: process.cwd(),
              runtimeMode: "approval-required",
            }),
          );
          yield* pollUntil(() => authenticateReached.hit, "the session child reached authenticate");
          assert.strictEqual(
            textGen.spawnCount(),
            0,
            "still no -p child while the session authenticates",
          );
          yield* Deferred.succeed(heldAuthenticate, undefined);
          yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));
          yield* pollUntil(() => textGen.spawnCount() === 1, "the title generation ran after");
          yield* textGen.children[0]!.complete(textGenJsonOutput("A title"));
          yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
        }),
      );
      yield* turn;
      assert.deepStrictEqual(order.slice(0, 2), ["acp", "textgen"], "session first, title second");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          cliReloadSpawnerLayer(
            script,
            {
              onSpawn: () => {
                order.push("acp");
              },
            },
            textGen,
          ),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "priority 2: a standalone regenerate-title with no session coming runs immediately",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    return Effect.gen(function* () {
      const textGeneration = yield* makeTitleGenerator;
      assert.isFalse(yield* readAuthOk, "restart / reload / idle reset left the flag false");

      // No reservation, no acp waiter — nothing for it to defer to.
      const titleFiber = yield* Effect.forkChild(
        Effect.exit(generateTitle(textGeneration, "regenerate this title")),
      );
      yield* pollUntil(() => textGen.spawnCount() === 1, "the -p child spawned with no wait");
      yield* textGen.children[0]!.complete(textGenJsonOutput("Regenerated"));
      const result = yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(result._tag === "Success");
      assert.isTrue(yield* readAuthOk, "…and it is what proved the token");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
      TestClock.withLive,
    );
  },
);

it.effect("priority 3: a title generation already WAITING yields to a session start", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  let acpSpawns = 0;
  const order: string[] = [];
  const textGen = makeTextGenSpawnObserver(() => order.push("textgen"));
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      cancelGraceMs: 100,
      poolOptions: { eagerOnExpired: 0, refillDelayMs: 30_000 },
    });
    const textGeneration = yield* makeTitleGenerator;
    assert.isFalse(yield* readAuthOk);

    // A text generation takes the permit first and parks, holding it.
    const holderFiber = yield* Effect.forkChild(
      Effect.exit(generateTitle(textGeneration, "the holder")),
    );
    yield* pollUntil(() => textGen.spawnCount() === 1, "the holder -p child holds the permit");

    // A SECOND text generation queues behind it …
    const queuedTitleFiber = yield* Effect.forkChild(
      Effect.exit(generateTitle(textGeneration, "queued title")),
    );
    yield* Effect.sleep("120 millis");
    assert.strictEqual(textGen.spawnCount(), 1, "the second title generation is queued");

    // … and a SESSION start arrives AFTER it. FIFO alone would serve the title next; the
    // priority class must put the session in front of it.
    const sessionFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId: AFTER_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      }),
    );
    yield* Effect.sleep("120 millis");
    assert.strictEqual(acpSpawns, 0, "the session is queued too — the holder still has it");

    // The holder FAILS, so nothing set the auth flag: the gate is still live and the queue is
    // still ordered by class when the permit frees.
    yield* textGen.children[0]!.complete("boom", 1);
    yield* Fiber.join(holderFiber).pipe(Effect.timeout("10 seconds"));
    assert.isFalse(yield* readAuthOk, "a failed -p run proves nothing about the token");

    yield* Fiber.join(sessionFiber).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(acpSpawns, 1, "the SESSION went next, ahead of the older title waiter");
    // The first two CHILDREN are the claim: the holder, then the SESSION. (The queued title
    // follows once the session's `authenticate` sets the flag and the gate goes inert, which
    // is why the tail of `order` is not part of the assertion.)
    assert.deepStrictEqual(
      order.slice(0, 2),
      ["textgen", "acp"],
      "the queued title generation was spawned between the holder and the session",
    );

    // Only now does the queued title generation get its turn.
    yield* pollUntil(() => textGen.spawnCount() === 2, "the queued title generation went last");
    yield* textGen.children[1]!.complete(textGenJsonOutput("Queued title"));
    yield* Fiber.join(queuedTitleFiber).pipe(Effect.timeout("10 seconds"));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              acpSpawns += 1;
              order.push("acp");
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

// ── OWNER RULING R1 — the turn-start reservation is QWEN-ONLY ───────────────
//
// The reservation sits on the SHARED turn-start dispatch, so it must not let one provider's
// turn start block another's CLI work. The pair below is the whole claim: same scheduler, same
// waiter, only the resolved driver kind differs.

const reservationLookup = (driverKind: string) => ({
  readThreadInstanceId: () => Effect.succeed(ProviderInstanceId.make("instance-under-test")),
  readDriverKind: () => Effect.succeed(driverKind),
});
const TURN_SELECTION = { threadId: ACTIVE_THREAD };

const reservationSpec = (driverKind: string, expectBlocked: boolean, label: string) => {
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    const textGeneration = yield* makeTitleGenerator;
    assert.isFalse(yield* readAuthOk, "the gate is live — otherwise nothing is serialized");

    const releaseTurn = yield* Deferred.make<void>();
    const turnFiber = yield* Effect.forkChild(
      withQwenTurnStartReservationUsing(
        reservationLookup(driverKind),
        TURN_SELECTION,
        Deferred.await(releaseTurn),
      ),
    );
    yield* Effect.sleep("30 millis");

    // A qwen text generation asks while that turn start is in flight.
    const titleFiber = yield* Effect.forkChild(
      Effect.exit(generateTitle(textGeneration, "a qwen title")),
    );
    yield* Effect.sleep("200 millis");
    assert.strictEqual(textGen.spawnCount(), expectBlocked ? 0 : 1, label);

    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
    yield* pollUntil(() => textGen.spawnCount() === 1, "the text generation eventually ran");
    yield* textGen.children[0]!.complete(textGenJsonOutput("Title"));
    yield* Fiber.join(titleFiber).pipe(Effect.timeout("10 seconds"));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(cliReloadSpawnerLayer(script, {}, textGen), testServices)),
    TestClock.withLive,
  );
};

it.effect("R1: a NON-qwen turn start never blocks a qwen text generation", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  return reservationSpec(
    "claudeAgent",
    false,
    "a Claude turn start held an ACP reservation and blocked a qwen -p run",
  );
});

it.effect("R1: a qwen turn start DOES reserve — the ruling still holds for qwen", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  return reservationSpec(
    "qwen",
    true,
    "a qwen turn start did not reserve — the title generation slipped in front of the session",
  );
});

// ── D4 — the idle reset ──────────────────────────────────────────────────────

it.effect("idle reset clears the auth flag before the next CLI child exists", () => {
  resetCliReloadRuntimeForTests();
  resetCliSpawnSchedulerForTests();
  const textGen = makeTextGenSpawnObserver();
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  // The flag is READ at the spawn, so that is the only place its clearing is observable.
  const authAtSpawn: boolean[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profileDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-idle-profile-" });
    yield* fs.writeFileString(path.join(profileDir, "session.json"), "stale");

    const adapter = yield* makeQwenAdapter(decodeQwenSettings({ homePath: profileDir }), {
      cancelGraceMs: 100,
      // The pool's OWN idle clock — the only clock in this feature (owner ruling R9).
      // Fractional hours are what make a 120 ms window expressible at all.
      poolOptions: {
        eagerOnExpired: 0,
        refillDelayMs: 30_000,
        idleResetMs: 120,
        idleSweepMs: 20,
      },
    });
    yield* adapter.startSession({
      threadId: IDLE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.deepStrictEqual(authAtSpawn, [false], "the very first child spawned gated");
    assert.isTrue(yield* readAuthOk, "the first bind authenticated");
    const instance = (yield* listQwenInstances)[0]!;
    assert.strictEqual((yield* instance.readPool)!.state, "active");

    yield* pollUntilEffect(
      Effect.map(instance.readPool, (pool) => pool!.state === "expired"),
      "the pool's own idle sweeper reset it",
    );
    yield* adapter.startSession({
      threadId: AFTER_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.deepStrictEqual(
      authAtSpawn,
      [false, false],
      "the child after the idle reset was spawned with the flag CLEARED — i.e. gated again",
    );
    assert.isTrue(yield* readAuthOk, "…and its own authenticate re-set it");
    assert.isTrue(
      yield* fs.exists(path.join(profileDir, "session.json")),
      "REMOVE_SESSION_FILES_ON_EXPIRY ships false ⇒ an expiry deletes nothing",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        cliReloadSpawnerLayer(
          script,
          {
            onSpawn: () => {
              authAtSpawn.push(readAuthOkUnsafe());
            },
          },
          textGen,
        ),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});
