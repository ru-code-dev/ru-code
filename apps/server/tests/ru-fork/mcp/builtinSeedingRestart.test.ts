// ru-fork: REPRO for the built-in seeding bug ACROSS A REAL RESTART.
//
// `builtinSeedingAccumulation.test.ts` reconciles repeatedly on ONE live runtime — it never re-runs
// the projection bootstrap, so it cannot catch a bug in the replay/checkpoint path. This file closes
// that gap: each `bootSystem(baseDir)` builds a FRESH runtime over the SAME on-disk sqlite file, so
// rebuilding it = a real process restart (the engine's `projectionPipeline.bootstrap` replays the
// persisted event log from each projector's checkpoint, exactly like a cold boot).
//
// Sharing the DB file is done by passing a FIXED-STRING baseDir to `ServerConfig.layerTest` (a string
// baseDir is used verbatim; a `{prefix}` would mint a fresh temp dir each time) plus the file-backed
// `layerConfig` instead of the in-memory sqlite layer.
//
// The assertions encode the CORRECT behaviour: a built-in seeded in one boot MUST still be in the
// catalog after the next boot's bootstrap replay (durability), and adding a SECOND built-in on a later
// boot must leave the first in place — visible in a SINGLE restart, not two. These go RED on the buggy
// build ("first disappears" / "restart twice"); green on a correct one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpCatalogServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { layerConfig } from "../../../src/persistence/Layers/Sqlite.ts";
import { McpCatalogRepository } from "../../../src/persistence/Services/McpCatalog.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../../src/config.ts";
import type { McpBuiltinDefinition } from "../../../src/ru-fork/mcp/McpBuiltins.ts";
import { reconcileBuiltinsWith } from "../../../src/ru-fork/mcp/McpReactor.ts";

const ALPHA: McpBuiltinDefinition = {
  builtinId: "alpha",
  name: "alpha",
  description: "Alpha built-in",
  config: { default: { transport: "stdio", command: "uvx", args: ["alpha"] } },
  vars: [],
};
const BETA: McpBuiltinDefinition = {
  builtinId: "beta",
  name: "beta",
  description: "Beta built-in",
  config: { default: { transport: "stdio", command: "uvx", args: ["beta"] } },
  vars: [],
};

const builtinIds = (catalog: ReadonlyArray<McpCatalogServer>): ReadonlyArray<string> =>
  catalog
    .map((server) => server.builtinId)
    .filter((id): id is string => id !== null)
    .toSorted();

// One boot of the server against the on-disk DB at `baseDir`. Building this layer runs the engine's
// `projectionPipeline.bootstrap` (replay from checkpoints) — i.e. it IS a process restart.
function bootSystem(baseDir: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionPipelineLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(layerConfig), // file-backed sqlite — SHARED across boots
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    reconcile: (definitions: ReadonlyArray<McpBuiltinDefinition>) =>
      runtime.runPromise(reconcileBuiltinsWith(definitions, process.platform)),
    catalog: (): Promise<ReadonlyArray<McpCatalogServer>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpCatalogRepository), (repo) => repo.listAll()),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("built-in seeding survives a real restart (bootstrap replay)", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "t3-mcp-restart-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("ALPHA persists across a restart, then adding BETA on the next boot keeps BOTH", async () => {
    // Boot 1: ship only ALPHA.
    const boot1 = bootSystem(baseDir);
    await boot1.reconcile([ALPHA]);
    expect(builtinIds(await boot1.catalog())).toEqual(["alpha"]);
    await boot1.dispose();

    // Boot 2 = real restart. The bootstrap replay MUST have ALPHA before we touch anything.
    const boot2 = bootSystem(baseDir);
    expect(builtinIds(await boot2.catalog())).toEqual(["alpha"]); // durability across restart
    // Now edit mcpBuiltinDefinitions.ts to add BETA and reconcile.
    await boot2.reconcile([ALPHA, BETA]);
    expect(builtinIds(await boot2.catalog())).toEqual(["alpha", "beta"]); // ALPHA must NOT vanish
    await boot2.dispose();

    // Boot 3 = another restart, same shipped list: both still there (no "restart twice").
    const boot3 = bootSystem(baseDir);
    expect(builtinIds(await boot3.catalog())).toEqual(["alpha", "beta"]);
    await boot3.dispose();
  });

  it("a plain restart with no definition change neither drops nor duplicates built-ins", async () => {
    const boot1 = bootSystem(baseDir);
    await boot1.reconcile([ALPHA, BETA]);
    expect(builtinIds(await boot1.catalog())).toEqual(["alpha", "beta"]);
    await boot1.dispose();

    const boot2 = bootSystem(baseDir);
    // Replayed catalog before reconcile.
    expect(builtinIds(await boot2.catalog())).toEqual(["alpha", "beta"]);
    // Idempotent re-seed of the same list.
    await boot2.reconcile([ALPHA, BETA]);
    const catalog = await boot2.catalog();
    expect(builtinIds(catalog)).toEqual(["alpha", "beta"]);
    expect(catalog.filter((s) => s.builtinId === "alpha")).toHaveLength(1);
    expect(catalog.filter((s) => s.builtinId === "beta")).toHaveLength(1);
    await boot2.dispose();
  });

  it("the catalog the UI sees right after EACH restart matches the shipped set", async () => {
    // Mirrors the user's narration: each boot's first catalog read = what the panel shows on open.
    const seen: Record<string, ReadonlyArray<string>> = {};

    const boot1 = bootSystem(baseDir);
    await boot1.reconcile([ALPHA]); // ship #1
    seen.afterBoot1 = builtinIds(await boot1.catalog());
    await boot1.dispose();

    const boot2 = bootSystem(baseDir);
    await boot2.reconcile([ALPHA, BETA]); // ship #2
    seen.afterBoot2 = builtinIds(await boot2.catalog());
    await boot2.dispose();

    expect(seen.afterBoot1).toEqual(["alpha"]);
    expect(seen.afterBoot2).toEqual(["alpha", "beta"]); // NOT ["beta"], NOT needing a 3rd boot
  });
});
