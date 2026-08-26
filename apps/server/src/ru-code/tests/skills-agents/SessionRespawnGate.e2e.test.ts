// ru-code: END-TO-END proof of the respawn decision the reactor depends on. Drives the REAL Skill +
// Agent catalog engines (real filesystem, real in-memory project repo) through the REAL
// SessionRespawnGate and asserts `changedForThread(thread, projectId)` — the exact value the reactor
// OR's into its restart choice — flips for every source that must respawn a live `qwen --acp` session:
//   • a skill connected to THIS thread's project        → respawn
//   • an AGENT (subagent) connected to this project      → respawn
//   • a GLOBAL skill (affects every project)             → respawn
//   • a skill connected to a DIFFERENT project           → NO respawn (per-project isolation, ProjectId)
//   • nothing changed since the last spawn               → NO respawn
// This is what ties the ProjectId-keyed catalog to the reactor: the gate is fed the raw
// `thread.projectId` and it must match the project's bindings with zero translation.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { SkillCatalog } from "@smart-tools/qwen-cli-skill-manager/server";
import { AgentCatalog } from "@smart-tools/qwen-cli-agents-manager/server";
import { CommandCatalog } from "@smart-tools/qwen-cli-commands-manager/server";

import {
  SkillCatalogHostLayer,
  AgentCatalogHostLayer,
  CommandCatalogHostLayer,
} from "../../skills-agents/catalogLayers.ts";
import {
  SessionRespawnGate,
  SessionRespawnGateLive,
} from "../../skills-agents/SessionRespawnGate.ts";
import {
  ProjectionProject,
  ProjectionProjectRepository,
} from "../../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../../config.ts";

const skillFiles = (name: string) => [
  { relPath: "SKILL.md", text: `---\nname: ${name}\ndescription: ${name} skill\n---\nbody` },
];
const agentFiles = (name: string) => [
  { relPath: "AGENT.md", text: `---\nname: ${name}\ndescription: ${name} agent\n---\nbody` },
];
// Pure qwen command TOML — identity is the on-disk path (passed as `identity` on add), never a
// field in the file.
const commandFiles = (name: string) => [
  { relPath: "COMMAND.toml", text: `description = "${name} command"\nprompt = "do ${name}"\n` },
];

const mkProject = (projectId: string, workspaceRoot: string): ProjectionProject => ({
  projectId: ProjectId.make(projectId),
  title: projectId,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-03-24T00:00:00.000Z",
  updatedAt: "2026-03-24T00:00:00.000Z",
  deletedAt: null,
});

// Real catalog state dirs in a fresh temp location per run; the CLI global dir is <home>/.qwen.
const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "ru-session-respawn-state-" });
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "ru-session-respawn-home-" });
    return { stateDir, cliConfigDir: path.join(home, ".qwen") } as never;
  }),
);

// The gate under test + the catalog services (to drive) + the repo (to seed projects), all sharing one
// SqlClient and one set of state dirs (filesystem is truth, so separate engine instances stay in sync).
const testLayer = Layer.mergeAll(
  SessionRespawnGateLive,
  SkillCatalogHostLayer,
  AgentCatalogHostLayer,
  CommandCatalogHostLayer,
  ProjectionProjectRepositoryLive,
).pipe(
  Layer.provide(configLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("changedForThread flips for skills, agents, and globals — but not another project", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* ProjectionProjectRepository;
    const skills = yield* SkillCatalog;
    const agents = yield* AgentCatalog;
    const commands = yield* CommandCatalog;
    const gate = yield* SessionRespawnGate;

    const projectRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "ru-session-respawn-project-",
    });
    const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ru-session-respawn-other-" });
    const PID = "11111111-1111-1111-1111-111111111111";
    const OTHER_PID = "22222222-2222-2222-2222-222222222222";
    yield* repo.upsert(mkProject(PID, projectRoot));
    yield* repo.upsert(mkProject(OTHER_PID, otherRoot));

    const thread = "thread-1";

    // Baseline: nothing connected → recording, then re-checking, sees no change.
    yield* gate.record(thread, PID);
    assert.isFalse(yield* gate.changedForThread(thread, PID), "empty baseline is unchanged");

    // 1) a skill connected to THIS project must respawn.
    const alpha = yield* skills.add({ files: skillFiles("alpha") });
    yield* skills.connect({ id: alpha.id, target: { scope: "project", projectId: PID } });
    assert.isTrue(yield* gate.changedForThread(thread, PID), "project skill add → respawn");

    // …and once recorded, an unchanged turn does NOT respawn.
    yield* gate.record(thread, PID);
    assert.isFalse(yield* gate.changedForThread(thread, PID), "no change → no respawn");

    // 2) a subagent connected to this project must respawn.
    const scout = yield* agents.add({ files: agentFiles("scout") });
    yield* agents.connect({ id: scout.id, target: { scope: "project", projectId: PID } });
    assert.isTrue(yield* gate.changedForThread(thread, PID), "project agent add → respawn");
    yield* gate.record(thread, PID);

    // 3) a GLOBAL skill (inherited by every project) must respawn.
    const helper = yield* skills.add({ files: skillFiles("global-helper") });
    yield* skills.connect({ id: helper.id, target: { scope: "global" } });
    assert.isTrue(yield* gate.changedForThread(thread, PID), "global skill add → respawn");
    yield* gate.record(thread, PID);

    // 3b) a custom COMMAND connected to this project must respawn (qwen reads commands at spawn too).
    const deploy = yield* commands.add({
      files: commandFiles("deploy"),
      identity: { name: "deploy", description: "deploy command" },
    });
    yield* commands.connect({ id: deploy.id, target: { scope: "project", projectId: PID } });
    assert.isTrue(yield* gate.changedForThread(thread, PID), "project command add → respawn");
    yield* gate.record(thread, PID);

    // 4) a skill connected to a DIFFERENT project must NOT respawn this thread (ProjectId isolation).
    const beta = yield* skills.add({ files: skillFiles("beta") });
    yield* skills.connect({ id: beta.id, target: { scope: "project", projectId: OTHER_PID } });
    assert.isFalse(
      yield* gate.changedForThread(thread, PID),
      "another project's skill → no respawn here",
    );
  }).pipe(Effect.provide(testLayer)),
);
