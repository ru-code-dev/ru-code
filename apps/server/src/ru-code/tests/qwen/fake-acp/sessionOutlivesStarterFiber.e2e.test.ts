// ru-code: THE root-cause pin for the live "reply lost after compress-first"
// report. `startSession` used to fork the session's notification drain — the
// ONLY consumer of every ACP `session/update` — with `Effect.forkChild`,
// making it a child of WHOEVER called startSession; effect v4 interrupts
// children when the parent fiber completes. A message-first flow starts
// sessions from the reactor's immortal worker (drain lived), but the
// compact-first flow starts them from the short-lived compaction fiber
// (ProviderService recovery) — the moment the compaction completed, the drain
// died and the session went DEAF: prompts still resolved, chunks landed in a
// queue nobody read. No deltas, no message, no logs, reload didn't help.
//
// The fix forks the drain (and the child-exit watcher) into the SESSION scope
// (`Effect.forkIn(sessionScope)`), so they live exactly as long as the session
// regardless of which fiber started it. Pinned here at the adapter level,
// deterministically: start the session from a fiber that COMPLETES, then run a
// turn — its reply deltas must still flow.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const REPLY_TEXT = "Привет! 👋";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-session-outlives-starter-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const script: FakeAcpScript = {
  onPrompt: (steps) => {
    steps.emitText(REPLY_TEXT).respondOk();
  },
};

it.effect(
  "a session started from a SHORT-LIVED fiber still streams turns after that fiber completes",
  () =>
    Effect.gen(function* () {
      const collected: ProviderRuntimeEvent[] = [];
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const eventsFiber = yield* Effect.forkChild(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              collected.push(event);
            }),
          ),
        );
        const threadId = ThreadId.make("session-outlives-starter");

        // The compact-first shape: startSession runs on a fiber that ENDS
        // (live: the reactor's runCompaction fiber via ProviderService session
        // recovery). Its completion must NOT kill the session's internals.
        const starterFiber = yield* Effect.forkChild(
          adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          }),
        );
        yield* Fiber.await(starterFiber);
        // Give structured-concurrency interruption (the bug) time to land.
        yield* Effect.sleep("50 millis");

        const turn = yield* adapter
          .sendTurn({ threadId, input: "привет", runtimeMode: "approval-required" })
          .pipe(Effect.timeout("10 seconds"));

        // The reply deltas must arrive — with the bug the drain is dead and
        // nothing is ever emitted despite the turn completing cleanly.
        yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 300; attempt += 1) {
            if (
              collected.some(
                (event) =>
                  event.type === "content.delta" && event.payload.delta.includes(REPLY_TEXT),
              )
            ) {
              return;
            }
            yield* Effect.sleep("10 millis");
          }
          return yield* Effect.die(
            new Error(
              `the turn's reply delta never arrived (turn ${turn.turnId} completed; session is deaf)`,
            ),
          );
        });
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      );
    }).pipe(TestClock.withLive),
);
