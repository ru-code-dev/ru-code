import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CLI_FOLDER, ServerConfig } from "../../../src/config.ts";
import { BUILTIN_SUBAGENTS } from "../../../src/ru-fork/subagents/builtinSubagents.ts";
import { SubagentScannerLive } from "../../../src/ru-fork/subagents/SubagentScannerLive.ts";
import { SubagentScanner } from "../../../src/ru-fork/subagents/SubagentScannerService.ts";

// Characterisation test for the SubagentScanner service: subagents are flat
// `<agents>/<name>.md` files. Verifies getSubagentsForCwd returns the always-on
// builtin bucket plus the user + project agents scanned from disk. Doubles as a
// regression guard for the "provide FileSystem|Path in make" leak fix.
it.effect("scans builtin + user + project agent files for a cwd", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "subagent-scanner-" });
      const baseDir = path.join(root, "app");
      const projectCwd = path.join(root, "project");
      const globalAgentsRoot = path.join(root, CLI_FOLDER, "agents");
      const projectAgentsRoot = path.join(projectCwd, CLI_FOLDER, "agents");

      const writeAgent = (agentsRoot: string, name: string, description: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(agentsRoot, { recursive: true });
          yield* fs.writeFileString(
            path.join(agentsRoot, `${name}.md`),
            `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
          );
        });

      yield* writeAgent(globalAgentsRoot, "global-agent", "A global agent");
      yield* writeAgent(projectAgentsRoot, "project-agent", "A project agent");

      const context = yield* Layer.build(
        SubagentScannerLive.pipe(Layer.provide(ServerConfig.layerTest(projectCwd, baseDir))),
      );
      const scanner = Context.get(context, SubagentScanner);

      const forProject = yield* scanner.getSubagentsForCwd(projectCwd);
      assert.deepEqual(forProject.builtin, BUILTIN_SUBAGENTS);
      assert.deepEqual(
        forProject.user.map((agent) => agent.name),
        ["global-agent"],
      );
      assert.equal(forProject.user[0]?.description, "A global agent");
      assert.deepEqual(
        forProject.project.map((agent) => agent.name),
        ["project-agent"],
      );

      const globalsOnly = yield* scanner.getSubagentsForCwd(null);
      assert.deepEqual(
        globalsOnly.user.map((agent) => agent.name),
        ["global-agent"],
      );
      assert.deepEqual(globalsOnly.project, []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
