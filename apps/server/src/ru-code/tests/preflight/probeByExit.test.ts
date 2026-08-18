// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- vendored standalone preflight subsystem; keeps its self-contained node-builtin imports
import { execPath } from "node:process";
import { describe, expect, it } from "vite-plus/test";

import { probeVersionByExit } from "../../preflight/common/probe.ts";

const TIMEOUT = 3_000;

describe("probeVersionByExit", () => {
  it("ok+version when the process exits fast with a version", async () => {
    const result = await probeVersionByExit(
      execPath,
      ["-e", "process.stdout.write('1.2.3')"],
      TIMEOUT,
    );
    expect(result).toEqual({ ok: true, version: "1.2.3" });
  });

  it("broken when the process exits non-zero", async () => {
    const result = await probeVersionByExit(execPath, ["-e", "process.exit(1)"], TIMEOUT);
    expect(result).toEqual({ ok: false, reason: "broken" });
  });

  it("broken when the process exits 0 but prints no version", async () => {
    const result = await probeVersionByExit(
      execPath,
      ["-e", "process.stdout.write('hello')"],
      TIMEOUT,
    );
    expect(result).toEqual({ ok: false, reason: "broken" });
  });

  it("missing when the command does not exist (ENOENT)", async () => {
    const result = await probeVersionByExit(
      "definitely-not-a-real-binary-xyz",
      ["--version"],
      TIMEOUT,
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  // CASE A — the gate must NOT reject this: process exits fast but leaks stdout
  // to a detached grandchild that holds the pipe open. Measuring "exit" → ok.
  it("ok when the process exits fast but a child holds stdout open", async () => {
    const held = [
      "process.stdout.write('2.0.0');",
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(function(){}, 3000)'], { stdio: ['ignore', 1, 'ignore'], detached: true }).unref();",
      "process.exit(0);",
    ].join(" ");
    const result = await probeVersionByExit(execPath, ["-e", held], TIMEOUT);
    expect(result).toEqual({ ok: true, version: "2.0.0" });
  });

  // CASE B — the gate's reject path: genuinely slow to EXIT trips the timeout.
  it("timeout when the process is slow to exit", async () => {
    const result = await probeVersionByExit(
      execPath,
      ["-e", "setTimeout(function(){}, 5000)"],
      500,
    );
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
