import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  pickRuntimeOutputDir,
  readRuntimeOutputDirOverride,
} from "../../../src/ru-fork/qwen-transcript/cliSettings.ts";

describe("pickRuntimeOutputDir", () => {
  it("returns the string value", () => {
    expect(pickRuntimeOutputDir({ advanced: { runtimeOutputDir: "/x" } })).toBe("/x");
  });
  it("returns undefined when advanced is missing", () => {
    expect(pickRuntimeOutputDir({})).toBeUndefined();
  });
  it("returns undefined when runtimeOutputDir is missing", () => {
    expect(pickRuntimeOutputDir({ advanced: {} })).toBeUndefined();
  });
  it("returns undefined for non-object input", () => {
    expect(pickRuntimeOutputDir(null)).toBeUndefined();
    expect(pickRuntimeOutputDir("str")).toBeUndefined();
    expect(pickRuntimeOutputDir({ advanced: 5 })).toBeUndefined();
  });
  it("returns undefined for an empty/whitespace value", () => {
    expect(pickRuntimeOutputDir({ advanced: { runtimeOutputDir: "   " } })).toBeUndefined();
  });
});

const writeSettings = (dir: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "settings.json"), content);
  });

it.layer(NodeServices.layer)("readRuntimeOutputDirOverride", (it) => {
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-settings-" });
    const cliConfigDir = path.join(root, "global");
    const cwd = path.join(root, "cwd");
    return { fs, path, cliConfigDir, cwd };
  });

  it.effect("reads the global setting", () =>
    Effect.gen(function* () {
      const { fs, path, cliConfigDir, cwd } = yield* setup;
      yield* writeSettings(cliConfigDir, JSON.stringify({ advanced: { runtimeOutputDir: "/g" } }));
      const result = yield* readRuntimeOutputDirOverride(fs, path, cliConfigDir, cwd);
      expect(result).toBe("/g");
    }),
  );

  it.effect("reads the workspace setting", () =>
    Effect.gen(function* () {
      const { fs, path, cliConfigDir, cwd } = yield* setup;
      yield* writeSettings(path.join(cwd, ".qwen"), JSON.stringify({ advanced: { runtimeOutputDir: "/w" } }));
      const result = yield* readRuntimeOutputDirOverride(fs, path, cliConfigDir, cwd);
      expect(result).toBe("/w");
    }),
  );

  it.effect("workspace overrides global", () =>
    Effect.gen(function* () {
      const { fs, path, cliConfigDir, cwd } = yield* setup;
      yield* writeSettings(cliConfigDir, JSON.stringify({ advanced: { runtimeOutputDir: "/g" } }));
      yield* writeSettings(path.join(cwd, ".qwen"), JSON.stringify({ advanced: { runtimeOutputDir: "/w" } }));
      const result = yield* readRuntimeOutputDirOverride(fs, path, cliConfigDir, cwd);
      expect(result).toBe("/w");
    }),
  );

  it.effect("returns undefined when neither file exists", () =>
    Effect.gen(function* () {
      const { fs, path, cliConfigDir, cwd } = yield* setup;
      const result = yield* readRuntimeOutputDirOverride(fs, path, cliConfigDir, cwd);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("treats malformed JSON as undefined", () =>
    Effect.gen(function* () {
      const { fs, path, cliConfigDir, cwd } = yield* setup;
      yield* writeSettings(cliConfigDir, "{not json");
      const result = yield* readRuntimeOutputDirOverride(fs, path, cliConfigDir, cwd);
      expect(result).toBeUndefined();
    }),
  );
});
