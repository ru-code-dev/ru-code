// ru-code: per-site registry pins for the two NON-ACP qwen spawn sites — one-shot `-p` text
// generation and the app's `--version` provider probe — plus the homePath→CLI-home feed.
//
// Both sites used to hand-roll (or simply omit) their spawn env. They now draw it from the ONE
// branding registry, so every expectation below is DERIVED from cliEnvAssignments/cliArgAssignments
// rather than written out: adding a row to cliEnv.ts must make these spawns carry it, with no edit
// here. The concrete names live in cliEnv.ts + the single literal snapshot (cliEnvRegistry.test.ts).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { beforeEach, describe, expect, it } from "@effect/vitest";
import {
  CLI_ENV,
  cliArgAssignments,
  cliEnvAssignments,
  resolveCliProfile,
} from "@ru-code/branding";
import { ModelSelection, QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../../pathExpansion.ts";
import { buildCliEnv, resolveCliProfileSettings } from "../../qwen/profileResolver.ts";
import { checkQwenProviderStatus } from "../../qwen/QwenProvider.ts";
import { makeQwenTextGeneration } from "../../qwen/QwenTextGeneration.ts";
import { clearVersionProbeCacheForTests } from "../../qwen/versionProbeCache.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const decodeModelSelection = Schema.decodeSync(ModelSelection);

const SETTINGS = decodeQwenSettings({});
const MODEL_SELECTION = decodeModelSelection({ instanceId: "qwen", model: "qwen3-coder-plus" });
const LABEL = "Qwen Code";
const HOME_DIR = "/home/me/.qwen";

/** Every pair a spawn with this home dir must carry (no ACP overlay ⇒ no settings path row). */
const enforcedPairs = cliEnvAssignments({ HOME: HOME_DIR });

interface Recipe {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
}

/** A spawner that records the full recipe (argv AND env) of every spawn, with canned output. */
const capturingSpawner = (out: { stdout?: string; stderr?: string; code?: number }) => {
  const recipes: Array<Recipe> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      recipes.push({ command: command.command, args: [...command.args], env: command.options.env });
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(out.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(out.stdout ?? "")),
        stderr: Stream.encodeText(Stream.make(out.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { recipes, spawner };
};

const provide = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

/** True when `needle` appears as a contiguous run inside `haystack`. */
const containsRun = (haystack: ReadonlyArray<string>, needle: ReadonlyArray<string>): boolean =>
  needle.length === 0 ||
  haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));

const assertEnforcedEnv = (recipe: Recipe, pairs = enforcedPairs): void => {
  for (const [name, value] of pairs) {
    expect(recipe.env?.[name], `enforced ${name}`).toBe(value);
  }
};

// ── one-shot text generation (`-p`) ──────────────────────────────────────────────────────────
describe("qwen text generation spawn draws its env + flags from the registry", () => {
  const resultEnvelope = JSON.stringify([{ type: "result", result: "Заголовок" }]);

  it.effect("carries every enforced assignment, including the CLI home dir", () =>
    Effect.gen(function* () {
      const { recipes, spawner } = capturingSpawner({ stdout: resultEnvelope });
      yield* makeQwenTextGeneration("/fake/cli.js", HOME_DIR, SETTINGS, {}).pipe(
        Effect.provide(provide(spawner)),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({
            cwd: "/repo",
            message: "первый вопрос",
            modelSelection: MODEL_SELECTION,
          }),
        ),
      );
      expect(recipes.length).toBe(1);
      assertEnforcedEnv(recipes[0]!);
      for (const name of CLI_ENV.HOME.names) expect(recipes[0]!.env?.[name]).toBe(HOME_DIR);
    }),
  );

  // A one-shot run has no ACP overlay, so the runtime-only row must not appear at all.
  it.effect("emits no system-settings alias (a `-p` run has no overlay)", () =>
    Effect.gen(function* () {
      const { recipes, spawner } = capturingSpawner({ stdout: resultEnvelope });
      yield* makeQwenTextGeneration("/fake/cli.js", HOME_DIR, SETTINGS, {}).pipe(
        Effect.provide(provide(spawner)),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "q", modelSelection: MODEL_SELECTION }),
        ),
      );
      for (const name of CLI_ENV.SYSTEM_SETTINGS_PATH.names) {
        expect(recipes[0]!.env?.[name], `${name} absent`).toBeUndefined();
      }
    }),
  );

  it.effect("carries the registry's shared CLI flags in its argv", () =>
    Effect.gen(function* () {
      const { recipes, spawner } = capturingSpawner({ stdout: resultEnvelope });
      yield* makeQwenTextGeneration("/fake/cli.js", HOME_DIR, SETTINGS, {}).pipe(
        Effect.provide(provide(spawner)),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "q", modelSelection: MODEL_SELECTION }),
        ),
      );
      expect(containsRun(recipes[0]!.args, cliArgAssignments()), "arg assignments present").toBe(
        true,
      );
    }),
  );

  // Enforced vars are policy: a per-instance environment variable must not talk one down.
  it.effect("defeats an inherited environment that tries to override an enforced var", () =>
    Effect.gen(function* () {
      const sabotage: NodeJS.ProcessEnv = {};
      for (const [name] of enforcedPairs) sabotage[name] = "sabotage";
      const { recipes, spawner } = capturingSpawner({ stdout: resultEnvelope });
      yield* makeQwenTextGeneration("/fake/cli.js", HOME_DIR, SETTINGS, sabotage).pipe(
        Effect.provide(provide(spawner)),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "q", modelSelection: MODEL_SELECTION }),
        ),
      );
      assertEnforcedEnv(recipes[0]!);
    }),
  );
});

// ── the app's `--version` provider probe ─────────────────────────────────────────────────────
describe("qwen version probe spawn draws its env + flags from the registry", () => {
  beforeEach(() => {
    clearVersionProbeCacheForTests();
  });

  it.effect("carries every enforced assignment, including the CLI home dir", () =>
    Effect.gen(function* () {
      const { recipes, spawner } = capturingSpawner({ stdout: "1.2.3\n", code: 0 });
      yield* checkQwenProviderStatus("/fake/cli.js", HOME_DIR, SETTINGS, LABEL, {}).pipe(
        Effect.provide(provide(spawner)),
      );
      expect(recipes.length).toBe(1);
      assertEnforcedEnv(recipes[0]!);
      for (const name of CLI_ENV.HOME.names) expect(recipes[0]!.env?.[name]).toBe(HOME_DIR);
    }),
  );

  // A probe is never an MCP client: the mcp-off flag rides along unconditionally, and `--version`
  // stays the FIRST argument after the cli.js path (yargs answers it before anything else).
  it.effect("puts --version first and appends the registry's shared flags", () =>
    Effect.gen(function* () {
      const { recipes, spawner } = capturingSpawner({ stdout: "1.2.3\n", code: 0 });
      yield* checkQwenProviderStatus("/fake/cli.js", HOME_DIR, SETTINGS, LABEL, {}).pipe(
        Effect.provide(provide(spawner)),
      );
      const args = recipes[0]!.args;
      expect(args).toEqual(["/fake/cli.js", "--version", ...cliArgAssignments()]);
    }),
  );
});

// ── the per-instance homePath feed ───────────────────────────────────────────────────────────
describe("the instance's homePath feeds the CLI home var", () => {
  const PREFLIGHT = { cliJs: "/preflight/cli.js", cliConfigDir: "/preflight/.qwen" };
  const homeVar = (env: NodeJS.ProcessEnv): string | undefined =>
    env[CLI_ENV.HOME.names[0] as string];

  it("uses the per-instance homePath override, expanded", () => {
    const settings = decodeQwenSettings({ homePath: "~/.qwen-work" });
    const resolved = resolveCliProfileSettings(settings, PREFLIGHT);
    const env = buildCliEnv({}, { homeDir: resolved.dir });
    const expected = NodePath.join(NodeOS.homedir(), ".qwen-work");
    for (const name of CLI_ENV.HOME.names) expect(env[name]).toBe(expected);
    expect(homeVar(env)).not.toContain("~");
  });

  it("falls back to the profile default (expanded) when no override is set", () => {
    const resolved = resolveCliProfileSettings(decodeQwenSettings({}), PREFLIGHT);
    const env = buildCliEnv({}, { homeDir: resolved.dir });
    const dirDefault = resolveCliProfile(undefined).dirDefault;
    const expected = expandHomePath(dirDefault ?? PREFLIGHT.cliConfigDir);
    for (const name of CLI_ENV.HOME.names) expect(env[name]).toBe(expected);
    // A literal `~` reaching the CLI is the bug this pin exists for.
    expect(homeVar(env)?.startsWith("~")).toBe(false);
  });

  it("falls back to the boot preflight dir when the profile has no default", () => {
    // A profile whose dirDefault is null resolves to the preflight-detected dir.
    const resolved = resolveCliProfileSettings(decodeQwenSettings({}), PREFLIGHT);
    const dirDefault = resolveCliProfile(undefined).dirDefault;
    if (dirDefault === null || dirDefault === undefined) {
      expect(resolved.dir).toBe(PREFLIGHT.cliConfigDir);
      const env = buildCliEnv({}, { homeDir: resolved.dir });
      for (const name of CLI_ENV.HOME.names) expect(env[name]).toBe(PREFLIGHT.cliConfigDir);
    } else {
      // The stock profile pins its own dir; prove the preflight fallback on the raw builder.
      const env = buildCliEnv({}, { homeDir: PREFLIGHT.cliConfigDir });
      for (const name of CLI_ENV.HOME.names) expect(env[name]).toBe(PREFLIGHT.cliConfigDir);
    }
  });
});
