// ru-code: fork multi-project model over the port's ReviewService guard. The
// port trusts only the server's workspace root / worktrees dir; the fork lets
// projects live at ANY path, so a cwd inside a REGISTERED project root must be
// trusted too (registeredProjectRoots.ts seam) — this is exactly why the diff
// panel was empty/erroring for every externally-located project. Fail-closed
// contracts pinned: unregistered paths stay rejected, and without the
// projection query in context the port's original behavior holds.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ReviewService from "../../../review/ReviewService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function shellSnapshotWithProjectRoots(
  projectRoots: ReadonlyArray<string>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: projectRoots.map((workspaceRoot, index) => ({
      id: ProjectId.make(`project-${index + 1}`),
      title: `Project ${index + 1}`,
      workspaceRoot,
      repositoryIdentity: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("qwen"),
        model: "",
      },
      scripts: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })),
    threads: [],
    updatedAt: CREATED_AT,
  };
}

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly registeredProjectRoots?: ReadonlyArray<string>;
}) {
  const base = ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
  );
  const withProjects = input.registeredProjectRoots
    ? base.pipe(
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () =>
              Effect.succeed(shellSnapshotWithProjectRoots(input.registeredProjectRoots!)),
          }),
        ),
      )
    : base;
  return withProjects.pipe(Layer.provideMerge(NodeServices.layer));
}

describe("ReviewService diff-preview cwd guard (registered project roots)", () => {
  it.effect("allows a cwd that IS a registered project root outside the workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-ws-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-project-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, registeredProjectRoots: [projectRoot] }),
        ),
      );

      assert.strictEqual(result.cwd, projectRoot);
      assert.deepStrictEqual(result.sources, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a SUBDIRECTORY of a registered project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-ws-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-project-" });
      const nestedCwd = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(nestedCwd, { recursive: true });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: nestedCwd });
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, registeredProjectRoots: [projectRoot] }),
        ),
      );

      assert.strictEqual(result.cwd, nestedCwd);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still rejects an outside cwd that no project registered (fail closed)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-ws-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-project-" });
      const strangerCwd = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-outside-" });

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: strangerCwd }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, registeredProjectRoots: [projectRoot] }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("without the projection query in context the port behavior holds (rejected)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-ws-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-base-" });
      const outsideCwd = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-review-outside-" });

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
