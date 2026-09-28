// ru-code (S99): the MCP_INJECT_BLOCKING_ENV switch ON — `QWEN_CODE_LEGACY_MCP_BLOCKING=1` on EVERY
// `--acp` spawn (cold and warm slot alike build their recipe in buildQwenAcpSpawnInput, with or
// without an MCP overlay) and on NO other qwen spawn: the `-p` text generation and the `--version`
// provider probe (the preflight probe and the installer warm-up are pinned in their own suites).
// Own file because the switch is a module constant, flipped by vi.mock at module scope — the
// switch-off half is in QwenAcpSupport.test.ts. Names derive from the registry (cliEnv.ts).
import { describe, expect, it } from "@effect/vitest";
import { CLI_ENV } from "@ru-code/branding";
import { ModelSelection, QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

vi.mock("../../qwen/acpSwitches.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../qwen/acpSwitches.ts")>();
  return { ...actual, MCP_INJECT_BLOCKING_ENV: true };
});

import { buildQwenAcpSpawnInput } from "../../qwen/QwenAcpSupport.ts";
import { checkQwenProviderStatus } from "../../qwen/QwenProvider.ts";
import { makeQwenTextGeneration } from "../../qwen/QwenTextGeneration.ts";
import { clearVersionProbeCacheForTests } from "../../qwen/versionProbeCache.ts";

const HOME_DIR = "/home/me/.qwen";
const BLOCKING = CLI_ENV.LEGACY_MCP_BLOCKING.names;
const SETTINGS = Schema.decodeSync(QwenSettings)({});
const MODEL_SELECTION = Schema.decodeSync(ModelSelection)({
  instanceId: "qwen",
  model: "qwen3-coder-plus",
});

/** A spawner that records every spawn's env, with canned output. */
const capturingSpawner = (stdout: string) => {
  const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") envs.push(command.options.env);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { envs, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

describe("MCP_INJECT_BLOCKING_ENV on", () => {
  it("every --acp spawn carries QWEN_CODE_LEGACY_MCP_BLOCKING=1 — with an overlay or none", () => {
    for (const spawn of [
      // a generic warm spare / a project without MCP: no overlay, the `__none__` allowlist
      buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work"),
      // an MCP project, cold or its warm slot
      buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
        settingsOverlayPath: "/tmp/overlay.json",
        allowedMcpServers: ["alpha"],
      }),
    ]) {
      expect(spawn.args.at(-1)).toBe("--acp");
      for (const name of BLOCKING) expect(spawn.env?.[name], name).toBe("1");
    }
  });

  it.effect("the -p text generation spawn never carries it", () =>
    Effect.gen(function* () {
      const { envs, layer } = capturingSpawner('[{"type":"result","result":"Заголовок"}]');
      yield* makeQwenTextGeneration("/fake/cli.js", HOME_DIR, SETTINGS, {}).pipe(
        Effect.provide(layer),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "q", modelSelection: MODEL_SELECTION }),
        ),
      );
      expect(envs).toHaveLength(1);
      for (const name of BLOCKING) expect(envs[0]?.[name], name).toBeUndefined();
    }),
  );

  it.effect("the --version provider probe never carries it", () =>
    Effect.gen(function* () {
      clearVersionProbeCacheForTests();
      const { envs, layer } = capturingSpawner("0.21.1\n");
      yield* checkQwenProviderStatus("/fake/cli.js", HOME_DIR, SETTINGS, "Qwen Code", {}).pipe(
        Effect.provide(layer),
      );
      expect(envs).toHaveLength(1);
      for (const name of BLOCKING) expect(envs[0]?.[name], name).toBeUndefined();
    }),
  );
});
