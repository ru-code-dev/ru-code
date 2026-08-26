// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- vendored standalone preflight subsystem; keeps its self-contained node-builtin imports
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { checkCli } from "../../preflight/common/checks.ts";
import { MESSAGES } from "../../preflight/common/messages.ts";

let dir: string;
const cli = (name: string): string => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ru-code-checkcli-"));
  writeFileSync(cli("ok.js"), "process.stdout.write('9.9.9')"); // >= CLI_MIN_VERSION
  writeFileSync(cli("low.js"), "process.stdout.write('0.1.0')"); // < CLI_MIN_VERSION
  writeFileSync(cli("broken.js"), "process.exit(2)");
  writeFileSync(cli("slow.js"), "setTimeout(function(){}, 10000)"); // never exits in time
  // ru-code: a non-.js CLI wrapper — the probe goes through the app's ONE dispatcher
  // (buildCliSpawn), which runs it DIRECTLY via its shebang instead of `node <path>`.
  writeFileSync(cli("wrapper.sh"), "#!/bin/sh\nprintf '9.9.9'\n");
  chmodSync(cli("wrapper.sh"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkCli", () => {
  it("ok for a fast cli at/above the minimum version", async () => {
    const result = await checkCli(cli("ok.js"));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ok");
  });

  it("fails (CLI_LOW) for a version below the minimum", async () => {
    const result = await checkCli(cli("low.js"));
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("old");
  });

  it("fails (CLI_BROKEN) for a non-zero exit", async () => {
    const result = await checkCli(cli("broken.js"));
    expect(result).toEqual({ ok: false, kind: "broken", line: MESSAGES.CLI_BROKEN });
  });

  it("fails (CLI_TOO_SLOW) when the cli is too slow to exit", async () => {
    const result = await checkCli(cli("slow.js"));
    expect(result).toEqual({ ok: false, kind: "slow", line: MESSAGES.CLI_TOO_SLOW });
  });

  // ru-code: CLI_INVOKE_AUTO — a sh-script CLI is probed by executing it directly (shebang),
  // exactly how the app spawns it; hardcoded `node <path>` would die on its first line.
  it("ok for a non-.js shebang wrapper (dispatched, not node-parsed)", async () => {
    const result = await checkCli(cli("wrapper.sh"));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ok");
  });
});
