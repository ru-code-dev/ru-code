// ru-code (cli-reload, D4): the OTHER half of the idle-expiry contract — with the branding
// flag ON, an idle reset also removes the configured profile-dir entries, and it does so
// BEFORE the next CLI child exists. Own file: both constants are build-time values, flipped
// here via vi.mock at module scope (the modelDiscoveryOff.e2e.test.ts idiom).
//
// The sibling case in cliReload.e2e.test.ts pins the SHIPPED behaviour (flag false ⇒ nothing
// is deleted); together they cover both arms of the one branch that reads the flag.
//
// node:fs / node:path on purpose: the ordering claim ("the entries are gone BEFORE the next
// child exists") is only observable inside the spawner's SYNCHRONOUS onSpawn callback, which
// cannot suspend into an Effect FileSystem read.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

vi.mock("@ru-code/branding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ru-code/branding")>();
  return {
    ...actual,
    DELETE_ON_CLI_RESTART: ["session.json", "sessions/"],
    REMOVE_SESSION_FILES_ON_EXPIRY: true,
  };
});

import * as ServerConfig from "../../../../config.ts";
import { resetCliSpawnSchedulerForTests } from "../../../cli-reload/cliSpawnScheduler.ts";
import {
  listQwenInstances,
  resetCliReloadRuntimeForTests,
} from "../../../cli-reload/reloadRuntime.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { cliReloadSpawnerLayer, makeTextGenSpawnObserver } from "./cliReloadHarness.ts";
import { pollUntilEffect } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const IDLE_THREAD = ThreadId.make("qwen-idle-delete-idle-thread");
const AFTER_THREAD = ThreadId.make("qwen-idle-delete-after-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-cli-reload-expiry-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "idle reset with the delete flag on clears the listed entries before the next spawn",
  () => {
    resetCliReloadRuntimeForTests();
    resetCliSpawnSchedulerForTests();
    const textGen = makeTextGenSpawnObserver();
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    // Recorded INSIDE the spawn observer: the ordering claim ("before any spawn") is only
    // provable at the moment a child is created, not after the fact.
    const listedAtSpawn: boolean[] = [];
    const controlAtSpawn: boolean[] = [];
    let profileDir = "";
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      profileDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-expiry-profile-" });
      yield* fs.makeDirectory(path.join(profileDir, "sessions", "deep"), { recursive: true });
      yield* fs.writeFileString(path.join(profileDir, "session.json"), "stale");
      yield* fs.writeFileString(path.join(profileDir, "sessions", "deep", "a.jsonl"), "stale");
      yield* fs.writeFileString(path.join(profileDir, "settings.json"), "user data");

      const adapter = yield* makeQwenAdapter(decodeQwenSettings({ homePath: profileDir }), {
        cancelGraceMs: 100,
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
      assert.deepStrictEqual(listedAtSpawn, [true], "the first child saw the seeded files intact");

      const instance = (yield* listQwenInstances)[0]!;
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
        listedAtSpawn,
        [true, false],
        "the listed entries were already gone when the post-expiry child was spawned",
      );
      assert.deepStrictEqual(controlAtSpawn, [true, true], "an unlisted file was never touched");
      assert.isFalse(yield* fs.exists(path.join(profileDir, "session.json")));
      assert.isFalse(yield* fs.exists(path.join(profileDir, "sessions")));
      assert.isTrue(yield* fs.exists(path.join(profileDir, "settings.json")));
      assert.isTrue(yield* fs.exists(profileDir), "the profile dir itself survives");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          cliReloadSpawnerLayer(
            script,
            {
              onSpawn: () => {
                listedAtSpawn.push(NodeFS.existsSync(NodePath.join(profileDir, "session.json")));
                controlAtSpawn.push(NodeFS.existsSync(NodePath.join(profileDir, "settings.json")));
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
