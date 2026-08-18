// ru-code: covers the token expander. `expand` replaces {home}/{appdata}/
// {localappdata} (NOT shell ~ or $VAR — those are never used) and normalizes.
// {home} resolves via os.homedir(), which honours $HOME on POSIX, so we pin
// $HOME at a throwaway dir; {appdata}/{localappdata} come from the passed env.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { expand } from "../../preflight/common/expand.ts";

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = "/home/tester";
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

describe("expand", () => {
  it("replaces {home} with the current homedir", () => {
    expect(expand("{home}/.qwen")).toBe(NodePath.join(NodeOS.homedir(), ".qwen"));
  });

  it("replaces every {home} occurrence (global flag)", () => {
    const out = expand("{home}/a/{home}/b");
    const home = NodeOS.homedir();
    expect(out).toBe(NodePath.normalize(`${home}/a/${home}/b`));
    expect(out).not.toContain("{home}");
  });

  it("replaces {appdata} from the supplied env", () => {
    const out = expand("{appdata}/npm/cli.js", { APPDATA: "C:/Users/x/AppData/Roaming" });
    expect(out).toContain("cli.js");
    expect(out).not.toContain("{appdata}");
  });

  it("replaces {localappdata} from the supplied env", () => {
    const out = expand("{localappdata}/cli.js", { LOCALAPPDATA: "C:/Users/x/AppData/Local" });
    expect(out).not.toContain("{localappdata}");
    expect(out).toContain("cli.js");
  });

  it("expands an unset {appdata} to an empty string (no leftover token)", () => {
    const out = expand("{appdata}/npm", {});
    expect(out).not.toContain("{appdata}");
    expect(out).toBe(NodePath.normalize("/npm"));
  });

  it("expands unset {localappdata} to empty", () => {
    const out = expand("{localappdata}/x", {});
    expect(out).not.toContain("{localappdata}");
  });

  it("normalizes the result (collapses ./ and ../ segments)", () => {
    expect(expand("/opt/foo/../bar")).toBe(NodePath.normalize("/opt/foo/../bar"));
    expect(expand("/opt/foo/../bar")).toBe("/opt/bar");
  });

  it("is a no-op (aside from normalization) when there are no tokens", () => {
    expect(expand("/usr/local/bin/cli.js")).toBe("/usr/local/bin/cli.js");
  });

  it("expands mixed {home} + {appdata} tokens together", () => {
    const out = expand("{home}/{appdata}/cli.js", { APPDATA: "roaming" });
    expect(out).toBe(NodePath.normalize(`${NodeOS.homedir()}/roaming/cli.js`));
  });
});
