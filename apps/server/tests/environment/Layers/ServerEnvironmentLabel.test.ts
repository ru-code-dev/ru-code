import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../../src/processRunner.ts";
import { resolveServerEnvironmentLabel } from "../../../src/environment/Layers/ServerEnvironmentLabel.ts";

const NoopFileSystemLayer = FileSystem.layerNoop({});

const okOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

type FakeRunHandler = (
  input: ProcessRunner.ProcessRunInput,
) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

const makeFakeRunner = (handler: FakeRunHandler) => {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const layer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) => {
        calls.push(input);
        return handler(input);
      },
    }),
  );
  return { layer, calls };
};

describe("resolveServerEnvironmentLabel", () => {
  it.effect("uses hostname fallback regardless of launch mode", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner(() => Effect.succeed(okOutput("")));
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "win32",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(Layer.mergeAll(NoopFileSystemLayer, runner.layer)));

      expect(result).toBe("macbook-pro");
      expect(runner.calls.length).toBe(0);
    }),
  );

  it.effect("prefers the macOS ComputerName", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner((input) =>
        input.command === "scutil"
          ? Effect.succeed(okOutput(" Julius's MacBook Pro \n"))
          : Effect.succeed(okOutput("")),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(Layer.mergeAll(NoopFileSystemLayer, runner.layer)));

      expect(result).toBe("Julius's MacBook Pro");
      expect(
        runner.calls.some(
          (call) => call.command === "scutil" && call.args.join(" ") === "--get ComputerName",
        ),
      ).toBe(true);
    }),
  );

  it.effect("prefers Linux PRETTY_HOSTNAME from machine-info", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner(() => Effect.succeed(okOutput("")));

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "linux",
        hostname: "buildbox",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              exists: (path) => Effect.succeed(path === "/etc/machine-info"),
              readFileString: (path) =>
                path === "/etc/machine-info"
                  ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
                  : Effect.succeed(""),
            }),
            runner.layer,
          ),
        ),
      );

      expect(result).toBe("Build Agent 01");
      expect(runner.calls.length).toBe(0);
    }),
  );

  it.effect("falls back to hostnamectl pretty hostname on Linux", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner((input) =>
        input.command === "hostnamectl"
          ? Effect.succeed(okOutput("CI Runner\n"))
          : Effect.succeed(okOutput("")),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "linux",
        hostname: "runner-01",
      }).pipe(Effect.provide(Layer.mergeAll(NoopFileSystemLayer, runner.layer)));

      expect(result).toBe("CI Runner");
      expect(
        runner.calls.some(
          (call) => call.command === "hostnamectl" && call.args.join(" ") === "--pretty",
        ),
      ).toBe(true);
    }),
  );

  it.effect("falls back to the hostname when friendly labels are unavailable", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "win32",
        hostname: "JULIUS-LAPTOP",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NoopFileSystemLayer, makeFakeRunner(() => Effect.succeed(okOutput(""))).layer),
        ),
      );

      expect(result).toBe("JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner((input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            args: input.args,
            cause: new Error("spawn scutil ENOENT"),
          }),
        ),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(Layer.mergeAll(NoopFileSystemLayer, runner.layer)));

      expect(result).toBe("macbook-pro");
    }),
  );

  it.effect("falls back to the cwd basename when the hostname is blank", () =>
    Effect.gen(function* () {
      const runner = makeFakeRunner((input) =>
        input.command === "hostnamectl"
          ? Effect.succeed(okOutput(" "))
          : Effect.succeed(okOutput("")),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "ru-fork",
        platform: "linux",
        hostname: "   ",
      }).pipe(Effect.provide(Layer.mergeAll(NoopFileSystemLayer, runner.layer)));

      expect(result).toBe("ru-fork");
    }),
  );
});
