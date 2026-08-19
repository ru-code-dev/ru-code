// ru-code: regression guard for the Skills/Agents catalog projects port.
//
// The catalog keys projects by their stable `ProjectId` (the identity the runtime + respawn gate use),
// resolving the cwd via the read-model repo. This test drives the REAL exported layers
// (skillProjectsLayer / agentProjectsLayer) against a real in-memory ProjectionProjectRepository and
// asserts: `listLive` returns `{id: projectId, cwd: workspaceRoot}` for non-deleted projects, and
// `getCwd(projectId)` resolves the workspaceRoot (null for unknown / soft-deleted). If `listLive` ever
// regresses to empty, or the id/cwd get swapped, this fails.

import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SkillManagerProjects } from "@smart-tools/qwen-cli-skill-manager/server";
import { AgentManagerProjects } from "@smart-tools/qwen-cli-agents-manager/server";

import { skillProjectsLayer, agentProjectsLayer } from "../../skills-agents/catalogLayers.ts";
import {
  ProjectionProject,
  ProjectionProjectRepository,
} from "../../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const mkProject = (
  projectId: string,
  workspaceRoot: string,
  deletedAt: string | null,
): ProjectionProject => ({
  projectId: ProjectId.make(projectId),
  title: projectId,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-03-24T00:00:00.000Z",
  updatedAt: "2026-03-24T00:00:00.000Z",
  deletedAt,
});

const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const makeTestLayer = () =>
  Layer.mergeAll(skillProjectsLayer, agentProjectsLayer).pipe(
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

it.effect(
  "skill listLive returns non-deleted projects keyed by ProjectId, cwd = workspaceRoot",
  () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectRepository;
      const skillProjects = yield* SkillManagerProjects;

      yield* repo.upsert(mkProject("proj-alpha", "/home/user/alpha", null));
      yield* repo.upsert(mkProject("proj-beta", "/home/user/beta", null));
      yield* repo.upsert(mkProject("proj-gone", "/home/user/gone", "2026-04-01T00:00:00.000Z"));

      const live = yield* skillProjects.listLive();

      // id = the ProjectId; cwd = the workspaceRoot (they differ); soft-deleted excluded.
      assert.deepStrictEqual([...live].sort(byId), [
        { id: "proj-alpha", cwd: "/home/user/alpha" },
        { id: "proj-beta", cwd: "/home/user/beta" },
      ]);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("skill listLive is empty only when the repo is empty (never a stub)", () =>
  Effect.gen(function* () {
    const skillProjects = yield* SkillManagerProjects;
    assert.deepStrictEqual(yield* skillProjects.listLive(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("skill getCwd resolves ProjectId → workspaceRoot; null for unknown / soft-deleted", () =>
  Effect.gen(function* () {
    const repo = yield* ProjectionProjectRepository;
    const skillProjects = yield* SkillManagerProjects;

    yield* repo.upsert(mkProject("proj-alpha", "/home/user/alpha", null));
    yield* repo.upsert(mkProject("proj-gone", "/home/user/gone", "2026-04-01T00:00:00.000Z"));

    assert.strictEqual(yield* skillProjects.getCwd("proj-alpha"), "/home/user/alpha");
    assert.strictEqual(yield* skillProjects.getCwd("proj-missing"), null);
    assert.strictEqual(yield* skillProjects.getCwd("proj-gone"), null); // soft-deleted → null
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("agent layer behaves identically (listLive + getCwd keyed by ProjectId)", () =>
  Effect.gen(function* () {
    const repo = yield* ProjectionProjectRepository;
    const agentProjects = yield* AgentManagerProjects;

    yield* repo.upsert(mkProject("proj-alpha", "/home/user/alpha", null));
    yield* repo.upsert(mkProject("proj-gone", "/home/user/gone", "2026-04-01T00:00:00.000Z"));

    assert.deepStrictEqual([...(yield* agentProjects.listLive())].sort(byId), [
      { id: "proj-alpha", cwd: "/home/user/alpha" },
    ]);
    assert.strictEqual(yield* agentProjects.getCwd("proj-alpha"), "/home/user/alpha");
    assert.strictEqual(yield* agentProjects.getCwd("proj-gone"), null);
  }).pipe(Effect.provide(makeTestLayer())),
);
