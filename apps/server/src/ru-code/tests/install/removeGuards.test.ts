// ru-code: the SAFETY-CRITICAL deletion guards. Each asserts BOTH that a legitimate target is
// removed AND that every dangerous shape is refused (dir preserved). All targets live inside the
// sandbox; the guards' own refusals (/, $HOME, /home, /Users, */work/*, wrong basename, empty
// app-dir-name) are exercised with sandbox stand-ins.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval } from "./harness.ts";

describe("install remove_bin", () => {
  it("removes a real .../<appdir>/bin", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/.keep", "");
      const r = sourceEval(sb, `remove_bin`, {
        globals: { BIN_DIR: sb.path("app/.ru-code/bin"), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses a path that is not .../<appdir>/bin", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/notbin/.keep", "");
      const r = sourceEval(sb, `remove_bin`, {
        globals: { BIN_DIR: sb.path("app/.ru-code/notbin"), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("подозрительный");
      expect(sb.exists("app/.ru-code/notbin")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses when APP_DIR_NAME is empty", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/.keep", "");
      const r = sourceEval(sb, `remove_bin`, {
        globals: { BIN_DIR: sb.path("app/.ru-code/bin"), APP_DIR_NAME: "" },
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("не определено");
      expect(sb.exists("app/.ru-code/bin")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install remove_legacy_root", () => {
  it("removes a real legacy .../<appdir>", () => {
    const sb = makeSandbox();
    try {
      sb.write("legacy/.ru-code/.keep", "");
      const r = sourceEval(sb, `remove_legacy_root`, {
        globals: { LEGACY_ROOT: sb.path("legacy/.ru-code"), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("legacy/.ru-code")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses a path containing /work/ (the install target, not an orphan)", () => {
    const sb = makeSandbox();
    try {
      sb.write("work/u/.ru-code/.keep", "");
      const r = sourceEval(sb, `remove_legacy_root`, {
        globals: { LEGACY_ROOT: sb.path("work/u/.ru-code"), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.all).toContain("work");
      expect(sb.exists("work/u/.ru-code")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses $HOME itself", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/marker", "keep");
      const r = sourceEval(sb, `remove_legacy_root`, {
        globals: { LEGACY_ROOT: sb.home, APP_DIR_NAME: ".ru-code" },
      });
      expect(r.all).toContain("Отказ удалять");
      expect(sb.exists("home/marker")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses a path whose basename is not the app dir name", () => {
    const sb = makeSandbox();
    try {
      sb.write("legacy/other/.keep", "");
      const r = sourceEval(sb, `remove_legacy_root`, {
        globals: { LEGACY_ROOT: sb.path("legacy/other"), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.all).toContain("подозрительный");
      expect(sb.exists("legacy/other")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses when APP_DIR_NAME is empty", () => {
    const sb = makeSandbox();
    try {
      sb.write("legacy/.ru-code/.keep", "");
      const r = sourceEval(sb, `remove_legacy_root`, {
        globals: { LEGACY_ROOT: sb.path("legacy/.ru-code"), APP_DIR_NAME: "" },
      });
      expect(r.all).toContain("не определено");
      expect(sb.exists("legacy/.ru-code")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install remove_source_dir", () => {
  it("removes the clone dir by default", () => {
    const sb = makeSandbox();
    try {
      sb.write("clone/x/.keep", "");
      const r = sourceEval(sb, `remove_source_dir`, {
        globals: { SOURCE_DIR: sb.path("clone/x"), KEEP_SOURCE: "false" },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("clone/x")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("keeps the clone dir under --keep-source", () => {
    const sb = makeSandbox();
    try {
      sb.write("clone/x/.keep", "");
      const r = sourceEval(sb, `remove_source_dir`, {
        globals: { SOURCE_DIR: sb.path("clone/x"), KEEP_SOURCE: "true" },
      });
      expect(r.all).toContain("сохранён");
      expect(sb.exists("clone/x")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses $HOME", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/marker", "keep");
      const r = sourceEval(sb, `remove_source_dir`, {
        globals: { SOURCE_DIR: sb.home, KEEP_SOURCE: "false" },
      });
      expect(r.all).toContain("Отказ удалять");
      expect(sb.exists("home/marker")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("acts exactly once (idempotent across calls)", () => {
    const sb = makeSandbox();
    try {
      sb.write("clone/x/.keep", "");
      const r = sourceEval(sb, `remove_source_dir; remove_source_dir; echo DONE`, {
        globals: { SOURCE_DIR: sb.path("clone/x"), KEEP_SOURCE: "false" },
      });
      expect(r.stdout).toContain("DONE");
      const removedCount = r.all.split("удалён").length - 1;
      expect(removedCount).toBe(1);
    } finally {
      sb.cleanup();
    }
  });
});
