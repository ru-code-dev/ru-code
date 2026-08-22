// ru-code: create_and_init_starter_project — additive, non-fatal starter workspace. Creates a
// git repo + first commit under APP_ROOT/Project; skips if one exists; only warns (never fails)
// when git is unavailable. Uses real git in a sandbox APP_ROOT.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval } from "./harness.ts";

describe("install create_and_init_starter_project", () => {
  it("creates a Project git repo with a README", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/.keep", "");
      const r = sourceEval(sb, `create_and_init_starter_project`, {
        globals: { APP_ROOT: sb.path("app/.ru-code") },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/Project/.git")).toBe(true);
      expect(sb.exists("app/.ru-code/Project/README.md")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("skips when a Project repo already exists", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/Project/.git/.keep", "");
      const r = sourceEval(sb, `create_and_init_starter_project`, {
        globals: { APP_ROOT: sb.path("app/.ru-code") },
      });
      expect(r.status).toBe(0);
      expect(r.all).toContain("уже существует");
    } finally {
      sb.cleanup();
    }
  });

  it("only warns (RC 0) when git is unavailable", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/.keep", "");
      const r = sourceEval(
        sb,
        `command_exists() { return 1; }\ncreate_and_init_starter_project\necho "RC=$?"`,
        { globals: { APP_ROOT: sb.path("app/.ru-code") } },
      );
      expect(r.stdout).toContain("RC=0");
      expect(r.all).toContain("git не найден");
      expect(sb.exists("app/.ru-code/Project")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
