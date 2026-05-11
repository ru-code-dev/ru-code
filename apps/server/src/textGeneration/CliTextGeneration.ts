/**
 * CliTextGeneration — Text generation using `CLI -p ... --output-format json`.
 *
 * Multi-field ops (commit message, PR content) ask the model for JSON in the
 * prompt body and parse the model's reply against a schema. Single-string ops
 * (thread title, branch name) ask for plain text and use sanitizers — the JSON
 * wrapper would just give the model an excuse to chat instead of complying.
 *
 * Both paths use Cli's `--output-format json` envelope so we always get a
 * parseable transport, no matter what the model decided to say.
 *
 * @module CliTextGeneration
 */
import { CLI_NAME } from "@ru-fork/branding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type CliSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
// ru-fork: spawn-policy helper — routes the CLI text-generation
// spawn through bash on Windows when --windows-use-bash-for opts in.
// See ru-fork/spawn/policy.ts.
import { resolveSpawn } from "../ru-fork/spawn/policy.ts";
import { CLI_BINARY_NAME } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  CommitMessageOutputSchema,
  CommitMessageWithBranchOutputSchema,
  PrContentOutputSchema,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const formatAttachmentLines = (
  attachments: ReadonlyArray<{ name: string; mimeType: string; sizeBytes: number }> | undefined,
) => (attachments ?? []).map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`);

const buildCliSingleStringPrompt = (input: {
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

const CLI_TIMEOUT_MS = 180_000;

// Precompiled JSON decoders for Cli's structured-output operations. Hoisted to
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

type CliEnvelopeMessage =
  | { type: "result"; result?: string; is_error?: boolean }
  | { type: "assistant"; message?: { content?: Array<{ type: string; text?: string }> } }
  | { type: string; [key: string]: unknown };

/**
 * Parse Cli's `--output-format json` envelope and return the model's text reply.
 * The envelope is an array of typed messages; the final assistant text is in the
 * `result` message's `result` field, with `assistant.message.content[0].text` as
 * a fallback if `result` is missing.
 */
function extractCliResultText(rawStdout: string): string {
  const trimmed = rawStdout.trim();
  if (trimmed.length === 0) return "";
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!Array.isArray(envelope)) return trimmed;
  const messages = envelope as Array<CliEnvelopeMessage>;
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

export const makeCliTextGeneration = Effect.fn("makeCliTextGeneration")(function* (
  cliSettings: CliSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const cliEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    ...(cliSettings.homePath ? { CLI_HOME: expandHomePath(cliSettings.homePath) } : {}),
  };

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
        normalizeCliError(CLI_NAME, operation, cause, "Failed to collect process output"),
      ),
    );

  type CliOperation =
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle";

  const runCliCommand = Effect.fn("runCliCommand")(function* (input: {
    operation: CliOperation;
    cwd: string;
    prompt: string;
  }) {
    // ru-fork: text-generation operations (commit msg, branch name, ...).
    // Same policy as the ACP session spawn.
    const resolved = resolveSpawn(
      CLI_BINARY_NAME,
      ["-p", input.prompt, "--output-format", "json"],
      { shell: process.platform === "win32" },
    );
    const command = ChildProcess.make(resolved.command, [...resolved.args], {
      env: cliEnvironment,
      cwd: input.cwd,
      shell: resolved.shell,
    });

    const child = yield* commandSpawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError(CLI_NAME, input.operation, cause, "Failed to spawn Cli CLI process"),
        ),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamAsString(input.operation, child.stdout),
        readStreamAsString(input.operation, child.stderr),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(CLI_NAME, input.operation, cause, "Failed to read Cli CLI exit code"),
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
            ? `Cli CLI command failed: ${detail}`
            : `Cli CLI command failed with code ${exitCode}.`,
      });
    }

    return stdout;
  });

  const runCliWithTimeout = (input: { operation: CliOperation; cwd: string; prompt: string }) =>
    runCliCommand(input).pipe(
      Effect.scoped,
      Effect.timeoutOption(CLI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Cli CLI request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  /** Single-string ops: prompt asks for plain text, return the model's reply verbatim. */
  const runCliText = Effect.fn("runCliText")(function* (input: {
    operation: CliOperation;
    cwd: string;
    prompt: string;
  }) {
    const rawStdout = yield* runCliWithTimeout(input);
    return extractCliResultText(rawStdout);
  });

  /**
   * Multi-field ops: prompt asks for JSON; this helper runs the CLI, peels the
   * envelope, and extracts the JSON object string. Callers pick a module-scope
   * decoder for their concrete schema and map SchemaError to TextGenerationError.
   */
  const runCliJsonText = Effect.fn("runCliJsonText")(function* (input: {
    operation: CliOperation;
    cwd: string;
    prompt: string;
  }) {
    const rawStdout = yield* runCliWithTimeout(input);
    const modelText = extractCliResultText(rawStdout);
    return extractJsonObject(modelText);
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CliTextGeneration.generateCommitMessage",
  )(function* (input) {
    const wantsBranch = input.includeBranch === true;
    const { prompt } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: wantsBranch,
    });

    const jsonText = yield* runCliJsonText({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
    });

    const decode = wantsBranch ? decodeCommitMessageWithBranchOutput : decodeCommitMessageOutput;
    const generated = yield* decode(jsonText).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "Cli returned invalid structured output.",
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
    "CliTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const jsonText = yield* runCliJsonText({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
    });

    const generated = yield* decodePrContentOutput(jsonText).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generatePrContent",
            detail: "Cli returned invalid structured output.",
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
    "CliTextGeneration.generateBranchName",
  )(function* (input) {
    const text = yield* runCliText({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt: buildCliSingleStringPrompt({
        instruction: "You generate concise git branch name fragments.",
        responseShape:
          "Reply with the branch name only — 2 to 6 plain words separated by hyphens. No JSON. No quotes. No preamble.",
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
    });
    return { branch: sanitizeBranchFragment(text) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CliTextGeneration.generateThreadTitle",
  )(function* (input) {
    const text = yield* runCliText({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt: buildCliSingleStringPrompt({
        instruction:
          "You write concise titles for coding conversations. Reply in Russian (Русский язык). Technical identifiers (file names, symbols) may stay in English.",
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
