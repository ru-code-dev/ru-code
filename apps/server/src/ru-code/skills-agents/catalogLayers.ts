// ru-code: host wiring for the Skills + Agents catalog services (Skills/Agents Manager).
//
// Each manager package ships a `*CatalogLayer` that requires FileSystem + Path (effect
// platform, provided at server bootstrap by PlatformServicesLive) plus two host ports:
//   - `*ManagerConfig`   — where the catalog stores/scans (paths, derived from ServerConfig)
//   - `*ManagerProjects` — which projects exist, backed by the orchestration read-model's
//                          `ProjectionProjectRepository` (self-provided below)
//
// This module builds those two port layers from the ambient `ServerConfig` (+ the read-model
// repo, which needs SqlClient), so the composed catalog layers require FileSystem + Path +
// ServerConfig + SqlClient ambiently (all satisfied where `makeWsRpcLayer` / the reactor are
// provided in ws.ts / server.ts).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProjectId } from "@t3tools/contracts";

import {
  SkillCatalogLayer,
  SkillManagerConfig,
  SkillManagerProjects,
} from "@smart-tools/qwen-cli-skill-manager/server";
import {
  AgentCatalogLayer,
  AgentManagerConfig,
  AgentManagerProjects,
} from "@smart-tools/qwen-cli-agents-manager/server";
import {
  CommandCatalogLayer,
  CommandManagerConfig,
  CommandManagerProjects,
} from "@smart-tools/qwen-cli-commands-manager/server";
import { SkillCatalogError } from "@smart-tools/qwen-cli-skill-manager/contracts";
import { AgentCatalogError } from "@smart-tools/qwen-cli-agents-manager/contracts";
import { CommandCatalogError } from "@smart-tools/qwen-cli-commands-manager/contracts";

import * as ServerConfig from "../../config.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";

// The CLI config subfolder name inside a project cwd (e.g. `<cwd>/.qwen/skills`). The CLI's
// GLOBAL config dir is `ServerConfig.cliConfigDir` (already `<home>/.qwen`), from which the
// global roots are derived; this is the per-project counterpart.
const CLI_FOLDER = ".qwen";

// ru-code: the catalog identifies a project by its stable `ProjectId` — the SAME identity the rest of
// the app uses (`thread.projectId`, the reactor, the respawn gate). That keeps one identity end-to-end
// with ZERO translation at the boundaries: the composer and the respawn gate hand the catalog a raw
// `thread.projectId` and it just matches. `listLive` enumerates every non-deleted project as
// `{id: projectId, cwd: workspaceRoot}` (id ≠ cwd), so a rescan scans each project's
// `<workspaceRoot>/.qwen` roots and tags the found origins with the `ProjectId`; `getCwd(projectId)`
// resolves the cwd via the read-model repo. WITHOUT `listLive` the catalog is global-only — a project
// connect materializes on disk but the next rescan drops the binding (`reconcileBindings` treats a
// project absent from `listLive` as non-live). The web passes `project.id` (ProjectId) as the project
// id (see hostPorts.ts). Exported for catalogProjectsLayer.test.ts so the guard drives the REAL layer.
const liveProjects = (projectRepo: ProjectionProjectRepositoryShape) =>
  projectRepo
    .listAll()
    .pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.deletedAt === null)
          .map((row) => ({ id: row.projectId as string, cwd: row.workspaceRoot })),
      ),
    );

// Resolve a project's cwd by its ProjectId (null when it does not exist / is soft-deleted).
const projectCwd = (projectRepo: ProjectionProjectRepositoryShape, projectId: string) =>
  projectRepo.getById({ projectId: ProjectId.make(projectId) }).pipe(
    Effect.map((option) => {
      const project = Option.getOrNull(option);
      return project !== null && project.deletedAt === null ? project.workspaceRoot : null;
    }),
  );

export const skillProjectsLayer = Layer.effect(
  SkillManagerProjects,
  Effect.gen(function* () {
    const projectRepo = yield* ProjectionProjectRepository;
    const failed = (cause: unknown) =>
      new SkillCatalogError({ detail: "Не удалось получить список проектов.", cause });
    return SkillManagerProjects.of({
      listLive: () => liveProjects(projectRepo).pipe(Effect.mapError(failed)),
      getCwd: (projectId) => projectCwd(projectRepo, projectId).pipe(Effect.mapError(failed)),
    });
  }),
);

export const agentProjectsLayer = Layer.effect(
  AgentManagerProjects,
  Effect.gen(function* () {
    const projectRepo = yield* ProjectionProjectRepository;
    const failed = (cause: unknown) =>
      new AgentCatalogError({ detail: "Не удалось получить список проектов.", cause });
    return AgentManagerProjects.of({
      listLive: () => liveProjects(projectRepo).pipe(Effect.mapError(failed)),
      getCwd: (projectId) => projectCwd(projectRepo, projectId).pipe(Effect.mapError(failed)),
    });
  }),
);

export const commandProjectsLayer = Layer.effect(
  CommandManagerProjects,
  Effect.gen(function* () {
    const projectRepo = yield* ProjectionProjectRepository;
    const failed = (cause: unknown) =>
      new CommandCatalogError({ detail: "Не удалось получить список проектов.", cause });
    return CommandManagerProjects.of({
      listLive: () => liveProjects(projectRepo).pipe(Effect.mapError(failed)),
      getCwd: (projectId) => projectCwd(projectRepo, projectId).pipe(Effect.mapError(failed)),
    });
  }),
);

const skillConfigLayer = Layer.effect(
  SkillManagerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return SkillManagerConfig.of({
      skillCatalogDir: path.join(config.stateDir, "skill-catalog"),
      cliConfigDir: config.cliConfigDir,
      cliFolder: CLI_FOLDER,
    });
  }),
);

const agentConfigLayer = Layer.effect(
  AgentManagerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return AgentManagerConfig.of({
      agentCatalogDir: path.join(config.stateDir, "agent-catalog"),
      cliConfigDir: config.cliConfigDir,
      cliFolder: CLI_FOLDER,
    });
  }),
);

const commandConfigLayer = Layer.effect(
  CommandManagerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return CommandManagerConfig.of({
      commandCatalogDir: path.join(config.stateDir, "command-catalog"),
      cliConfigDir: config.cliConfigDir,
      cliFolder: CLI_FOLDER,
    });
  }),
);

/** The SkillCatalog service, with its host ports provided. The projects port self-provides the
 *  read-model repo (`ProjectionProjectRepositoryLive`), so this requires FileSystem + Path +
 *  ServerConfig + SqlClient ambiently (all present where the ws rpc layer / reactor are provided). */
export const SkillCatalogHostLayer = SkillCatalogLayer.pipe(
  Layer.provide(skillConfigLayer),
  Layer.provide(skillProjectsLayer.pipe(Layer.provide(ProjectionProjectRepositoryLive))),
);

/** The AgentCatalog service, with its host ports provided. Same ambient requirements. */
export const AgentCatalogHostLayer = AgentCatalogLayer.pipe(
  Layer.provide(agentConfigLayer),
  Layer.provide(agentProjectsLayer.pipe(Layer.provide(ProjectionProjectRepositoryLive))),
);

/** The CommandCatalog service, with its host ports provided. Same ambient requirements. */
export const CommandCatalogHostLayer = CommandCatalogLayer.pipe(
  Layer.provide(commandConfigLayer),
  Layer.provide(commandProjectsLayer.pipe(Layer.provide(ProjectionProjectRepositoryLive))),
);
