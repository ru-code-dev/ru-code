// ru-code (qwen-compression wave): THE REAL-QWEN HARNESS.
//
// Drives the REAL qwen 0.21.1 bundle over a real ACP connection against a
// scripted local OpenAI-compatible mock, and records every frame it sends. It is
// the ORACLE for `apps/server/src/ru-code/tests/qwen/fake-acp/` — when a capture
// and the fake disagree, the FAKE is wrong.
//
// Nothing here runs without a built bundle: pass `cliJs`, or set
// `RU_CODE_QWEN_CLI_JS`. See README.md for the build ritual.

export {
  captureScenario,
  resolveQwenCliJs,
  QWEN_CLI_ENV_VAR,
  type CaptureOptions,
  type CaptureResult,
  type CaptureTurnResult,
} from "./capture.ts";
export {
  isBareAgentMessageFrame,
  isSlashCommandFrame,
  isUsageFrame,
  metaKeysSeen,
  readCapturedFrame,
  readCapturedFrames,
  usageInputTokens,
  type CapturedFrame,
} from "./frames.ts";
export {
  INFLATED_PROMPT_TOKENS,
  SCENARIOS,
  SESSION_TOKEN_LIMIT,
  scenarioByName,
  type Scenario,
  type ScenarioTurn,
} from "./scenarios.ts";
export {
  FAKE_MODEL,
  qwenArgs,
  qwenEnv,
  qwenSettings,
  spawnQwen,
  type QwenProcess,
  type QwenSpawnInput,
} from "./qwenProcess.ts";
export {
  startFakeOpenAIServer,
  type FakeOpenAIFailure,
  type FakeOpenAIRequest,
  type FakeOpenAIResponse,
  type FakeOpenAIServer,
} from "./fakeOpenAiServer.ts";
export { AcpCallError, AcpClient, ACP_PROTOCOL_VERSION } from "./acpClient.ts";
