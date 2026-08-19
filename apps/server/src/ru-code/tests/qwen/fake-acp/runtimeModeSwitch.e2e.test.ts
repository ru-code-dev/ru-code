// ru-code: in-session runtime-mode switch proof (features #4 / S8·T1·M4). Drives the
// REAL QwenAdapter over the in-memory fake ACP agent across TWO turns on ONE session:
// turn 1 runs approval-required, turn 2 arrives with runtimeMode=full-access. Proves
// the mode change is applied via a LIVE per-turn setMode (session/set_config_option
// configId "mode") — NOT a session respawn — and that the refreshed
// ctx.currentRuntimeMode mirror is read at the full-access auto-approve short-circuit
// so a mid-turn permission request is auto-approved with NO request.opened surfacing.
//
// This is the adapter-level guarantee. The reactor's no-respawn GATE
// (runtimeModeChanged && supportsInSessionRuntimeMode !== true) is covered by the
// reactor's own tests; here we prove (via the fake spawner's spawn counter) that the
// adapter itself keeps ONE child across both turns — no self-inflicted respawn.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/schema";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-runtime-mode-thread");

// Single-test module state the script + spawner observers write into (referenced by
// both the script closure and the layer provision below).
const configCalls: Array<readonly [string, string | boolean]> = [];
const permissionOutcomes: Array<AcpSchema.RequestPermissionResponse["outcome"]> = [];
let spawnCount = 0;
let promptCount = 0;

const script: FakeAcpScript = {
  onSetConfigOption: (configId, value) => {
    configCalls.push([configId, value] as const);
  },
  onPermissionOutcome: (outcome) => {
    permissionOutcomes.push(outcome);
  },
  onPrompt: (steps) => {
    promptCount += 1;
    if (promptCount === 1) {
      // Turn 1 (approval-required): plain completion, no permission.
      steps.emitText("first turn").respondOk();
    } else {
      // Turn 2 (full-access): the agent asks for a tool permission. In full-access
      // the adapter must AUTO-APPROVE (allow_always) via the refreshed mirror — it
      // must NOT park behind a request.opened.
      steps
        .requestPermission({
          sessionId: FAKE_SESSION_ID,
          toolCall: { toolCallId: "edit-1", kind: "edit", rawInput: { path: "/tmp/x" } },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        })
        .respondOk();
    }
  },
};

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-runtime-mode-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "qwen runtime-mode switch: per-turn setMode applies full-access live (auto-approve, no respawn)",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // Turn 1 — approval-required. Completes on respondOk (no parked request).
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "turn one",
        runtimeMode: "approval-required",
      });

      // Turn 2 — full-access. The mid-turn permission is auto-approved, so this
      // sendTurn returns WITHOUT anyone responding — if the mirror were stale
      // (still approval-required) the request would park and this would hang.
      yield* adapter
        .sendTurn({
          threadId: THREAD_ID,
          input: "turn two",
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* Fiber.interrupt(eventsFiber);

      // (a) resolveQwenMode(full-access) → "auto-edit"; the live setMode dispatched
      // session/set_config_option("mode","auto-edit") on turn 2. Turn 1 mapped
      // approval-required → "default"; both live setMode wires fired in order (no
      // session restart between them wiped the mode).
      const modeCalls = configCalls.filter(([configId]) => configId === "mode");
      assert.deepStrictEqual(modeCalls, [
        ["mode", "default"],
        ["mode", "auto-edit"],
      ]);

      // (b) The full-access short-circuit read the REFRESHED mirror: the turn-2
      // permission was auto-approved (allow_always) and NEVER surfaced a request.
      assert.lengthOf(
        events.filter((e) => e.type === "request.opened"),
        0,
        "no request.opened — the full-access mirror auto-approved the permission",
      );
      assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), false);
      assert.deepStrictEqual(
        permissionOutcomes,
        [{ outcome: "selected", optionId: "always" }],
        "auto-approve selected the allow_always option",
      );

      // Both turns completed cleanly (single finalizer each).
      const completions = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed",
      );
      assert.lengthOf(completions, 2);
      for (const completion of completions) {
        assert.strictEqual(completion.payload.state, "completed");
      }

      // (c) NO respawn at the adapter level: exactly one child spawned for the
      // whole two-turn session, and the session was never torn down between turns.
      assert.strictEqual(spawnCount, 1, "the adapter spawned exactly one child (no respawn)");
      assert.isUndefined(
        events.find((e) => e.type === "session.exited"),
        "session was not torn down between turns",
      );
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
    ),
);
