// @effect-diagnostics preferSchemaOverJson:off
// ru-code: end-to-end coverage for makeQwenTextGeneration driven by a canned
// ChildProcessSpawner. Exercises the real pipeline — Qwen `--output-format json`
// envelope extraction, JSON-object peeling + schema decode (commit / PR), the
// single-string sanitizers (branch / thread title), and the non-zero-exit
// failure path — without spawning a real process. The module's private helpers
// (extractQwenResultText, buildQwenSingleStringPrompt) are not exported, so they
// are covered here through the public generate* surface.
import { describe, expect, it } from "@effect/vitest";
import { NO_MCP_SERVER_SENTINEL } from "@ru-code/qwen/constants";
import { ModelSelection, QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeQwenTextGeneration } from "../../qwen/QwenTextGeneration.ts";
import type { TextGenerationShape } from "../../../textGeneration/TextGeneration.ts";

// Hoist the compiled decoders to module scope (no per-call recompile).
const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const decodeModelSelection = Schema.decodeSync(ModelSelection);

const SETTINGS = decodeQwenSettings({});
const MODEL_SELECTION = decodeModelSelection({
  instanceId: "qwen",
  model: "qwen3-coder-plus",
});

const cannedHandle = (out: { stdout?: string; stderr?: string; code?: number }) =>
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
  });

const cannedSpawner = (out: { stdout?: string; stderr?: string; code?: number }) =>
  ChildProcessSpawner.make(() => Effect.succeed(cannedHandle(out)));

/**
 * A spawner that records the argv of every spawned command, so tests can assert
 * the exact `qwen -p …` flags (the ru-code `--model`/`--auth-type` wiring).
 */
const capturingSpawner = (out: { stdout?: string; stderr?: string; code?: number }) => {
  const argvs: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      argvs.push([command.command, ...command.args]);
    }
    return Effect.succeed(cannedHandle(out));
  });
  return { argvs, spawner };
};

const program = <A, E>(
  out: { stdout?: string; stderr?: string; code?: number },
  use: (tg: TextGenerationShape) => Effect.Effect<A, E>,
) =>
  makeQwenTextGeneration("/fake/cli.js", SETTINGS, {}).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cannedSpawner(out)),
    Effect.flatMap(use),
  );

/** Wrap a plain reply string in Qwen's `result` envelope message. */
const resultEnvelope = (result: string) => JSON.stringify([{ type: "result", result }]);
/** Wrap a plain reply string in the assistant-content fallback envelope. */
const assistantEnvelope = (text: string) =>
  JSON.stringify([{ type: "assistant", message: { content: [{ type: "text", text }] } }]);

describe("makeQwenTextGeneration.generateThreadTitle", () => {
  it.effect("extracts and sanitizes the result-envelope reply", () =>
    Effect.gen(function* () {
      const out = yield* program({ stdout: resultEnvelope("  Заголовок треда  ") }, (tg) =>
        tg.generateThreadTitle({
          cwd: "/repo",
          message: "первый вопрос",
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.title).toBe("Заголовок треда");
    }),
  );

  it.effect("falls back to assistant content when no result message is present", () =>
    Effect.gen(function* () {
      const out = yield* program({ stdout: assistantEnvelope("Fallback заголовок") }, (tg) =>
        tg.generateThreadTitle({
          cwd: "/repo",
          message: "первый вопрос",
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.title).toBe("Fallback заголовок");
    }),
  );
});

describe("makeQwenTextGeneration.generateBranchName", () => {
  it.effect("sanitizes the plain reply into a git branch fragment", () =>
    Effect.gen(function* () {
      const out = yield* program({ stdout: resultEnvelope("Add User Auth") }, (tg) =>
        tg.generateBranchName({
          cwd: "/repo",
          message: "add auth",
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.branch).toBe("add-user-auth");
    }),
  );
});

describe("makeQwenTextGeneration.generateCommitMessage", () => {
  it.effect("decodes subject/body JSON and sanitizes them (no branch)", () =>
    Effect.gen(function* () {
      const modelJson = JSON.stringify({ subject: "feat: добавлен парсер.", body: "- деталь\n" });
      const out = yield* program({ stdout: resultEnvelope(modelJson) }, (tg) =>
        tg.generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "M file.ts",
          stagedPatch: "diff",
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.subject).toBe("feat: добавлен парсер");
      expect(out.body).toBe("- деталь");
      expect(out.branch).toBeUndefined();
    }),
  );

  it.effect("includes a sanitized feature branch when includeBranch is set", () =>
    Effect.gen(function* () {
      const modelJson = JSON.stringify({
        subject: "fix: устранён баг",
        body: "",
        branch: "My Feature",
      });
      const out = yield* program({ stdout: resultEnvelope(modelJson) }, (tg) =>
        tg.generateCommitMessage({
          cwd: "/repo",
          branch: null,
          stagedSummary: "M a.ts",
          stagedPatch: "diff",
          includeBranch: true,
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.subject).toBe("fix: устранён баг");
      expect(out.branch).toBe("feature/my-feature");
    }),
  );

  it.effect("maps invalid structured output to a TextGenerationError", () =>
    Effect.gen(function* () {
      const error = yield* program({ stdout: resultEnvelope('{"subject":"only subject"}') }, (tg) =>
        tg
          .generateCommitMessage({
            cwd: "/repo",
            branch: "main",
            stagedSummary: "s",
            stagedPatch: "p",
            modelSelection: MODEL_SELECTION,
          })
          .pipe(Effect.flip),
      );
      expect(error._tag).toBe("TextGenerationError");
      expect(error.operation).toBe("generateCommitMessage");
    }),
  );
});

describe("makeQwenTextGeneration.generatePrContent", () => {
  it.effect("decodes title/body JSON and sanitizes them", () =>
    Effect.gen(function* () {
      const modelJson = JSON.stringify({ title: "Мой PR", body: "## Summary\n- x\n" });
      const out = yield* program({ stdout: resultEnvelope(modelJson) }, (tg) =>
        tg.generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "feature/x",
          commitSummary: "c",
          diffSummary: "d",
          diffPatch: "p",
          modelSelection: MODEL_SELECTION,
        }),
      );
      expect(out.title).toBe("Мой PR");
      expect(out.body).toBe("## Summary\n- x");
    }),
  );
});

describe("makeQwenTextGeneration model + auth flags (ru-code)", () => {
  const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  // Decode selections up front (outside any Effect generator) so a canned model
  // slug becomes a valid ModelSelection without a decodeSync inside `Effect.gen`.
  const selection = (model: string) => decodeModelSelection({ instanceId: "qwen", model });

  const captureTitleArgv = (settings: typeof SETTINGS, model: string) => {
    const modelSelection = selection(model);
    return Effect.gen(function* () {
      const { argvs, spawner } = capturingSpawner({ stdout: resultEnvelope("t") });
      yield* makeQwenTextGeneration("/fake/cli.js", settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "m", modelSelection }),
        ),
      );
      return argvs[0]!;
    });
  };

  const CUSTOM_ANTHROPIC_SETTINGS = decodeQwenSettings({
    customModels: [{ slug: "my-model", authMethod: "anthropic" }],
  });
  const PLUS_SELECTION = selection("qwen3-coder-plus");

  it.effect("passes -p, the built-in model slug + its profile auth type, and json output", () =>
    Effect.gen(function* () {
      const argv = yield* captureTitleArgv(SETTINGS, "qwen3-coder-plus");
      expect(argv).toContain("-p");
      expect(flagValue(argv, "--model")).toBe("qwen3-coder-plus");
      expect(flagValue(argv, "--auth-type")).toBe("openai");
      expect(flagValue(argv, "--output-format")).toBe("json");
    }),
  );

  // ru-code: a one-shot `-p` run has no use for MCP tools, and WITHOUT this flag the CLI
  // connects (and awaits) every MCP server the user configured before answering — minutes on a
  // machine with slow/unreachable servers, paid on every commit message and branch name.
  it.effect("blocks MCP discovery with the sentinel allowlist", () =>
    Effect.gen(function* () {
      const argv = yield* captureTitleArgv(SETTINGS, "qwen3-coder-plus");
      expect(flagValue(argv, "--allowed-mcp-server-names")).toBe(NO_MCP_SERVER_SENTINEL);
    }),
  );

  it.effect("passes a custom model's own stored auth type", () =>
    Effect.gen(function* () {
      const argv = yield* captureTitleArgv(CUSTOM_ANTHROPIC_SETTINGS, "my-model");
      expect(flagValue(argv, "--model")).toBe("my-model");
      expect(flagValue(argv, "--auth-type")).toBe("anthropic");
    }),
  );

  it.effect("falls back to the instance default auth type for an unrecognized model", () =>
    Effect.gen(function* () {
      const argv = yield* captureTitleArgv(SETTINGS, "totally-unknown-model");
      expect(flagValue(argv, "--model")).toBe("totally-unknown-model");
      // default profile (custom) → openai
      expect(flagValue(argv, "--auth-type")).toBe("openai");
    }),
  );

  it.effect("also wires the flags for the JSON commit-message op", () =>
    Effect.gen(function* () {
      const { argvs, spawner } = capturingSpawner({
        stdout: resultEnvelope(JSON.stringify({ subject: "feat: x", body: "" })),
      });
      yield* makeQwenTextGeneration("/fake/cli.js", SETTINGS, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap((tg) =>
          tg.generateCommitMessage({
            cwd: "/repo",
            branch: "main",
            stagedSummary: "s",
            stagedPatch: "p",
            modelSelection: PLUS_SELECTION,
          }),
        ),
      );
      const argv = argvs[0]!;
      expect(flagValue(argv, "--model")).toBe("qwen3-coder-plus");
      expect(flagValue(argv, "--auth-type")).toBe("openai");
    }),
  );
});

describe("makeQwenTextGeneration dispatch-model resolve (ru-code)", () => {
  const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const selection = (model: string) => decodeModelSelection({ instanceId: "qwen", model });

  // Same harness as the flags block, but with the served-models option wired —
  // the resolver must make the DISPATCHED --model equal what the picker shows.
  const servedEntry = (slug: string) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  });
  it("a served model's own authType drives --auth-type (discovered-model auth, not the default)", () =>
    Effect.gen(function* () {
      const { argvs, spawner } = capturingSpawner({ stdout: resultEnvelope("t") });
      yield* makeQwenTextGeneration(
        "/fake/cli.js",
        SETTINGS,
        {},
        {
          getServedModels: Effect.succeed([
            { ...servedEntry("coder-model"), authType: "qwen-oauth" },
          ]),
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({
            cwd: "/repo",
            message: "m",
            modelSelection: selection("coder-model"),
          }),
        ),
      );
      const argv = argvs[0]!;
      expect(flagValue(argv, "--model")).toBe("coder-model");
      expect(flagValue(argv, "--auth-type")).toBe("qwen-oauth");
    }));

  const captureArgvWithServed = (model: string, servedSlugs: ReadonlyArray<string>) => {
    const modelSelection = selection(model);
    return Effect.gen(function* () {
      const { argvs, spawner } = capturingSpawner({ stdout: resultEnvelope("t") });
      yield* makeQwenTextGeneration(
        "/fake/cli.js",
        SETTINGS,
        {},
        {
          getServedModels: Effect.succeed(servedSlugs.map(servedEntry)),
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "m", modelSelection }),
        ),
      );
      return argvs[0]!;
    });
  };

  it.effect("persisted model that IS served dispatches verbatim (user intent wins)", () =>
    Effect.gen(function* () {
      const argv = yield* captureArgvWithServed("team/beta", ["team/alpha", "team/beta"]);
      expect(flagValue(argv, "--model")).toBe("team/beta");
    }),
  );

  it.effect("persisted model NOT in the served list resolves to the FIRST served model", () =>
    Effect.gen(function* () {
      const argv = yield* captureArgvWithServed("deleted/ghost", ["team/alpha", "team/beta"]);
      expect(flagValue(argv, "--model")).toBe("team/alpha");
    }),
  );

  it.effect("empty persisted model ('not selected') resolves to the FIRST served model", () =>
    Effect.gen(function* () {
      const argv = yield* captureArgvWithServed("", ["team/alpha", "team/beta"]);
      expect(flagValue(argv, "--model")).toBe("team/alpha");
    }),
  );

  it.effect("EMPTY served list omits --model AND --auth-type entirely (CLI defaults mode)", () =>
    Effect.gen(function* () {
      const argv = yield* captureArgvWithServed("anything-persisted", []);
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("--auth-type");
      // The run itself still happens with the json transport.
      expect(flagValue(argv, "--output-format")).toBe("json");
    }),
  );

  it.effect("the fallback never auto-picks a qwen-oauth model on a non-oauth instance", () =>
    Effect.gen(function* () {
      // The field failure: qwen unconditionally advertises its built-in
      // oauth models FIRST (`getAllConfiguredModels` forces qwen-oauth to
      // the front, configured or not), so with no persisted selection the
      // old first-served fallback dispatched coder-model with `--auth-type
      // qwen-oauth` on an openai-default instance — the CLI found no cached
      // oauth token and opened the chat.qwen.ai browser flow mid-textgen.
      // The fallback must skip qwen-oauth models unless qwen-oauth IS the
      // instance default (default profile here = openai).
      const { argvs, spawner } = capturingSpawner({ stdout: resultEnvelope("t") });
      yield* makeQwenTextGeneration(
        "/fake/cli.js",
        SETTINGS,
        {},
        {
          getServedModels: Effect.succeed([
            { ...servedEntry("coder-model"), authType: "qwen-oauth" },
            { ...servedEntry("qwen/qwen3.6-35b-a3b"), authType: "openai" },
          ]),
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap((tg) =>
          tg.generateThreadTitle({ cwd: "/repo", message: "m", modelSelection: selection("") }),
        ),
      );
      const argv = argvs[0]!;
      expect(flagValue(argv, "--auth-type")).not.toBe("qwen-oauth");
    }),
  );
});

describe("makeQwenTextGeneration failure path", () => {
  it.effect("non-zero exit surfaces a TextGenerationError carrying stderr", () =>
    Effect.gen(function* () {
      const error = yield* program({ stderr: "kaboom", code: 1 }, (tg) =>
        tg
          .generateThreadTitle({
            cwd: "/repo",
            message: "x",
            modelSelection: MODEL_SELECTION,
          })
          .pipe(Effect.flip),
      );
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toContain("kaboom");
    }),
  );
});
