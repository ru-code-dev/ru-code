// ru-code: END-TO-END proof of worktree provisioning through the gate the reactor calls.
// qwen reads project skills/agents/commands from `<cwd>/.qwen/*` at spawn; when a thread's
// cwd is a git WORKTREE those dirs never receive catalog writes — the reactor therefore
// calls `SessionRespawnGate.provisionWorktree(threadId, projectId, cwd)` right before every
// (re)spawn. This test drives the REAL Skill + Agent + Command catalog engines (real
// filesystem, real in-memory project repo) through the REAL gate method and asserts the
// exact on-disk contract the spawned CLI depends on:
//   • a project skill/agent/command is mirrored into `<worktree>/.qwen/{skills,agents,commands}`
//   • a GLOBAL item is NOT mirrored (worktree sessions read globals from CLI_HOME)
//   • calling with the project's OWN cwd is a guarded no-op (never touches the main checkout)
//   • a disconnected item's mirror is removed on the next pass (namespace dirs pruned)
//   • a hand-edited mirror is repaired back to the main copy (app-owned artifacts)
//   • null projectId / null cwd are quiet no-ops (the gate never fails a spawn)

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
    const stateDir = yield* fs.makeTempDirectory();
    const home = yield* fs.makeTempDirectory();
    return { stateDir, cliConfigDir: path.join(home, ".qwen") } as never;
  }),
);

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

it.effect(
  "provisionWorktree mirrors project items into a worktree, repairs, prunes, never touches main",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* ProjectionProjectRepository;
      const skills = yield* SkillCatalog;
      const agents = yield* AgentCatalog;
      const commands = yield* CommandCatalog;
      const gate = yield* SessionRespawnGate;

      const projectRoot = yield* fs.makeTempDirectory();
      const worktree = yield* fs.makeTempDirectory();
      const PID = "11111111-1111-1111-1111-111111111111";
      yield* repo.upsert(mkProject(PID, projectRoot));
      const thread = "thread-1";

      // Connect one of each to THIS project + one GLOBAL skill (must not be mirrored).
      const skill = yield* skills.add({ files: skillFiles("mirror-skill") });
      yield* skills.connect({ id: skill.id, target: { scope: "project", projectId: PID } });
      const agent = yield* agents.add({ files: agentFiles("mirror-agent") });
      yield* agents.connect({ id: agent.id, target: { scope: "project", projectId: PID } });
      const command = yield* commands.add({
        files: commandFiles("deploy"),
        identity: { name: "ns:deploy", description: "deploy command" },
      });
      yield* commands.connect({ id: command.id, target: { scope: "project", projectId: PID } });
      const globalSkill = yield* skills.add({ files: skillFiles("global-skill") });
      yield* skills.connect({ id: globalSkill.id, target: { scope: "global" } });

      // 1) Provision the worktree — the exact dirs the spawned CLI reads must appear.
      yield* gate.provisionWorktree(thread, PID, worktree);
      const skillMirror = path.join(worktree, ".qwen", "skills", skill.id, "SKILL.md");
      const agentMirror = path.join(worktree, ".qwen", "agents", `${agent.id}.md`);
      const commandMirror = path.join(worktree, ".qwen", "commands", "ns", "deploy.toml");
      assert.equal(
        yield* fs.readFileString(skillMirror),
        skillFiles("mirror-skill")[0]!.text,
        "project skill mirrored",
      );
      assert.equal(
        yield* fs.readFileString(agentMirror),
        agentFiles("mirror-agent")[0]!.text,
        "project agent mirrored",
      );
      assert.equal(
        yield* fs.readFileString(commandMirror),
        commandFiles("deploy")[0]!.text,
        "namespaced project command mirrored at its path identity",
      );
      assert.isFalse(
        yield* fs.exists(path.join(worktree, ".qwen", "skills", globalSkill.id)),
        "GLOBAL skill not mirrored (CLI reads globals from CLI_HOME)",
      );

      // 1b) EXECUTABLE "0 UI changes": a full rescan must NOT discover the mirrors — worktree
      // roots are not provider roots, so no new origin (and no divergence flag) can ever reach
      // the panel or the composer because of provisioning.
      const rescannedSkill = (yield* skills.rescan()).find((row) => row.id === skill.id)!;
      assert.equal(rescannedSkill.origins.length, 1, "still exactly the one PROJECT origin");
      assert.isFalse(
        rescannedSkill.origins.some((origin) => origin.path.startsWith(worktree)),
        "no worktree-path origin ever appears",
      );
      assert.isFalse(rescannedSkill.diverged, "mirrors can never flag divergence");
      const rescannedCommand = (yield* commands.rescan()).find((row) => row.id === command.id)!;
      assert.equal(rescannedCommand.origins.length, 1);
      assert.isFalse(rescannedCommand.origins.some((origin) => origin.path.startsWith(worktree)));

      // 2) The project's OWN cwd is a guarded no-op — no manifest lands in the main checkout.
      yield* gate.provisionWorktree(thread, PID, projectRoot);
      assert.isFalse(
        yield* fs.exists(path.join(projectRoot, ".qwen", "skills", ".ru-code-provisioned.json")),
        "main checkout never gets a provisioning manifest",
      );

      // 3) A hand-edited mirror is an app-owned artifact — repaired on the next pass, and the
      // tampering never reaches the catalog either (rescan stays clean while it exists).
      yield* fs.writeFileString(agentMirror, "tampered\n");
      const agentWhileTampered = (yield* agents.rescan()).find((row) => row.id === agent.id)!;
      assert.isFalse(agentWhileTampered.diverged, "a tampered MIRROR never flags divergence");
      yield* gate.provisionWorktree(thread, PID, worktree);
      assert.equal(
        yield* fs.readFileString(agentMirror),
        agentFiles("mirror-agent")[0]!.text,
        "tampered agent mirror repaired",
      );

      // 4) Disconnecting the source removes the mirror and prunes the namespace dir.
      const commandRow = (yield* commands.getSnapshot()).find((row) => row.id === command.id)!;
      const commandHash = commandRow.origins.find((origin) => origin.scope === "project")!.hash;
      yield* commands.delete({
        id: command.id,
        target: { scope: "project", projectId: PID },
        expectedHash: commandHash,
      });
      yield* gate.provisionWorktree(thread, PID, worktree);
      assert.isFalse(yield* fs.exists(commandMirror), "disconnected command mirror removed");
      assert.isFalse(
        yield* fs.exists(path.join(worktree, ".qwen", "commands", "ns")),
        "emptied namespace dir pruned",
      );
      assert.isTrue(yield* fs.exists(skillMirror), "other mirrors untouched by cleanup");

      // 5) The gate never fails a spawn: no project / no cwd are quiet no-ops.
      yield* gate.provisionWorktree(thread, null, worktree);
      yield* gate.provisionWorktree(thread, PID, null);
    }).pipe(Effect.provide(testLayer)),
);
