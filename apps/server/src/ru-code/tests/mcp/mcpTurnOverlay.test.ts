// ru-code: unit contract of the per-turn overlay choreography (zone: mcpTurnOverlay) — the
// reactor-facing composite: resolve once per turn, write the FILE only at an actual spawn
// with ≥1 enabled server, name WHAT changed in the spawnReason, and delete exactly what was
// written when the spawn-decision region settles (success or failure).

import {
  type McpOverlaySpawnReason,
  type McpSessionOverlayShape,
  type McpSpawnState,
  type OverlayResolution,
  type OverlayResult,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";

import { makeMcpTurnOverlay } from "../../mcp/mcpTurnOverlay.ts";

const PROJECT_ID = ProjectId.make("p1");
const THREAD_ID = "t1";
const OVERLAY_PATH = "/tmp/mcp/p1/system.json";

const makeResolution = (over: Partial<OverlayResolution> = {}): OverlayResolution => ({
  projectId: PROJECT_ID,
  overlayPath: OVERLAY_PATH,
  allowedServerNames: ["srv"],
  fingerprint: "fp-current",
  contents: "{}",
  cwdMissing: false,
  allowlistKey: "srv",
  toolPolicyKey: "srv:allow",
  ...over,
});

interface StubCalls {
  readonly writeForSpawn: Array<{ spawnReason: McpOverlaySpawnReason; threadId: string }>;
  readonly recordSpawn: McpSpawnState[];
  readonly deleted: string[];
}

/** Stub of the package service that mirrors its contract: 0 servers ⇒ null (skip). */
const makeStub = (config: {
  readonly resolution: OverlayResolution | null;
  readonly changed?: boolean;
  readonly previous?: McpSpawnState;
}): { overlay: McpSessionOverlayShape; calls: StubCalls } => {
  const calls: StubCalls = { writeForSpawn: [], recordSpawn: [], deleted: [] };
  const overlay: McpSessionOverlayShape = {
    resolveForTurn: () => Effect.succeed(config.resolution),
    writeForSpawn: (resolution, context) =>
      Effect.sync(() => {
        calls.writeForSpawn.push({
          spawnReason: context.spawnReason,
          threadId: context.threadId,
        });
        return resolution.allowedServerNames.length === 0
          ? null
          : ({
              overlayPath: resolution.overlayPath,
              allowedServerNames: resolution.allowedServerNames,
              fingerprint: resolution.fingerprint,
            } satisfies OverlayResult);
      }),
    changedForThread: () => Effect.succeed(config.changed ?? false),
    spawnState: () => Effect.succeed(config.previous),
    recordSpawn: (_threadId, state) => Effect.sync(() => void calls.recordSpawn.push(state)),
    deleteOverlayFile: (overlayPath) => Effect.sync(() => void calls.deleted.push(overlayPath)),
  };
  return { overlay, calls };
};

const makeTurn = (overlay: McpSessionOverlayShape) =>
  makeMcpTurnOverlay({ mcpSessionOverlay: overlay, projectId: PROJECT_ID, threadId: THREAD_ID });

describe("mcpTurnOverlay — per-turn overlay choreography", () => {
  it.effect("null resolution (engine off / failed): every member is inert", () =>
    Effect.gen(function* () {
      const { overlay, calls } = makeStub({ resolution: null });
      const turn = yield* makeTurn(overlay);

      assert.strictEqual(turn.fingerprint, undefined);
      assert.strictEqual(yield* turn.overlayChanged, false);
      assert.deepStrictEqual(yield* turn.overlayFieldsForSpawn("fresh-spawn"), {});
      yield* turn.recordSpawn;
      yield* turn.logReuseSkip;
      yield* turn.withCleanup(Effect.void);
      assert.strictEqual(calls.writeForSpawn.length, 0, "writeForSpawn never called");
      assert.strictEqual(calls.recordSpawn.length, 0, "recordSpawn never called");
      assert.deepStrictEqual(calls.deleted, [], "nothing to delete");
    }),
  );

  it.effect(
    "fresh spawn with ≥1 server: file written (fresh-spawn), fields returned, cleanup deletes it",
    () =>
      Effect.gen(function* () {
        const { overlay, calls } = makeStub({ resolution: makeResolution() });
        const turn = yield* makeTurn(overlay);

        const fields = yield* turn.overlayFieldsForSpawn("fresh-spawn");
        assert.deepStrictEqual(fields, {
          settingsOverlayPath: OVERLAY_PATH,
          allowedMcpServers: ["srv"],
        });
        assert.deepStrictEqual(
          calls.writeForSpawn.map((call) => call.spawnReason),
          ["fresh-spawn"],
        );
        assert.strictEqual(calls.writeForSpawn[0]!.threadId, THREAD_ID);

        yield* turn.withCleanup(Effect.void);
        assert.deepStrictEqual(calls.deleted, [OVERLAY_PATH], "exactly the written file");
      }),
  );

  it.effect("0-server spawn: nothing written, empty fields, cleanup deletes nothing", () =>
    Effect.gen(function* () {
      const { overlay, calls } = makeStub({
        resolution: makeResolution({ allowedServerNames: [], allowlistKey: "" }),
      });
      const turn = yield* makeTurn(overlay);

      const fields = yield* turn.overlayFieldsForSpawn("fresh-spawn");
      assert.deepStrictEqual(fields, {}, "a clean no-MCP spawn");
      assert.strictEqual(calls.writeForSpawn.length, 1, "the skip is still traced");
      yield* turn.withCleanup(Effect.void);
      assert.deepStrictEqual(calls.deleted, []);
    }),
  );

  it.effect("cleanup runs when the wrapped region FAILS", () =>
    Effect.gen(function* () {
      const { overlay, calls } = makeStub({ resolution: makeResolution() });
      const turn = yield* makeTurn(overlay);

      yield* turn.overlayFieldsForSpawn("fresh-spawn");
      const exit = yield* Effect.exit(turn.withCleanup(Effect.fail("spawn failed")));
      assert.strictEqual(exit._tag, "Failure");
      assert.deepStrictEqual(calls.deleted, [OVERLAY_PATH], "ensuring ran on failure");
    }),
  );

  it.effect("recordSpawn passes the resolution's identity triple", () =>
    Effect.gen(function* () {
      const { overlay, calls } = makeStub({ resolution: makeResolution() });
      const turn = yield* makeTurn(overlay);

      yield* turn.recordSpawn;
      assert.deepStrictEqual(calls.recordSpawn, [
        { fingerprint: "fp-current", allowlistKey: "srv", toolPolicyKey: "srv:allow" },
      ]);
    }),
  );

  it.effect("reuse turn: logReuseSkip alone — no write, no delete", () =>
    Effect.gen(function* () {
      const { overlay, calls } = makeStub({ resolution: makeResolution(), changed: false });
      const turn = yield* makeTurn(overlay);

      yield* turn.logReuseSkip;
      yield* turn.withCleanup(Effect.void);
      assert.strictEqual(calls.writeForSpawn.length, 0);
      assert.deepStrictEqual(calls.deleted, []);
    }),
  );

  describe("respawn reason discrimination (what the applied/skipped logs name)", () => {
    const reasonFor = (config: {
      readonly changed: boolean;
      readonly previous?: McpSpawnState;
      readonly resolution?: Partial<OverlayResolution>;
    }) =>
      Effect.gen(function* () {
        const { overlay, calls } = makeStub({
          resolution: makeResolution(config.resolution ?? {}),
          changed: config.changed,
          ...(config.previous !== undefined ? { previous: config.previous } : {}),
        });
        const turn = yield* makeTurn(overlay);
        yield* turn.overlayFieldsForSpawn("respawn");
        return calls.writeForSpawn[0]!.spawnReason;
      });

    it.effect("overlay unchanged (non-MCP trigger) → respawn:other", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* reasonFor({ changed: false }), "respawn:other");
      }),
    );

    it.effect(
      "changed but previous state unknown (evicted/restart) → respawn:mcp-config-changed",
      () =>
        Effect.gen(function* () {
          assert.strictEqual(yield* reasonFor({ changed: true }), "respawn:mcp-config-changed");
        }),
    );

    it.effect("server set differs → respawn:mcp-servers-changed", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* reasonFor({
            changed: true,
            previous: { fingerprint: "fp-old", allowlistKey: "old", toolPolicyKey: "srv:allow" },
          }),
          "respawn:mcp-servers-changed",
        );
      }),
    );

    it.effect("same servers, tool policy differs → respawn:mcp-allowed-tools-changed", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* reasonFor({
            changed: true,
            previous: { fingerprint: "fp-old", allowlistKey: "srv", toolPolicyKey: "srv:deny" },
          }),
          "respawn:mcp-allowed-tools-changed",
        );
      }),
    );

    it.effect("same servers + policy, other config differs → respawn:mcp-config-changed", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* reasonFor({
            changed: true,
            previous: { fingerprint: "fp-old", allowlistKey: "srv", toolPolicyKey: "srv:allow" },
          }),
          "respawn:mcp-config-changed",
        );
      }),
    );
  });
});
