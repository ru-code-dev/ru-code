// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- vendored standalone preflight subsystem; keeps its self-contained node-builtin imports
// ru-code: the install-time preflight probes the CLI as a CHILD process, which inherits
// `process.env`. The CLI needs its profile dir (and the rest of the branding CLI registry) or
// `cli.js --version` runs against the wrong home and the check reads as a phantom version
// mismatch. `applyCliProbeEnv` is the ONE place the preflight writes those vars, drawn from the
// same registry the app's spawns use — so this pin proves the probe's child really receives them.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { CLI_ENV, cliEnvAssignments } from "@ru-code/branding";

import { applyCliProbeEnv, checkCli } from "../../preflight/common/checks.ts";

let dir: string;
const CONFIG_DIR = "/tmp/ru-code-preflight-profile";

/** Names the injection must write; every one of them is restored after each case. */
const TOUCHED = cliEnvAssignments({ HOME: CONFIG_DIR }).map(([name]) => name);

/**
 * A stub cli.js that refuses to identify itself unless the CLI home var reached it — the exact
 * shape of the real failure (a CLI without its profile dir cannot answer for the right install).
 * The var NAME is read from the registry, so this stub follows a fork's rename automatically.
 */
const homeGuardedCli = (): string => {
  const names = CLI_ENV.HOME.names;
  return (
    `const names = ${JSON.stringify([...names])};\n` +
    `if (!names.every((n) => (process.env[n] || "") === ${JSON.stringify(CONFIG_DIR)})) {\n` +
    `  process.stderr.write("missing CLI home\\n");\n` +
    `  process.exit(1);\n` +
    `}\n` +
    `process.stdout.write("9.9.9");\n`
  );
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ru-code-cli-env-injection-"));
  writeFileSync(join(dir, "home-guarded.js"), homeGuardedCli());
});

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyCliProbeEnv", () => {
  it("writes every registry assignment for the resolved profile dir", () => {
    applyCliProbeEnv(CONFIG_DIR);
    for (const [name, value] of cliEnvAssignments({ HOME: CONFIG_DIR })) {
      expect(process.env[name], `injected ${name}`).toBe(value);
    }
  });

  it("writes nothing for an empty/blank config dir", () => {
    applyCliProbeEnv("");
    applyCliProbeEnv("   ");
    for (const name of CLI_ENV.HOME.names) expect(process.env[name]).toBeUndefined();
  });

  // The end-to-end property: the probe's CHILD sees it. Without the injection the same stub fails.
  it("makes the CLI probe pass a cli.js that requires the home var", async () => {
    const cliJs = join(dir, "home-guarded.js");
    expect((await checkCli(cliJs)).ok, "fails before the injection").toBe(false);
    applyCliProbeEnv(CONFIG_DIR);
    expect((await checkCli(cliJs)).ok, "passes once the registry env is injected").toBe(true);
  });
});
