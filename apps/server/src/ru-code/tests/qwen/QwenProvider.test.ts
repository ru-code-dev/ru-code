// ru-code: pure-function coverage for `parseQwenVersionOutput` — the version
// classifier that turns a `CLI --version` CommandResult into a provider probe.
import { describe, expect, it } from "vite-plus/test";

import type { CommandResult } from "../../../provider/providerSnapshot.ts";
import { parseQwenVersionOutput } from "../../qwen/QwenProvider.ts";

// ru-code: the per-instance profile label the driver threads in (e.g. "Qwen Code").
const LABEL = "Qwen Code";

describe("parseQwenVersionOutput", () => {
  it("exit 0 with a version → ready, no message", () => {
    const result: CommandResult = { stdout: "qwen 1.2.3\n", stderr: "", code: 0 };
    const parsed = parseQwenVersionOutput(result, LABEL);
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.status).toBe("ready");
    expect(parsed.auth).toEqual({ status: "unknown" });
    expect(parsed.message).toBeUndefined();
  });

  it("parses a version printed on stderr too", () => {
    // parseGenericCliVersion needs a word boundary before the digit, so a
    // "v"-prefixed token (v0.13.1) would NOT match — use a bare version.
    const result: CommandResult = { stdout: "", stderr: "0.13.1\n", code: 0 };
    const parsed = parseQwenVersionOutput(result, LABEL);
    expect(parsed.version).toBe("0.13.1");
    expect(parsed.status).toBe("ready");
  });

  it("non-zero exit WITH a parseable version → warning, version-aware message", () => {
    const result: CommandResult = { stdout: "qwen 1.2.3\n", stderr: "boom", code: 1 };
    const parsed = parseQwenVersionOutput(result, LABEL);
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.status).toBe("warning");
    expect(parsed.auth).toEqual({ status: "unknown" });
    expect(parsed.message).toContain("1.2.3");
    expect(parsed.message).toContain(LABEL);
    expect(parsed.message).toContain("1"); // the exit code
  });

  it("non-zero exit WITHOUT a version → warning, generic message", () => {
    const result: CommandResult = { stdout: "", stderr: "fatal", code: 127 };
    const parsed = parseQwenVersionOutput(result, LABEL);
    expect(parsed.version).toBeNull();
    expect(parsed.status).toBe("warning");
    expect(parsed.message).toContain(LABEL);
  });
});
