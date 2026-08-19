// ru-code: resume-fallback coverage over the REAL QwenAdapter + in-memory fake
// ACP agent. Contract: when a VALID resume cursor exists but the CLI's
// `session/load` FAILS, the runtime must fall back to a fresh `session/new`
// and the fallback session must be FULLY usable — in particular the
// update-suppression armed around session/load must be lifted again, so a
// subsequent turn streams its deltas normally.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-resume-fallback-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-resume-fallback-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "qwen resume: a failing session/load on a valid cursor falls back to a fresh session/new and the session stays fully usable",
  () => {
    const loadSessionIds: string[] = [];
    let createSessionCount = 0;
    const script: FakeAcpScript = {
      // Only session/load fails; session/new keeps the default happy path.
      loadBehavior: "error",
      onLoadSession: (sessionId) => {
        loadSessionIds.push(sessionId);
      },
      onCreateSession: () => {
        createSessionCount += 1;
      },
      onPrompt: (steps) => steps.emitText("after-fallback").respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const deltas: string[] = [];
      const sawFallbackDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        (event: ProviderRuntimeEvent) =>
          Effect.sync(() => {
            if (event.type === "content.delta") {
              deltas.push(event.payload.delta);
            }
          }).pipe(
            Effect.andThen(
              event.type === "content.delta" && event.payload.delta.includes("after-fallback")
                ? Deferred.succeed(sawFallbackDelta, undefined)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild);

      // A VALID cursor — the runtime MUST try session/load first.
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
      });

      // Load WAS attempted with the cursor's sessionId, then the fallback fired.
      assert.deepStrictEqual(loadSessionIds, [FAKE_SESSION_ID]);
      assert.strictEqual(createSessionCount, 1, "fallback ran exactly one fresh session/new");
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);

      // The fallback session streams turn deltas normally — proves the
      // update-suppression armed for session/load was lifted again.
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "hello" })
        .pipe(Effect.timeout("10 seconds"));
      yield* Deferred.await(sawFallbackDelta).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);
      assert.isDefined(
        deltas.find((delta) => delta.includes("after-fallback")),
        "the post-fallback turn streamed its text delta",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);
