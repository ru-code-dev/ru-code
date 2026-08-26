// ru-code: THE registry pin — @ru-code/branding's cliEnv table + cliEnvBuild helpers.
//
// Every qwen-kind CLI invocation (ACP sessions/warm slots, one-shot `-p` text generation, the
// app's `--version` probe, the installer preflight's probe, the installer's bash warm-up) draws
// its env vars and shared flags from that ONE registry. This file pins the PROCESSING rules
// against fixture tables (so the rules are tested independently of today's rows) plus ONE literal
// snapshot of the real registry's output.
//
// The literal snapshot below is the ONLY handwritten place outside cliEnv.ts where the concrete
// names/values may appear — every other test in the repo derives its expectation from the tables.
import { describe, expect, it } from "vite-plus/test";

import {
  CLI_ARGS,
  CLI_ENV,
  allowedMcpServerArgs,
  cliArgAssignments,
  cliEnvAssignments,
  type CliArgVar,
  type CliEnvVar,
} from "@ru-code/branding";

// ── fixture tables: the rules, independent of the shipped rows ───────────────────────────────
const FIXTURE_ENV = {
  // fixed: injected on every spawn, no runtime input
  NO_RELAUNCH: { names: ["FIXTURE_NO_RELAUNCH"], value: "true" },
  // a fork prefix rename lands here as a second alias — both names must be written
  TWO_ALIASES: { names: ["FIXTURE_ALIAS_ONE", "FIXTURE_ALIAS_TWO"], value: "same" },
  // runtime-supplied rows
  HOME: { names: ["FIXTURE_HOME"], value: null },
  SYSTEM_SETTINGS_PATH: { names: ["FIXTURE_SETTINGS"], value: null },
} as const satisfies Record<string, CliEnvVar>;

const FIXTURE_ARGS = {
  ALLOWED_MCP_SERVERS: { flag: "--fixture-allow", value: "fixture-none" },
  OTHER: { flag: "--fixture-other", value: "always" },
} as const satisfies Record<string, CliArgVar>;

const namesOf = (pairs: ReadonlyArray<readonly [string, string]>): ReadonlyArray<string> =>
  pairs.map(([name]) => name);

describe("cliEnvAssignments (fixture table)", () => {
  it("emits every FIXED row on every spawn, one pair per alias", () => {
    expect(cliEnvAssignments({}, FIXTURE_ENV)).toEqual([
      ["FIXTURE_NO_RELAUNCH", "true"],
      ["FIXTURE_ALIAS_ONE", "same"],
      ["FIXTURE_ALIAS_TWO", "same"],
    ]);
  });

  it("skips a runtime row (value: null) when no runtime value is supplied", () => {
    expect(namesOf(cliEnvAssignments({}, FIXTURE_ENV))).not.toContain("FIXTURE_HOME");
    expect(namesOf(cliEnvAssignments({}, FIXTURE_ENV))).not.toContain("FIXTURE_SETTINGS");
  });

  it("fills a runtime row from the supplied value, leaving the other runtime rows out", () => {
    const pairs = cliEnvAssignments({ HOME: "/home/me/.qwen" }, FIXTURE_ENV);
    expect(pairs).toContainEqual(["FIXTURE_HOME", "/home/me/.qwen"]);
    expect(namesOf(pairs)).not.toContain("FIXTURE_SETTINGS");
  });

  it("skips an EMPTY runtime value rather than writing a blank variable", () => {
    expect(namesOf(cliEnvAssignments({ HOME: "" }, FIXTURE_ENV))).not.toContain("FIXTURE_HOME");
  });

  // A fixed row is policy, not a default: the runtime cannot talk it out of its value.
  it("keeps a FIXED row's value even when the runtime offers one for that key", () => {
    const pairs = cliEnvAssignments(
      { HOME: "/home/me/.qwen", NO_RELAUNCH: "false" } as never,
      FIXTURE_ENV,
    );
    expect(pairs).toContainEqual(["FIXTURE_NO_RELAUNCH", "true"]);
  });
});

describe("cliArgAssignments (fixture table)", () => {
  it("emits every row as flag + value with no runtime input", () => {
    expect(cliArgAssignments({}, FIXTURE_ARGS)).toEqual([
      "--fixture-allow",
      "fixture-none",
      "--fixture-other",
      "always",
    ]);
  });

  it("lets a runtime value REPLACE the row default, leaving other rows untouched", () => {
    expect(cliArgAssignments({ ALLOWED_MCP_SERVERS: "alpha,beta" }, FIXTURE_ARGS)).toEqual([
      "--fixture-allow",
      "alpha,beta",
      "--fixture-other",
      "always",
    ]);
  });

  it("falls back to the row default for an EMPTY runtime value (the flag never disappears)", () => {
    expect(cliArgAssignments({ ALLOWED_MCP_SERVERS: "" }, FIXTURE_ARGS)).toEqual([
      "--fixture-allow",
      "fixture-none",
      "--fixture-other",
      "always",
    ]);
  });
});

describe("allowedMcpServerArgs", () => {
  const FLAG = CLI_ARGS.ALLOWED_MCP_SERVERS.flag;
  const NONE = CLI_ARGS.ALLOWED_MCP_SERVERS.value;

  // The CLI decides by the PRESENCE of the flag: without it there is no filter and it connects
  // (and awaits) every configured MCP server. "No MCP" must be an allowlist nothing can match.
  it("uses the row's sentinel value for an absent, empty or blank-only list", () => {
    expect(allowedMcpServerArgs(undefined)).toEqual([FLAG, NONE]);
    expect(allowedMcpServerArgs([])).toEqual([FLAG, NONE]);
    expect(allowedMcpServerArgs(["  ", ""])).toEqual([FLAG, NONE]);
  });

  it("joins a non-empty allowlist in order", () => {
    expect(allowedMcpServerArgs(["alpha"])).toEqual([FLAG, "alpha"]);
    expect(allowedMcpServerArgs(["beta", "alpha"])).toEqual([FLAG, "beta,alpha"]);
  });

  it("is exactly cliArgAssignments with the joined list as the runtime override", () => {
    expect(allowedMcpServerArgs(["beta", "alpha"])).toEqual(
      cliArgAssignments({ ALLOWED_MCP_SERVERS: "beta,alpha" }),
    );
    expect(allowedMcpServerArgs(undefined)).toEqual(cliArgAssignments());
  });
});

// ── the ONE literal snapshot of the shipped registry ─────────────────────────────────────────
// If a fork re-prefixes the CLI, this is the single test that changes alongside cliEnv.ts.
describe("the shipped registry's output (literal snapshot)", () => {
  it("injects NO_RELAUNCH on every spawn and nothing else without runtime values", () => {
    expect(cliEnvAssignments()).toEqual([["QWEN_CODE_NO_RELAUNCH", "true"]]);
  });

  it("adds QWEN_HOME and QWEN_CODE_SYSTEM_SETTINGS_PATH from the runtime", () => {
    expect(
      cliEnvAssignments({ HOME: "/home/me/.qwen", SYSTEM_SETTINGS_PATH: "/tmp/overlay.json" }),
    ).toEqual([
      ["QWEN_CODE_NO_RELAUNCH", "true"],
      ["QWEN_HOME", "/home/me/.qwen"],
      ["QWEN_CODE_SYSTEM_SETTINGS_PATH", "/tmp/overlay.json"],
    ]);
  });

  it("adds QWEN_PACKAGE_IDENTITY from the runtime (CLI_PASS_IDENTITY), absent otherwise", () => {
    expect(cliEnvAssignments({ PACKAGE_IDENTITY: "id-1" })).toEqual([
      ["QWEN_CODE_NO_RELAUNCH", "true"],
      ["QWEN_PACKAGE_IDENTITY", "id-1"],
    ]);
    expect(namesOf(cliEnvAssignments())).not.toContain("QWEN_PACKAGE_IDENTITY");
  });

  it("emits the MCP-off flag pair on every spawn", () => {
    expect(cliArgAssignments()).toEqual(["--allowed-mcp-server-names", "__none__"]);
  });

  it("names each row's aliases exactly once (no duplicate names across the table)", () => {
    const all = Object.values(CLI_ENV).flatMap((row) => [...row.names]);
    expect(new Set(all).size).toBe(all.length);
  });
});
