// ru-code: the pre-made starter project's folder name + workspace-root helper.
// The literal must stay "Project" so it matches the folder the install script
// creates and auto-registers on startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveStarterProjectRoot,
  STARTER_PROJECT_DIRNAME,
} from "../../startup/starterProject.ts";

describe("starter project", () => {
  it("pins the folder name to 'Project'", () => {
    expect(STARTER_PROJECT_DIRNAME).toBe("Project");
  });

  it("joins <baseDir>/Project with the supplied joiner", () => {
    expect(resolveStarterProjectRoot("/home/u/.ru-code", NodePath.join)).toBe(
      NodePath.join("/home/u/.ru-code", "Project"),
    );
  });
});
