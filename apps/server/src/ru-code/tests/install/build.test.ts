// @effect-diagnostics nodeBuiltinImport:off - install-flow: reads the committed `install` artifact.
// ru-code: DRIFT GUARD — the committed `install` MUST equal the parts assembled by
// scripts/build-installer.ts. Editing `install` directly (instead of the parts + rebuild) fails
// this test, as does forgetting to run `pnpm build:installer` after changing a part.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_GRADIENT_FROM,
  BRAND_GRADIENT_TO,
  CLI_ENV,
  cliArgAssignments,
  cliEnvAssignments,
} from "@ru-code/branding";

import { CLI_MIN_VERSION, NODE_ENGINE_RANGE } from "../../preflight/common/constants.ts";
import {
  buildInstaller,
  escapeForDoubleQuotedShell,
} from "../../../../../../scripts/build-installer.ts";
import { INSTALL_SCRIPT } from "./harness.ts";

describe("installer build (drift guard)", () => {
  it("the committed `install` is byte-identical to the assembled parts", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(committed).toBe(buildInstaller());
  });

  it("carries injected brand values and no unresolved tokens", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(committed).not.toMatch(/@@[A-Z0-9_]+@@/);
    expect(committed).toContain('APP_DISPLAY_NAME="Ru Code"');
    expect(committed).toContain("set -euo pipefail");
  });

  it("injects the brand gradient from @ru-code/branding (single source, daemon↔installer no drift)", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(committed).toContain(`GRADIENT_FROM="${BRAND_GRADIENT_FROM.join(";")}"`);
    expect(committed).toContain(`GRADIENT_TO="${BRAND_GRADIENT_TO.join(";")}"`);
  });

  it("mirrors the preflight node-engine range and CLI floor (no cross-source drift, §8)", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(committed).toContain(`NODE_ENGINE_RANGE="${NODE_ENGINE_RANGE}"`);
    expect(committed).toContain(`CLI_MIN_VERSION="${CLI_MIN_VERSION}"`);
    // NODE_MIN_MAJOR is DERIVED from the range's minimum major (22 from "^22.16 || …").
    const minMajor = String(
      Math.min(...[...NODE_ENGINE_RANGE.matchAll(/(?:\^|>=?|~)(\d+)/g)].map((m) => Number(m[1]))),
    );
    expect(committed).toContain(`NODE_MIN_MAJOR="${minMajor}"`);
  });

  // ru-code: the bash warm-up is the fifth qwen spawn site, and the only one outside TypeScript.
  // Its env prefix and shared flags are TOKENS generated from @ru-code/branding's CLI registry, so
  // the shipped installer cannot drift from what the app injects. Derived from the registry here —
  // the literals live in cliEnv.ts and its one snapshot test.
  it("bakes the CLI registry's env + shared flags into the warm-up line", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    const warmLine = committed.split("\n").find((line) => line.includes(`-p "test"`));
    expect(warmLine, "the warm-up invocation line").toBeDefined();
    // The CLI home var carries the installer's own resolved profile dir (bash-expanded).
    for (const name of CLI_ENV.HOME.names) {
      expect(warmLine).toContain(`${name}="$CONFIG_DIR"`);
    }
    // Every fixed row rides along too, verbatim.
    for (const [name, value] of cliEnvAssignments()) {
      expect(warmLine).toContain(`${name}="${value}"`);
    }
    // …and the shared flags, so a warm-up never waits on the user's MCP servers.
    expect(warmLine).toContain(cliArgAssignments().join(" "));
  });

  it("contains no bash-4+ syntax (bash 3.2 portability, §1a)", () => {
    // Ignore comment lines; scan the executable body only.
    const body = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toMatch(/declare\s+-A/);
    expect(body).not.toMatch(/\bmapfile\b|\breadarray\b/);
    expect(body).not.toMatch(/&>>/);
    expect(body).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)\}/); // ${v,,} / ${v^^}
    expect(body).not.toMatch(/\bwait\s+-n\b/);
    expect(body).not.toMatch(/\blocal\s+-n\b/);
  });

  // AU-08. Every @@TOKEN@@ lands inside a double-quoted bash assignment, where `$`, a backtick and
  // `"` are all still live. A brand value carrying one of them either breaks the generated script
  // or EXECUTES at install time on the user's machine.
  describe("brand values cannot escape their bash string", () => {
    it("neutralises every character that is special inside double quotes", () => {
      expect(escapeForDoubleQuotedShell("$(id)")).toBe("\\$(id)");
      expect(escapeForDoubleQuotedShell("`id`")).toBe("\\`id\\`");
      expect(escapeForDoubleQuotedShell('say "hi"')).toBe('say \\"hi\\"');
      expect(escapeForDoubleQuotedShell("back\\slash")).toBe("back\\\\slash");
      expect(escapeForDoubleQuotedShell("$HOME")).toBe("\\$HOME");
    });

    it("leaves ordinary values byte-identical — today's output cannot shift", () => {
      for (const value of [
        "Ru Code",
        "ru-code",
        "https://example.com/chat",
        "--experimental-sqlite --disable-warning=ExperimentalWarning",
        "34;211;238",
        "",
      ]) {
        expect(escapeForDoubleQuotedShell(value)).toBe(value);
      }
    });

    // The end-to-end property: bash itself must read the escaped value back verbatim.
    it("round-trips through a real bash assignment", () => {
      const hostile = String.raw`x"$(id)` + "`id`" + String.raw`\end`;
      const script = `V="${escapeForDoubleQuotedShell(hostile)}"\nprintf '%s' "$V"\n`;
      const result = NodeChildProcess.spawnSync("bash", ["-c", script], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(hostile);
    });
  });
});
