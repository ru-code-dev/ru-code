// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
// ru-code: the real-qwen harness is deliberately PLAIN NODE, not Effect — it is the
// ORACLE for the Effect-side fake, so sharing its runtime would let one bug hide
// the other. The Effect-API diagnostics are therefore off for this file.
// ru-code (qwen-compression wave): spawning the REAL qwen 0.21.1 bundle, with
// nothing of the machine's own state reachable from it.
//
// Every argument and every variable here is pinned to a qwen source line or to
// the on-disk golden record that a real capture already produced
// (`ru-code-packages/packages/qwen-cli-transcript-core/tests/goldens/new/acp/
// compress-command/manifest.md`: "qwen argv: --acp --yolo --auth-type openai
// --model fake-model").

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface QwenSpawnInput {
  /** The built bundle's entry — `<qwen build>/dist/cli.js`. */
  readonly cliJs: string;
  /** Working directory for the session; also the workspace qwen indexes. */
  readonly cwd: string;
  /** Run root for the isolated HOME / QWEN_HOME and the capture files. */
  readonly runRoot: string;
  /** Base URL of the scripted OpenAI-compatible mock (`…/v1`). */
  readonly openAiBaseUrl: string;
  /** The model slug the mock answers for. */
  readonly model?: string;
  /**
   * Extra `settings.json` keys for THIS run, merged over the defaults below.
   * The session-cap scenario needs `model.sessionTokenLimit`, which qwen reads
   * from settings and nowhere else (`Config.getSessionTokenLimit`,
   * config.ts:4320).
   */
  readonly settings?: Record<string, unknown>;
}

export interface QwenProcess {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly home: string;
  readonly qwenHome: string;
  /** Everything the child wrote to stderr, for the capture. */
  readonly stderr: () => string;
  /** SIGKILL and await the exit — unmaskable, so teardown cannot hang. */
  readonly kill: () => Promise<void>;
}

export const FAKE_MODEL = "fake-model";

/**
 * The argv. `--acp` selects ACP mode (`Config.experimentalZedIntegration`,
 * qwen config.ts:2167), `--yolo` sets `ApprovalMode.YOLO` before the ACP
 * connection is established so no permission round-trip is expected, and
 * `--auth-type openai --model <model>` picks the OpenAI-compatible backend the
 * mock impersonates.
 */
export const qwenArgs = (model: string): ReadonlyArray<string> => [
  "--acp",
  "--yolo",
  "--auth-type",
  "openai",
  "--model",
  model,
];

/**
 * The env. `OPENAI_*` point the backend at the mock;
 * `QWEN_MODEL` is read by qwen's own model resolution, so it is set alongside
 * `OPENAI_MODEL` exactly as the goldens harness set them. `QWEN_CODE_NO_RELAUNCH`
 * stops the CLI re-spawning itself as a child (the app sets it for the same
 * reason — see @ru-code/branding CLI_ENV.NO_RELAUNCH), which would otherwise put
 * a wrapper process between us and the agent.
 *
 * HOME and QWEN_HOME are the run's own directories: qwen writes settings,
 * session transcripts and caches under them, and a harness that reads the
 * developer's real profile would pick up their auth, their MCP servers and their
 * `context.autoCompactThreshold`.
 */
export const qwenEnv = (input: {
  readonly home: string;
  readonly qwenHome: string;
  readonly openAiBaseUrl: string;
  readonly model: string;
}): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: input.home,
  QWEN_HOME: input.qwenHome,
  QWEN_CODE_NO_RELAUNCH: "true",
  OPENAI_API_KEY: "fake-key",
  OPENAI_BASE_URL: input.openAiBaseUrl,
  OPENAI_MODEL: input.model,
  QWEN_MODEL: input.model,
  // Keep the run offline and quiet: no update probe, no telemetry exporter, no
  // colour codes in the captured stderr.
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
});

/**
 * Settings written into the isolated QWEN_HOME before the spawn.
 *
 * `context.autoCompactThreshold` is DELIBERATELY ABSENT: it is read once at
 * session creation (qwen config.ts:1893, :2173) and the whole point of the
 * auto-compaction scenario is to observe qwen's DEFAULT ladder. Telemetry and
 * usage statistics are off so the run makes no request the mock did not script.
 */
export const qwenSettings = (): unknown => ({
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
});

export function spawnQwen(input: QwenSpawnInput): QwenProcess {
  const home = NodePath.join(input.runRoot, "home");
  const qwenHome = NodePath.join(input.runRoot, "qwen-home");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(qwenHome, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(qwenHome, "settings.json"),
    `${JSON.stringify(
      { ...(qwenSettings() as Record<string, unknown>), ...input.settings },
      null,
      2,
    )}\n`,
  );

  const model = input.model ?? FAKE_MODEL;
  const child = NodeChildProcess.spawn(process.execPath, [input.cliJs, ...qwenArgs(model)], {
    cwd: input.cwd,
    env: qwenEnv({ home, qwenHome, openAiBaseUrl: input.openAiBaseUrl, model }),
    stdio: ["pipe", "pipe", "pipe"],
  }) as NodeChildProcess.ChildProcessWithoutNullStreams;

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // A harness that dies on EPIPE while killing the child reports a harness bug
  // as a capture failure.
  child.stdin.on("error", () => {});

  return {
    child,
    home,
    qwenHome,
    stderr: () => stderr,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}
