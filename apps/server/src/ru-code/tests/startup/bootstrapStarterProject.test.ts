// ru-code: proves the startup bootstrap registers the fixed <baseDir>/Project
// starter folder (with createWorkspaceRootIfMissing) instead of adopting the
// launch cwd. Captures the dispatched project.create command and asserts its
// workspaceRoot + self-heal flag.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";

const unusedProjectionQuery = {
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getProjectShellById: () => Effect.die("unused"),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unused"),
} as never;

it.effect("registers <baseDir>/Project (not cwd) with createWorkspaceRootIfMissing", () =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);

    yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/some/where/else",
        baseDir: "/home/u/.ru-code",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, unusedProjectionQuery),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command as Record<string, unknown>]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        // ru-code: t3 added `latestSequence` to OrchestrationEngineShape after this
        // patch was written; the fake only needs to satisfy the shape.
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    const dispatched = yield* Ref.get(commands);
    const projectCreate = dispatched.find((c) => c.type === "project.create");
    assert.ok(projectCreate, "expected a project.create dispatch");
    assert.equal(projectCreate.workspaceRoot, "/home/u/.ru-code/Project");
    assert.notEqual(projectCreate.workspaceRoot, "/some/where/else");
    assert.equal(projectCreate.createWorkspaceRootIfMissing, true);
  }),
);
