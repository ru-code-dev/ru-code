/**
 * QwenTextGeneration — Text generation using `qwen -p ... --output-format json`.
 *
 * Multi-field ops (commit message, PR content) ask the model for JSON in the
 * prompt body and parse the model's reply against a schema. Single-string ops
 * (thread title, branch name) ask for plain text and use sanitizers — the JSON
 * wrapper would just give the model an excuse to chat instead of complying.
 *
 * Both paths use Qwen's `--output-format json` envelope so we always get a
 * parseable transport, no matter what the model decided to say.
 *
 * @module QwenTextGeneration
 */
import { QWEN_KIND } from "@ru-code/branding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type QwenSettings, type ServerProviderModel } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
// ru-code: spawn helper — launches the CLI as `node <cliJs> …` directly. See
// ./spawn.ts buildCliSpawn.
import { buildCliSpawn } from "@ru-code/qwen/spawn";
import { CLI_TEXT_GENERATION_TIMEOUT_MS, MCP_ENGINE_USE_OVERLAY } from "@ru-code/qwen/constants";
// ru-code: same allowlist argument the ACP spawns use — one definition, one behaviour.
import { buildAllowedMcpServerArgs } from "./QwenAcpSupport.ts";
import { haltOnExit } from "@ru-code/qwen/haltOnExit";
// ru-code: resolve the auth method a given model dispatches with (built-in →
// profile default, custom → its stored method, else instance default).
import { asAuthMethodId } from "@ru-code/branding";
import { resolveServedModelAuthMethod } from "./discovery/serveQwenModels.ts";
import { resolveDefaultAuthMethod } from "./profileResolver.ts";
import { type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import {
  BRANCH_NAME_INSTRUCTION,
  THREAD_TITLE_INSTRUCTION,
} from "@ru-code/qwen/textgen/instructions";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  CommitMessageOutputSchema,
  CommitMessageWithBranchOutputSchema,
  PrContentOutputSchema,
} from "./textgen/prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";

const formatAttachmentLines = (
  attachments: ReadonlyArray<{ name: string; mimeType: string; sizeBytes: number }> | undefined,
) => (attachments ?? []).map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`);

const buildQwenSingleStringPrompt = (input: {
  instruction: string;
  responseShape: string;
  message: string;
  attachments?: ReadonlyArray<{ name: string; mimeType: string; sizeBytes: number }>;
}) => {
  const sections = [
    input.instruction,
    input.responseShape,
    "",
    "User message:",
    input.message.slice(0, 8_000),
  ];
  const attachmentLines = formatAttachmentLines(input.attachments);
  if (attachmentLines.length > 0) {
    sections.push("", "Attachment metadata:", attachmentLines.join("\n").slice(0, 4_000));
  }
  return sections.join("\n");
};

// Precompiled JSON decoders for Qwen's structured-output operations. Hoisted to
// module scope so neither the schema literal nor the compiled decoder is
// rebuilt per call (see oxlint t3code/no-inline-schema-compile and the same
// pattern in SessionCredentialService).
const decodeCommitMessageOutput = Schema.decodeEffect(
  Schema.fromJsonString(CommitMessageOutputSchema),
);
const decodeCommitMessageWithBranchOutput = Schema.decodeEffect(
  Schema.fromJsonString(CommitMessageWithBranchOutputSchema),
);
const decodePrContentOutput = Schema.decodeEffect(Schema.fromJsonString(PrContentOutputSchema));

type QwenEnvelopeMessage =
  | { type: "result"; result?: string; is_error?: boolean }
  | { type: "assistant"; message?: { content?: Array<{ type: string; text?: string }> } }
  | { type: string; [key: string]: unknown };

/**
 * Parse Qwen's `--output-format json` envelope and return the model's text reply.
 * The envelope is an array of typed messages; the final assistant text is in the
 * `result` message's `result` field, with `assistant.message.content[0].text` as
 * a fallback if `result` is missing.
 */
function extractQwenResultText(rawStdout: string): string {
  const trimmed = rawStdout.trim();
  if (trimmed.length === 0) return "";
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!Array.isArray(envelope)) return trimmed;
  const messages = envelope as Array<QwenEnvelopeMessage>;
  const resultMsg = messages.find((m) => m.type === "result");
  if (resultMsg && typeof (resultMsg as { result?: unknown }).result === "string") {
    return (resultMsg as { result: string }).result.trim();
  }
  const assistantMsg = messages.find((m) => m.type === "assistant");
  const text =
    assistantMsg &&
    (
      assistantMsg as { message?: { content?: Array<{ type: string; text?: string }> } }
    ).message?.content?.find((part) => part.type === "text")?.text;
  return (text ?? "").trim();
}

export interface QwenTextGenerationOptions {
  /**
   * Live view of the instance's served models — the same list the pickers
   * display, carrying each model's own auth (a discovered model's auth comes
   * from the session advertisement, never from settings). Absent ⇒ the
   * persisted slug passes through untouched with the settings-resolved auth.
   */
  readonly getServedModels?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
}

export const makeQwenTextGeneration = Effect.fn("makeQwenTextGeneration")(function* (
  cliJs: string,
  qwenSettings: QwenSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: QwenTextGenerationOptions,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const qwenEnvironment: NodeJS.ProcessEnv = {
    ...environment,
  };

  // ru-code: the CLI flags selecting the model + its auth for a `-p` run. Without
  // `--model`/`--auth-type` qwen falls back to its persisted defaults, which
  // mismatch the model the user actually picked → `[API Error 404]`. The clean
  // slug goes to `--model`; the resolved auth method (built-in → profile, custom →
  // its stored method, else instance default) goes to `--auth-type`. Creds
  // themselves live in the CLI's own config dir qwen authenticated into. An empty /
  // absent slug adds no flags (qwen keeps its own defaults).
  const buildModelArgs = (
    model: string | null | undefined,
    servedModels: ReadonlyArray<ServerProviderModel>,
  ): ReadonlyArray<string> => {
    const slug = model?.trim();
    if (!slug) {
      return [];
    }
    return [
      "--model",
      slug,
      "--auth-type",
      resolveServedModelAuthMethod(qwenSettings, servedModels, slug),
    ];
  };

  // The same rule the web pickers display with: persisted model when actually
  // served, else the first served model that cannot hijack the run — qwen
  // unconditionally advertises its built-in qwen-oauth models FIRST (whether
  // or not the user ever authenticated oauth), and dispatching one without
  // cached oauth credentials sends the CLI into the chat.qwen.ai browser flow
  // mid-textgen. So the fallback never auto-picks a qwen-oauth model unless
  // qwen-oauth IS the instance's default auth; no eligible model ⇒ "" (no
  // flags, CLI defaults). An explicit user selection always dispatches
  // verbatim. Resolved live at dispatch so a stale persisted slug never
  // reaches the backend; the persisted selection itself is never rewritten.
  const resolveDispatchModel = (persistedModel: string | null | undefined) =>
    Effect.gen(function* () {
      const persistedSlug = persistedModel?.trim() ?? "";
      const getServedModels = options?.getServedModels;
      if (!getServedModels) {
        return { slug: persistedSlug, servedModels: [] as ReadonlyArray<ServerProviderModel> };
      }
      const servedModels = yield* getServedModels;
      if (servedModels.length === 0) return { slug: "", servedModels };
      if (persistedSlug.length > 0 && servedModels.some((model) => model.slug === persistedSlug)) {
        return { slug: persistedSlug, servedModels };
      }
      const defaultAuth = resolveDefaultAuthMethod(qwenSettings);
      const fallbackModel = servedModels.find(
        (model) =>
          defaultAuth === "qwen-oauth" ||
          (asAuthMethodId(model.authType) ?? defaultAuth) !== "qwen-oauth",
      );
      const resolvedSlug = fallbackModel?.slug ?? "";
      yield* Effect.logDebug("[cli-textgen] dispatch model fallback", {
        persistedModel: persistedSlug,
        resolvedModel: resolvedSlug,
        defaultAuth,
      });
      return { slug: resolvedSlug, servedModels };
    });

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError(QWEN_KIND, operation, cause, "Failed to collect process output"),
      ),
    );

  type QwenOperation =
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle";

  const runQwenCommand = Effect.fn("runQwenCommand")(function* (input: {
    operation: QwenOperation;
    cwd: string;
    prompt: string;
    // ru-code: the selected model slug (clean, no auth suffix); drives --model/--auth-type.
    model: string | null | undefined;
  }) {
    // ru-code: text-generation operations (commit msg, branch name, ...).
    // `node <cliJs> -p … --model <slug> --auth-type <method> --output-format json`
    // directly — no shell, no PATH lookup.
    const dispatch = yield* resolveDispatchModel(input.model);
    const resolved = buildCliSpawn(cliJs, [
      "-p",
      input.prompt,
      ...buildModelArgs(dispatch.slug, dispatch.servedModels),
      // ru-code: a one-shot `-p` run has no use for MCP tools, and without this flag the CLI
      // connects (and awaits) every MCP server the user configured before answering — minutes
      // on a machine with slow/unreachable servers, paid on every commit message / branch name.
      // Gated like the ACP path so the kill-switch leaves qwen's own configuration alone.
      ...(MCP_ENGINE_USE_OVERLAY ? buildAllowedMcpServerArgs(undefined) : []),
      "--output-format",
      "json",
    ]);
    const command = ChildProcess.make(resolved.command, [...resolved.args], {
      env: qwenEnvironment,
      cwd: input.cwd,
      shell: resolved.shell,
    });

    const child = yield* commandSpawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError(QWEN_KIND, input.operation, cause, "Failed to spawn Qwen CLI process"),
        ),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamAsString(input.operation, child.stdout.pipe(haltOnExit(child.exitCode))),
        readStreamAsString(input.operation, child.stderr.pipe(haltOnExit(child.exitCode))),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              QWEN_KIND,
              input.operation,
              cause,
              "Failed to read Qwen CLI exit code",
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    if (exitCode !== 0) {
      const stderrDetail = stderr.trim();
      const stdoutDetail = stdout.trim();
      const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
      return yield* new TextGenerationError({
        operation: input.operation,
        detail:
          detail.length > 0
            ? `Qwen CLI command failed: ${detail}`
            : `Qwen CLI command failed with code ${exitCode}.`,
      });
    }

    return stdout;
  });

  const runQwenWithTimeout = (input: {
    operation: QwenOperation;
    cwd: string;
    prompt: string;
    model: string | null | undefined;
  }) =>
    runQwenCommand(input).pipe(
      Effect.scoped,
      Effect.timeoutOption(CLI_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Qwen CLI request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  /** Single-string ops: prompt asks for plain text, return the model's reply verbatim. */
  const runQwenText = Effect.fn("runQwenText")(function* (input: {
    operation: QwenOperation;
    cwd: string;
    prompt: string;
    model: string | null | undefined;
  }) {
    const rawStdout = yield* runQwenWithTimeout(input);
    return extractQwenResultText(rawStdout);
  });

  /**
   * Multi-field ops: prompt asks for JSON; this helper runs the CLI, peels the
   * envelope, and extracts the JSON object string. Callers pick a module-scope
   * decoder for their concrete schema and map SchemaError to TextGenerationError.
   */
  const runQwenJsonText = Effect.fn("runQwenJsonText")(function* (input: {
    operation: QwenOperation;
    cwd: string;
    prompt: string;
    model: string | null | undefined;
  }) {
    const rawStdout = yield* runQwenWithTimeout(input);
    const modelText = extractQwenResultText(rawStdout);
    return extractJsonObject(modelText);
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "QwenTextGeneration.generateCommitMessage",
  )(function* (input) {
    const wantsBranch = input.includeBranch === true;
    const { prompt } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: wantsBranch,
    });

    const jsonText = yield* runQwenJsonText({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      model: input.modelSelection.model,
    });

    const decode = wantsBranch ? decodeCommitMessageWithBranchOutput : decodeCommitMessageOutput;
    const generated = yield* decode(jsonText).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "Qwen returned invalid structured output.",
            cause,
          }),
      ),
    );

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "QwenTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const jsonText = yield* runQwenJsonText({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      model: input.modelSelection.model,
    });

    const generated = yield* decodePrContentOutput(jsonText).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generatePrContent",
            detail: "Qwen returned invalid structured output.",
            cause,
          }),
      ),
    );

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "QwenTextGeneration.generateBranchName",
  )(function* (input) {
    const text = yield* runQwenText({
      operation: "generateBranchName",
      cwd: input.cwd,
      model: input.modelSelection.model,
      prompt: buildQwenSingleStringPrompt({
        instruction: BRANCH_NAME_INSTRUCTION,
        responseShape:
          "Reply with the branch name only — 2 to 6 plain words separated by hyphens. No JSON. No quotes. No preamble.",
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
    });
    return { branch: sanitizeBranchFragment(text) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "QwenTextGeneration.generateThreadTitle",
  )(function* (input) {
    const text = yield* runQwenText({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      model: input.modelSelection.model,
      prompt: buildQwenSingleStringPrompt({
        instruction: THREAD_TITLE_INSTRUCTION,
        responseShape:
          "Reply with the title only — 3 to 8 words in Russian. No quotes. No preamble. No JSON. No trailing punctuation.",
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
    });
    return { title: sanitizeThreadTitle(text) };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
