// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the RELEASE BUNDLE's shape. `scripts/prepare-release.ts` stages the payload at
// `versions/<v>/` and then shells out to `scripts/emitBundleLayout.ts` for the launcher pair —
// this proves that door: the names it advertises, the files it writes, and that the result
// actually BOOTS (`node <bundle>/cli.js --version` reaches the payload).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { layoutNames } from "../../auto-update/wrapper/installLayout.ts";

const CLI = NodePath.resolve(import.meta.dirname, "../../../../scripts/emitBundleLayout.ts");

const runCli = (
  args: ReadonlyArray<string>,
): { status: number; stdout: string; stderr: string } => {
  const result = NodeChildProcess.spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Stage a bundle root whose payload answers `--version`, exactly like the real one does. */
function stageBundle(version: string): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-bundle-"));
  const payload = NodePath.join(root, layoutNames.versionsDir, version);
  NodeFS.mkdirSync(payload, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(payload, layoutNames.entry),
    `if (process.argv[2] === "--version") { process.stdout.write("ru-code v${version}\\n"); }\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(payload, "package.json"),
    `${JSON.stringify({ name: "ru-code", version, engines: { node: ">=20" } })}\n`,
  );
  return root;
}

describe("release bundle layout", () => {
  it("advertises the layout names the release script stages against", () => {
    const result = runCli(["paths"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      wrapper: "cli.js",
      wrapperPackage: "package.json",
      pointer: "current.json",
      versionsDir: "versions",
      entry: "cli.js",
    });
  });

  it("writes the frozen wrapper and a RELATIVE pointer beside the staged payload", () => {
    const root = stageBundle("1.2.3");
    try {
      expect(runCli(["write", root, "1.2.3"]).status).toBe(0);
      const wrapper = NodeFS.readFileSync(NodePath.join(root, layoutNames.wrapper), "utf8");
      expect(wrapper).toContain("FROZEN launcher");
      const pointer = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, layoutNames.pointer), "utf8"),
      );
      expect(pointer).toEqual({ schema: 1, version: "1.2.3", entry: "versions/1.2.3/cli.js" });
      // A build-machine path in the bundle would break on every user's disk.
      expect(NodePath.isAbsolute(pointer.entry)).toBe(false);
      // The wrapper's module declaration ships with it — the release script relies on this call
      // for every root file, so a bundle emitted here must be complete.
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(root, layoutNames.wrapperPackage), "utf8")),
      ).toEqual({ type: "module", private: true });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the emitted bundle boots: node <bundle>/cli.js reaches the payload", () => {
    const root = stageBundle("1.2.3");
    try {
      runCli(["write", root, "1.2.3"]);
      const booted = NodeChildProcess.spawnSync(
        "node",
        [NodePath.join(root, layoutNames.wrapper), "--version"],
        { encoding: "utf8" },
      );
      expect(booted.status).toBe(0);
      expect(booted.stdout).toContain("ru-code v1.2.3");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a bundle whose payload is missing fails loudly instead of booting nothing", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-bundle-empty-"));
    try {
      runCli(["write", root, "1.2.3"]);
      const booted = NodeChildProcess.spawnSync(
        "node",
        [NodePath.join(root, layoutNames.wrapper), "--version"],
        { encoding: "utf8" },
      );
      expect(booted.status).not.toBe(0);
      expect(booted.stderr).toContain("установка повреждена");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
