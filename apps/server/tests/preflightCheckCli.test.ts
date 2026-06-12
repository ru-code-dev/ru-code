// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkCli } from "../src/ru-fork/preflight/common/checks.ts";
import { MESSAGES } from "../src/ru-fork/preflight/common/messages.ts";

let dir: string;
const cli = (name: string): string => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ru-fork-checkcli-"));
  writeFileSync(cli("ok.js"), "process.stdout.write('9.9.9')"); // >= CLI_MIN_VERSION
  writeFileSync(cli("low.js"), "process.stdout.write('0.1.0')"); // < CLI_MIN_VERSION
  writeFileSync(cli("broken.js"), "process.exit(2)");
  writeFileSync(cli("slow.js"), "setTimeout(function(){}, 10000)"); // never exits in time
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkCli", () => {
  it("ok for a fast cli at/above the minimum version", async () => {
    const result = await checkCli(cli("ok.js"));
    expect(result.ok).toBe(true);
  });

  it("fails (CLI_LOW) for a version below the minimum", async () => {
    const result = await checkCli(cli("low.js"));
    expect(result.ok).toBe(false);
  });

  it("fails (CLI_BROKEN) for a non-zero exit", async () => {
    const result = await checkCli(cli("broken.js"));
    expect(result).toEqual({ ok: false, line: MESSAGES.CLI_BROKEN });
  });

  it("fails (CLI_TOO_SLOW) when the cli is too slow to exit", async () => {
    const result = await checkCli(cli("slow.js"));
    expect(result).toEqual({ ok: false, line: MESSAGES.CLI_TOO_SLOW });
  });
});
