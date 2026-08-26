// ru-code: warm-engine v2 MCP-project pool proof over the REAL QwenAdapter,
// using the fake spawner's spawn-recipe capture:
//   - an MCP project's FIRST start is cold (canonical overlay env + allowlist
//     argv + the branding registry's enforced env), then the project gets its own spares
//     baked with the same allowlist and slot-private overlay paths;
//   - the next start TAKES a project spare: the slot overlay file carries the
//     LIVE canonical bytes at bind (policy/secret edits reuse spares) and the
//     copy is deleted once the start settles;
//   - a LAYOUT CHANGE (server add/remove) discards the project's spares, the
//     changing start goes cold with the new argv, and the pool re-fills.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { MCP_PREWARM_INSTANCES, PREWARM_GENERIC_INSTANCES } from "@ru-code/qwen/constants";
import { CLI_ARGS, CLI_ENV, cliEnvAssignments } from "@ru-code/branding";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer, type FakeAcpSpawnerObservers } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-overlay-thread");
const PROJECT_ID = "mcp-project-alpha";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-warm-overlay-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface SpawnRecipe {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
}

const allowlistOf = (recipe: SpawnRecipe): string | null => {
  const index = recipe.args.indexOf(CLI_ARGS.ALLOWED_MCP_SERVERS.flag);
  return index === -1 ? null : String(recipe.args[index + 1]);
};

// ru-code: the concrete env-var names live in branding's CLI registry (cliEnv.ts) — these tests
// read them through it, so a fork's prefix rename cannot leave this suite asserting dead names.
/** A runtime row's value on this spawn (all aliases carry the same value). */
const rowValue = (recipe: SpawnRecipe, row: { readonly names: ReadonlyArray<string> }): string =>
  String(recipe.env?.[row.names[0] as string]);

/** Assert EVERY alias of a runtime row carries `expected` on this spawn. */
const assertRow = (
  recipe: SpawnRecipe,
  row: { readonly names: ReadonlyArray<string> },
  expected: string,
  message: string,
): void => {
  for (const name of row.names)
    assert.strictEqual(recipe.env?.[name], expected, `${message} (${name})`);
};

/** The registry rows that are fixed for every spawn — no ACP spawn may be missing one. */
const assertEnforcedEnv = (recipe: SpawnRecipe, message: string): void => {
  for (const [name, value] of cliEnvAssignments()) {
    assert.strictEqual(recipe.env?.[name], value, `${message}: enforced ${name}`);
  }
  // HOME is runtime-supplied (per-instance homePath / profile default / preflight), so what is
  // pinned here is that it arrived at all and arrived EXPANDED.
  for (const name of CLI_ENV.HOME.names) {
    const home = String(recipe.env?.[name] ?? "");
    assert.isAbove(home.length, 0, `${message}: ${name} present`);
    assert.isFalse(home.startsWith("~"), `${message}: ${name} expanded`);
  }
};

it.effect(
  "MCP project pool: cold first start, per-project spares, live bytes at bind, layout retirement",
  () => {
    const recipes: SpawnRecipe[] = [];
    const observedAtBind: Array<{ path: string; contents: string }> = [];
    let slotOverlayPathForBind: string | undefined;
    // Filled once the test's Effect context is live — the effectful
    // session/new hook below reads the slot overlay through it at BIND time
    // (the only moment the copy exists).
    let bindReader: ((path: string) => Effect.Effect<string>) | undefined;
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.respondOk(),
      onCreateSessionEffect: () =>
        slotOverlayPathForBind !== undefined && bindReader !== undefined
          ? bindReader(slotOverlayPathForBind).pipe(
              Effect.map((contents) => {
                observedAtBind.push({ path: slotOverlayPathForBind!, contents });
              }),
            )
          : Effect.void,
    };
    const observers: FakeAcpSpawnerObservers = {
      onSpawnInput: (input) => {
        recipes.push(input);
      },
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      bindReader = (path) => fs.readFileString(path).pipe(Effect.orDie);
      const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      // Boot prewarm: 2 GENERIC spares (sentinel allowlist argv, slot overlay env).
      assert.lengthOf(recipes, PREWARM_GENERIC_INSTANCES, "boot prewarmed the generic spares");
      for (const generic of recipes) {
        // ru-code: a generic spare wants NO MCP, which must be an allowlist nothing matches —
        // omitting the flag disables the CLI's filter, so it connects (and awaits) every
        // configured server during startup and the spare dies on its warmup budget.
        assert.strictEqual(
          allowlistOf(generic),
          CLI_ARGS.ALLOWED_MCP_SERVERS.value,
          "generic spares block MCP with the sentinel allowlist",
        );
        assertEnforcedEnv(generic, "generic spare");
        assert.strictEqual(generic.cwd, serverConfig.stateDir, "spares spawn with neutral cwd");
      }

      // The canonical overlay file at the MCP manager's per-project path.
      const canonicalPath = `${serverConfig.stateDir}/mcp/overlays/${PROJECT_ID}/system.json`;
      yield* fs.makeDirectory(`${serverConfig.stateDir}/mcp/overlays/${PROJECT_ID}`, {
        recursive: true,
      });
      yield* fs.writeFileString(canonicalPath, `{"mcpServers":{"alpha":{},"beta":{}}}`);

      // ── First MCP start: COLD (no project pool yet), then spares appear ──
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        settingsOverlayPath: canonicalPath,
        allowedMcpServers: ["beta", "alpha"],
      });
      assert.lengthOf(
        recipes,
        PREWARM_GENERIC_INSTANCES + 1 + MCP_PREWARM_INSTANCES,
        "cold spawn + the project spares allocated after the bind",
      );
      // Index derivation: the boot spares come first, the cold spawn follows.
      const cold = recipes[PREWARM_GENERIC_INSTANCES]!;
      assert.strictEqual(allowlistOf(cold), "beta,alpha");
      assertRow(
        cold,
        CLI_ENV.SYSTEM_SETTINGS_PATH,
        canonicalPath,
        "the cold start reads the canonical overlay directly",
      );
      assertEnforcedEnv(cold, "cold start");
      // The FIRST project spare (spawned right after the cold bind succeeded).
      // NOTE: this also pins the pool's DOCUMENTED FIFO pop order — takes pop
      // the OLDEST spare first (WarmAcpPool popSlotLocked), so the next take
      // below binds exactly this recipe's slot.
      const spare = recipes[PREWARM_GENERIC_INSTANCES + 1]!;
      assert.deepStrictEqual(
        String(allowlistOf(spare)).split(",").sort(),
        ["alpha", "beta"],
        "project spares bake the SAME allowlist set",
      );
      const spareOverlayPath = rowValue(spare, CLI_ENV.SYSTEM_SETTINGS_PATH);
      assert.match(
        spareOverlayPath,
        /qwen-warm[/\\].+[/\\]system\.json$/,
        "spares point at slot-private overlay paths under <stateDir>/qwen-warm/",
      );
      assert.isFalse(
        yield* fs.exists(spareOverlayPath),
        "no slot overlay file exists while parked (copied only at take)",
      );

      // ── Second start: takes a project spare; LIVE canonical bytes at bind ──
      // Edit the overlay CONTENT (same server set — e.g. a tool-policy change):
      // spares stay valid; the take copies the live bytes.
      yield* fs.writeFileString(canonicalPath, `{"mcpServers":{"alpha":{"v":2},"beta":{}}}`);
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      slotOverlayPathForBind = spareOverlayPath;
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          settingsOverlayPath: canonicalPath,
          allowedMcpServers: ["alpha", "beta"],
        })
        .pipe(Effect.timeout("10 seconds"));
      slotOverlayPathForBind = undefined;
      assert.lengthOf(
        recipes,
        PREWARM_GENERIC_INSTANCES + 2 + MCP_PREWARM_INSTANCES,
        "warm take is spawn-free; +1 is the project top-up",
      );
      assert.lengthOf(observedAtBind, 1, "session setup observed the slot overlay file");
      assert.strictEqual(
        observedAtBind[0]!.contents,
        `{"mcpServers":{"alpha":{"v":2},"beta":{}}}`,
        "the slot file carried the LIVE canonical bytes at bind time",
      );
      assert.isFalse(
        yield* fs.exists(spareOverlayPath),
        "the slot overlay copy is deleted once the start settles",
      );

      // ── LAYOUT CHANGE: server set differs → spares retired, cold once ──
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          settingsOverlayPath: canonicalPath,
          allowedMcpServers: ["gamma"],
        })
        .pipe(Effect.timeout("10 seconds"));
      // +1 cold with the new argv, +2 fresh spares for the new layout.
      assert.lengthOf(
        recipes,
        PREWARM_GENERIC_INSTANCES + 3 + MCP_PREWARM_INSTANCES * 2,
        "layout change: cold once, then fresh spares",
      );
      const newCold = recipes[PREWARM_GENERIC_INSTANCES + 2 + MCP_PREWARM_INSTANCES]!;
      assert.strictEqual(allowlistOf(newCold), "gamma");
      assertRow(
        newCold,
        CLI_ENV.SYSTEM_SETTINGS_PATH,
        canonicalPath,
        "the cold respawn reads the canonical overlay directly",
      );
      const newSpareBase = PREWARM_GENERIC_INSTANCES + 3 + MCP_PREWARM_INSTANCES;
      assert.strictEqual(allowlistOf(recipes[newSpareBase]!), "gamma");
      assert.strictEqual(allowlistOf(recipes[newSpareBase + 1]!), "gamma");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script, observers), testServices)),
      TestClock.withLive,
    );
  },
);
