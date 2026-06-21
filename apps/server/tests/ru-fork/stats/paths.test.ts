import { assert, it } from "@effect/vitest";
import * as os from "node:os";
import * as path from "node:path";

import { isTempCwd, projectLabelFor, resolveProjectsRoot } from "../../../src/ru-fork/stats/paths.ts";

it("uses QWEN_RUNTIME_DIR when set", () => {
  const root = resolveProjectsRoot({ env: { QWEN_RUNTIME_DIR: "/custom/runtime" }, cliConfigDir: "/ignored" });
  assert.equal(root, path.join("/custom/runtime", "projects"));
});

it("expands a tilde in QWEN_RUNTIME_DIR", () => {
  const root = resolveProjectsRoot({ env: { QWEN_RUNTIME_DIR: "~/rt" }, cliConfigDir: "/ignored" });
  assert.equal(root, path.join(os.homedir(), "rt", "projects"));
});

it("falls back to cliConfigDir when no env override", () => {
  const root = resolveProjectsRoot({ env: {}, cliConfigDir: "/home/u/.qwen" });
  assert.equal(root, path.join("/home/u/.qwen", "projects"));
});

it("ignores a blank QWEN_RUNTIME_DIR", () => {
  const root = resolveProjectsRoot({ env: { QWEN_RUNTIME_DIR: "   " }, cliConfigDir: "/home/u/.qwen" });
  assert.equal(root, path.join("/home/u/.qwen", "projects"));
});

it("detects temp/sandbox cwds", () => {
  assert.isTrue(isTempCwd("/var/folders/41/T/acp-test"));
  assert.isTrue(isTempCwd("/private/var/folders/x/T/y"));
  assert.isTrue(isTempCwd("/tmp/scratch"));
  assert.isFalse(isTempCwd("/Users/u/WORKSPACE/Projects/app"));
});

it("labels a cwd by its last path segment", () => {
  assert.equal(projectLabelFor("/Users/u/WORKSPACE/Projects/app"), "app");
  assert.equal(projectLabelFor("/Users/u/WORKSPACE/Projects/app/"), "app");
});
