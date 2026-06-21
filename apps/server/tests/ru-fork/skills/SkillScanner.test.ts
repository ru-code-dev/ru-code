import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CLI_FOLDER, ServerConfig } from "../../../src/config.ts";
import { SkillScannerLive } from "../../../src/ru-fork/skills/SkillScannerLive.ts";
import { SkillScanner } from "../../../src/ru-fork/skills/SkillScannerService.ts";

// Characterisation test for the SkillScanner service: builds a real temp skills
// tree on disk and verifies getSkillsForCwd returns the global + project skills
// (and globals-only for cwd=null). Doubles as a regression guard for the
// "provide FileSystem|Path in make" leak fix — the method's env must stay
// internal without changing observable behaviour.
it.effect("scans global + project SKILL.md files, and globals-only for cwd=null", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-scanner-" });
      // ServerConfig.layerTest derives cliConfigDir = dirname(baseDir)/CLI_FOLDER,
      // so global skills resolve under <root>/<CLI_FOLDER>/skills.
      const baseDir = path.join(root, "app");
      const projectCwd = path.join(root, "project");
      const globalSkillsRoot = path.join(root, CLI_FOLDER, "skills");
      const projectSkillsRoot = path.join(projectCwd, CLI_FOLDER, "skills");

      const writeSkill = (skillsRoot: string, name: string, description: string) =>
        Effect.gen(function* () {
          const dir = path.join(skillsRoot, name);
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(
            path.join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
          );
        });

      yield* writeSkill(globalSkillsRoot, "global-skill", "A global skill");
      yield* writeSkill(projectSkillsRoot, "project-skill", "A project skill");

      const context = yield* Layer.build(
        SkillScannerLive.pipe(Layer.provide(ServerConfig.layerTest(projectCwd, baseDir))),
      );
      const scanner = Context.get(context, SkillScanner);

      const forProject = yield* scanner.getSkillsForCwd(projectCwd);
      assert.deepEqual(
        forProject.global.map((skill) => skill.name),
        ["global-skill"],
      );
      assert.equal(forProject.global[0]?.description, "A global skill");
      assert.deepEqual(
        forProject.project.map((skill) => skill.name),
        ["project-skill"],
      );

      const globalsOnly = yield* scanner.getSkillsForCwd(null);
      assert.deepEqual(
        globalsOnly.global.map((skill) => skill.name),
        ["global-skill"],
      );
      assert.deepEqual(globalsOnly.project, []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
