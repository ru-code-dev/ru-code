// ru-code: value-guard coverage for the qwen adapter's self-owned constants.
// These are contract-bearing (teardown method, TLS toggle, context window,
// timeouts) — an accidental edit should trip a test, not ship silently.
import { describe, expect, it } from "vite-plus/test";

import {
  ACP_SERVER_NO_SSL,
  ACP_SESSION_START_TIMEOUT_MS,
  AUTO_COMPACT_DISARM_FRACTION,
  AUTO_COMPACT_USED_FRACTION,
  CLI_TEXT_GENERATION_TIMEOUT_MS,
  CLI_VERSION_PROBE_TIMEOUT_MS,
  COMPACTION_RESTART_METHOD,
  CONTEXT_WINDOW_TOKENS,
  EXIT_DRAIN_GRACE_MS,
  MAINTENANCE_METHOD,
  MCP_ENGINE_USE_OVERLAY,
  MODE_CHANGE_METHOD,
  QWEN_MODELS_AUTO_DISCOVERY,
  STOP_BUTTON_METHOD,
} from "@ru-code/qwen/constants";

describe("qwen constants", () => {
  it("TLS validation is disabled for the spawned ACP child", () => {
    expect(ACP_SERVER_NO_SSL).toBe(true);
  });

  it("MCP overlay engine is enabled", () => {
    expect(MCP_ENGINE_USE_OVERLAY).toBe(true);
  });

  it("every teardown method is the hang-proof SIGKILL 'end-force'", () => {
    expect(STOP_BUTTON_METHOD).toBe("end-force");
    expect(MODE_CHANGE_METHOD).toBe("end-force");
    expect(MAINTENANCE_METHOD).toBe("end-force");
    expect(COMPACTION_RESTART_METHOD).toBe("end-force");
  });

  it("advertises the hardcoded 252k context window", () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(252_000);
  });

  it("timeout/grace budgets hold their tuned values", () => {
    expect(ACP_SESSION_START_TIMEOUT_MS).toBe(60_000);
    // Cached per CLI path per process, so a generous budget costs at most one slow wait.
    expect(CLI_VERSION_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(CLI_TEXT_GENERATION_TIMEOUT_MS).toBe(180_000);
    expect(EXIT_DRAIN_GRACE_MS).toBe(250);
  });

  it("auto-compact fires at 75% and disarms while stuck at/above 60%", () => {
    expect(AUTO_COMPACT_USED_FRACTION).toBe(0.75);
    expect(AUTO_COMPACT_DISARM_FRACTION).toBe(0.6);
    // The breaker line must sit below the trigger line or auto-compact
    // could disarm itself before it ever fires.
    expect(AUTO_COMPACT_DISARM_FRACTION).toBeLessThan(AUTO_COMPACT_USED_FRACTION);
  });

  it("model auto-discovery ships enabled", () => {
    expect(QWEN_MODELS_AUTO_DISCOVERY).toBe(true);
  });
});
