// ru-code: filesystem predicates + the .install-dir reader, exercised against a
// throwaway temp tree so we never touch the developer's real ~/.qwen.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isDir, isFile, readInstallRecord } from "../../preflight/common/fs.ts";

let tempRoot = "";

beforeEach(() => {
  tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-preflight-fs-"));
});

afterEach(() => {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
});

describe("isDir", () => {
  it("true for an existing directory", () => {
    expect(isDir(tempRoot)).toBe(true);
  });

  it("false for an existing file", () => {
    const file = NodePath.join(tempRoot, "f.txt");
    NodeFS.writeFileSync(file, "x");
    expect(isDir(file)).toBe(false);
  });

  it("false for a nonexistent path", () => {
    expect(isDir(NodePath.join(tempRoot, "nope"))).toBe(false);
  });
});

describe("isFile", () => {
  it("true for an existing file", () => {
    const file = NodePath.join(tempRoot, "cli.js");
    NodeFS.writeFileSync(file, "console.log(1)");
    expect(isFile(file)).toBe(true);
  });

  it("false for a directory", () => {
    expect(isFile(tempRoot)).toBe(false);
  });

  it("false for a nonexistent path", () => {
    expect(isFile(NodePath.join(tempRoot, "missing.js"))).toBe(false);
  });
});

describe("readInstallRecord", () => {
  it("returns the trimmed path recorded in <configDir>/.install-dir", () => {
    NodeFS.writeFileSync(NodePath.join(tempRoot, ".install-dir"), "  /opt/cli/bin  \n");
    expect(readInstallRecord(tempRoot)).toBe("/opt/cli/bin");
  });

  it("strips carriage returns (CRLF records)", () => {
    NodeFS.writeFileSync(NodePath.join(tempRoot, ".install-dir"), "/opt/cli/bin\r\n");
    expect(readInstallRecord(tempRoot)).toBe("/opt/cli/bin");
  });

  it("returns '' when the record is absent", () => {
    expect(readInstallRecord(tempRoot)).toBe("");
  });

  it("returns '' when the config dir itself does not exist", () => {
    expect(readInstallRecord(NodePath.join(tempRoot, "no-such-dir"))).toBe("");
  });
});
