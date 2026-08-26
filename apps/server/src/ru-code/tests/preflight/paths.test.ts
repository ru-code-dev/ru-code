// ru-code: STRUCTURE-ONLY pins on the per-platform candidate path table. CLI_BIN_PATHS is the ONE
// file edited per deployment (see paths.ts's own header) — its actual candidate paths are a
// deployment concern the owner edits directly, so this suite must never assert a literal path or
// literal token's presence (that would fail every time the owner reshapes the table for a real
// environment, which is exactly what happened before this rewrite). What it DOES pin is the
// SHAPE every platform's table must have, regardless of content: all three platform keys present,
// every value a non-empty array of non-empty strings, and every `{token}` used drawn from the
// known set expand.ts actually expands — so a typo'd token (`{apdata}`, `{Home}`, …) is caught
// here instead of silently expanding to nothing at runtime.
// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import { CLI_BIN_PATHS } from "../../preflight/paths.ts";

const PLATFORMS = ["darwin", "linux", "win32"] as const;

// The exact set expand.ts knows how to expand (see its `.replace(...)` chain). Kept independent
// of expand.ts's own source so a token added to the table without a matching case there still
// gets caught here, instead of silently expanding to nothing because both sides drifted together.
const KNOWN_TOKENS = new Set(["home", "appdata", "localappdata"]);

/** Every `{...}` token literal appearing in a candidate string, lowercased token name only. */
const tokensIn = (candidate: string): string[] =>
  [...candidate.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? "");

describe("CLI_BIN_PATHS", () => {
  it("has a table entry for every platform key", () => {
    for (const platform of PLATFORMS) {
      expect(Object.hasOwn(CLI_BIN_PATHS, platform), platform).toBe(true);
    }
  });

  it("no unexpected platform keys sneak in", () => {
    expect(Object.keys(CLI_BIN_PATHS).sort()).toEqual([...PLATFORMS].sort());
  });

  it("every platform's candidate list is a non-empty array of non-empty strings", () => {
    for (const platform of PLATFORMS) {
      const candidates = CLI_BIN_PATHS[platform];
      expect(Array.isArray(candidates), platform).toBe(true);
      expect(candidates.length, `${platform}: at least one candidate`).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(typeof candidate, `${platform}: candidate must be a string`).toBe("string");
        expect(candidate.length, `${platform}: candidate must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every {token} used is one expand.ts actually knows how to expand", () => {
    const unknown: string[] = [];
    for (const platform of PLATFORMS) {
      for (const candidate of CLI_BIN_PATHS[platform]) {
        for (const token of tokensIn(candidate)) {
          if (!KNOWN_TOKENS.has(token)) unknown.push(`${platform}: {${token}} in "${candidate}"`);
        }
      }
    }
    expect(
      unknown,
      `unrecognized token(s) — typo, or expand.ts needs a matching case:\n${unknown.join("\n")}`,
    ).toEqual([]);
  });
});
