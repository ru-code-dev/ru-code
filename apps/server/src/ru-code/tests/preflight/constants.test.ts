// ru-code: pins the preflight constants to their expected literal values.
// These are the single source of truth for the CLI/app dir names and version
// gates; a silent change would break resolve.ts and the branding contract.
import { describe, expect, it } from "vite-plus/test";

import {
  APP_BIN,
  APP_DIR,
  CLI_DIR,
  CLI_MIN_VERSION,
  CLI_PROBE_TIMEOUT_MS,
  LINUX_SAFE_DIR,
  NODE_ENGINE_RANGE,
} from "../../preflight/common/constants.ts";

describe("preflight constants", () => {
  it("derives on-disk dir names from branding", () => {
    expect(CLI_DIR).toBe(".qwen");
    expect(APP_DIR).toBe(".ru-code");
    expect(APP_BIN).toBe("ru-code");
  });

  it("uses the linux-safe /home segment 'work'", () => {
    expect(LINUX_SAFE_DIR).toBe("work");
  });

  it("declares the supported node engine range", () => {
    expect(NODE_ENGINE_RANGE).toBe("^22.16 || ^23.11 || >=24.10");
  });

  it("pins the minimum CLI version", () => {
    expect(CLI_MIN_VERSION).toBe("0.13.1");
  });

  it("budgets the CLI version probe at 3s", () => {
    expect(CLI_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(typeof CLI_PROBE_TIMEOUT_MS).toBe("number");
  });
});
