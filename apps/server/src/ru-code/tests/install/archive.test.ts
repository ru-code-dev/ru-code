// @effect-diagnostics nodeBuiltinImport:off - install-flow: builds fixture tarballs on disk.
// ru-code: extract_archive (top-level + nested bundle-root discovery, anchored on `current.json`)
// and validate_archive (wrapper + pointer + the promised versions/<v> payload present → pass; a
// missing member → die). Fully sandboxed temp dirs.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval, writeFakeRelease } from "./harness.ts";

/** Build a tarball whose bundle root sits under a nested subdir (exercises the find fallback). */
function writeNestedRelease(rootDir: string, distBundleDir: string, subdir: string): string {
  const staging = NodePath.join(rootDir, "nested-staging");
  const inner = NodePath.join(staging, subdir);
  const payload = NodePath.join(inner, "versions", "1.0.0");
  NodeFS.rmSync(staging, { recursive: true, force: true });
  NodeFS.mkdirSync(payload, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(inner, "cli.js"), "process.exit(0);\n");
  NodeFS.writeFileSync(
    NodePath.join(inner, "current.json"),
    `{"schema":1,"version":"1.0.0","entry":"versions/1.0.0/cli.js"}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(payload, "cli.js"), "process.exit(0);\n");
  NodeFS.writeFileSync(
    NodePath.join(payload, "package.json"),
    `{"name":"ru-code","version":"1.0.0"}\n`,
  );
  NodeFS.mkdirSync(NodePath.join(payload, "client"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(payload, "node_modules"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(payload, "node_modules", ".keep"), "");
  const tarball = NodePath.join(distBundleDir, "ru-code-1.0.0.tgz");
  NodeChildProcess.execFileSync("tar", ["-czf", tarball, "-C", staging, subdir]);
  return tarball;
}

describe("install extract_archive", () => {
  it("extracts a top-level bundle: wrapper + pointer + versions/", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; echo "E=$EXTRACTED_DIR"; ls "$EXTRACTED_DIR"`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp") },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("cli.js");
      expect(r.stdout).toContain("current.json");
      expect(r.stdout).toContain("versions");
    } finally {
      sb.cleanup();
    }
  });

  it("finds a nested bundle root and points EXTRACTED_DIR at its folder", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeNestedRelease(sb.root, sb.distBundleDir, "pkg");
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; echo "E=$EXTRACTED_DIR"`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp") },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim().endsWith("/pkg")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  // The wrapper and every version payload share the `cli.js` name — anchoring on the pointer is
  // what keeps EXTRACTED_DIR at the bundle root instead of inside a version dir.
  it("never mistakes a version payload for the bundle root", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; echo "E=$EXTRACTED_DIR"`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp") },
      });
      expect(r.stdout).not.toContain("/versions/");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install validate_archive", () => {
  it("passes when all required members are present", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; validate_archive && echo VALID`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp"), APP_VERSION: "1.0.0" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("VALID");
    } finally {
      sb.cleanup();
    }
  });

  it("dies naming the missing member", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb, { missingPart: "node_modules" });
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; validate_archive`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp"), APP_VERSION: "1.0.0" },
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("node_modules");
      expect(r.all).toContain("Пакет повреждён");
    } finally {
      sb.cleanup();
    }
  });

  // A bundle whose payload dir does not match the version the FILENAME promises is corrupt: the
  // pointer would name a directory that does not exist and the install would boot nothing.
  it("dies when the bundle carries a different version than its name", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb, { version: "1.0.0" });
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive; validate_archive`, {
        globals: { ARCHIVE_PATH: tarball, TEMP_DIR: sb.path("tmp"), APP_VERSION: "2.0.0" },
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("versions/2.0.0");
    } finally {
      sb.cleanup();
    }
  });
});
