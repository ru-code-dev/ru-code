// ru-code: CHARACTERIZATION tests for the Linux-relocation branch of `resolveQwenCli` — the branch
// the non-mocked resolve.test.ts can't reach hermetically (it hinges on /home/<LINUX_SAFE_DIR>/<user>
// EXISTING, which we must never create on a real machine). We mock node:os (homedir/userInfo) and
// node:fs (statSync of the relocation dir) — the same technique as apps/server/src/bootstrap.test.ts —
// so the reloc / no-reloc / no-passwd branches run deterministically on any host.
//
// Locks INSTALLER/cli-resolution.md exactly:
//   reloc  → ourRoot=P/APP_DIR, configDir=H/CLI_DIR (LINUX_USE_SAFE_DIR_FOR_CLI=false), configDirAlt=P/CLI_DIR, legacyRoot=H/APP_DIR
//   !reloc → ourRoot=H/APP_DIR, configDir=H/CLI_DIR, configDirAlt="", legacyRoot undefined
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { APP_HOME_DIRNAME, PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

// Hoisted knobs the node:os / node:fs mocks read (mutated per test).
const homeState = vi.hoisted(() => ({ home: "/home/tester-home", user: "tester" }));
const relocState = vi.hoisted(() => ({ exists: true }));
// The dir the fs mock reports as existing: /home/<LINUX_SAFE_DIR>/<user>. LINUX_SAFE_DIR is "work"
// (guarded in-test below) — kept literal here because the mock factory is hoisted above imports and
// cannot read the constant.
const RELOC_DIR = "/home/work/tester";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => homeState.home,
    userInfo: () => {
      if (homeState.user === "") throw new Error("no passwd entry");
      return { username: homeState.user } as unknown as ReturnType<typeof actual.userInfo>;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((p: unknown, ...rest: unknown[]) => {
      if (p === RELOC_DIR) {
        if (!relocState.exists) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isDirectory: () => true, isFile: () => false };
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

import { LINUX_SAFE_DIR } from "../../preflight/common/constants.ts";
import { resolveQwenCli } from "../../preflight/common/resolve.ts";

const H = homeState.home;
const P = RELOC_DIR;

beforeEach(() => {
  homeState.home = H;
  homeState.user = "tester";
  relocState.exists = true;
});

describe("resolveQwenCli — Linux relocation", () => {
  it("guards the literal RELOC_DIR against a LINUX_SAFE_DIR rename", () => {
    // If this fails, update RELOC_DIR in the mock factory above to /home/<new>/<user>.
    expect(LINUX_SAFE_DIR).toBe("work");
    expect(P).toBe(NodePath.join("/home", LINUX_SAFE_DIR, homeState.user));
  });

  it("reloc (P exists): app root moves to P, CLI profile stays under home, legacyRoot=H/APP", () => {
    const r = resolveQwenCli({ platform: "linux", env: {} });
    expect(r.ourRoot).toBe(NodePath.join(P, APP_HOME_DIRNAME)); // app relocates to P
    expect(r.configDir).toBe(NodePath.join(H, PREFLIGHT_CLI_PROBE_DIRNAME)); // flag=false → stays at H
    expect(r.configDirAlt).toBe(NodePath.join(P, PREFLIGHT_CLI_PROBE_DIRNAME)); // the OTHER candidate
    expect(r.legacyRoot).toBe(NodePath.join(H, APP_HOME_DIRNAME)); // orphaned home copy to clean up
  });

  it("no reloc (P absent): everything stays under home, no configDirAlt, no legacyRoot", () => {
    relocState.exists = false;
    const r = resolveQwenCli({ platform: "linux", env: {} });
    expect(r.ourRoot).toBe(NodePath.join(H, APP_HOME_DIRNAME));
    expect(r.configDir).toBe(NodePath.join(H, PREFLIGHT_CLI_PROBE_DIRNAME));
    expect(r.configDirAlt).toBe("");
    expect(r.legacyRoot).toBeUndefined();
  });

  it("no passwd entry (userInfo throws): no relocation even if P would exist", () => {
    homeState.user = ""; // → userInfo() throws → resolver stays in home
    const r = resolveQwenCli({ platform: "linux", env: {} });
    expect(r.ourRoot).toBe(NodePath.join(H, APP_HOME_DIRNAME));
    expect(r.configDir).toBe(NodePath.join(H, PREFLIGHT_CLI_PROBE_DIRNAME));
    expect(r.configDirAlt).toBe("");
    expect(r.legacyRoot).toBeUndefined();
  });

  it("uses os.homedir() for the parent — a different os.homedir() moves both roots", () => {
    homeState.home = "/home/other-home";
    relocState.exists = false; // isolate the home-parent effect from relocation
    const r = resolveQwenCli({ platform: "linux", env: {} });
    expect(r.ourRoot).toBe(NodePath.join("/home/other-home", APP_HOME_DIRNAME));
    expect(r.configDir).toBe(NodePath.join("/home/other-home", PREFLIGHT_CLI_PROBE_DIRNAME));
  });
});
