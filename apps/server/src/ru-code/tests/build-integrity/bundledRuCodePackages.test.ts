// @effect-diagnostics nodeBuiltinImport:off - build-integrity guard: walks the source tree on
// disk and checks specifiers against the pack config; no Effect services involved.
//
// ru-code: THE GUARD against the "@ru-code/theme on node 22" class of breakage. All @ru-code/*
// workspace packages are source-only (their exports point at raw .ts): if a server source file
// imports one that the thin build (plain `pnpm build`, no RU_CODE_RELEASE_BUNDLE=1) leaves
// EXTERNAL, the built bin.mjs imports raw TypeScript at runtime and crashes with
// ERR_UNKNOWN_FILE_EXTENSION on any node below 23.6. Release builds inline everything and
// never hit this — which is exactly why it ships unnoticed. This test fails the moment a
// source file gains an @ru-code/* (or any workspace source-only) import that
// `shouldBundleCliDependency` would not inline.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { shouldBundleCliDependency } from "../../../../vite.config.ts";

const SERVER_SRC_DIR = NodePath.join(import.meta.dirname, "..", "..", "..");

const IMPORT_SPECIFIER_PATTERN = /from\s+["'](@ru-code\/[^"']+)["']/gu;

function collectSourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, collected);
      continue;
    }
    // Test files never ship in the bundle; everything else under src can be reached by bin.ts.
    if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

describe("thin-build bundling of source-only @ru-code packages", () => {
  it("every @ru-code/* import in apps/server/src is inlined by shouldBundleCliDependency", () => {
    const offenders: string[] = [];
    for (const filePath of collectSourceFiles(SERVER_SRC_DIR)) {
      const source = NodeFS.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = match[1] ?? "";
        if (!shouldBundleCliDependency(specifier)) {
          offenders.push(`${NodePath.relative(SERVER_SRC_DIR, filePath)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the known-shipped specifiers stay covered (regression pins)", () => {
    for (const specifier of [
      "@ru-code/theme",
      "@ru-code/branding",
      "@ru-code/localization",
      "@ru-code/qwen/constants",
      "@ru-code/platform-compat/constants",
    ]) {
      expect(shouldBundleCliDependency(specifier)).toBe(true);
    }
  });
});
