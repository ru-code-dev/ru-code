// ru-code: pure path/branch logic — detect_os (via a fake `uname`), to_msys_path (Windows
// drive→MSYS conversion), rc_files (unified scrub list), login_rc (login-bash file choice).

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, makeShimDir, pathWith, sourceEval } from "./harness.ts";

describe("install detect_os", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Linux", "linux"],
    ["Darwin", "darwin"],
    ["MINGW64_NT-10.0-19045", "windows"],
    ["MSYS_NT-10.0", "windows"],
    ["CYGWIN_NT-10.0", "windows"],
  ];
  for (const [uname, expected] of cases) {
    it(`maps uname ${uname} → ${expected}`, () => {
      const sb = makeSandbox();
      try {
        const shim = makeShimDir(sb, { uname: `echo ${uname}` });
        const r = sourceEval(sb, `detect_os; echo "OS=$OS"`, { env: { PATH: pathWith(shim) } });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`OS=${expected}`);
      } finally {
        sb.cleanup();
      }
    });
  }

  it("dies on an unsupported OS", () => {
    const sb = makeSandbox();
    try {
      const shim = makeShimDir(sb, { uname: `echo Plan9` });
      const r = sourceEval(sb, `detect_os; echo "OS=$OS"`, { env: { PATH: pathWith(shim) } });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("Система не поддерживается");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install to_msys_path", () => {
  it("converts a Windows drive path to MSYS form (lowercased drive)", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `echo "$(to_msys_path 'C:/Users/x/.ru-code/bin')"`);
      expect(r.stdout.trim()).toBe("/c/Users/x/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("passes a POSIX path straight through", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `echo "$(to_msys_path '/home/x/.ru-code/bin')"`);
      expect(r.stdout.trim()).toBe("/home/x/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install rc_files", () => {
  // One unified superset on every platform (6 without ZDOTDIR) — clean_rc must be able to scrub
  // every file add_path can create.
  it("lists the 6 rc candidates on POSIX", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `rc_files | wc -l`, { globals: { OS: "linux" } });
      expect(r.stdout.trim()).toBe("6");
    } finally {
      sb.cleanup();
    }
  });

  it("lists the same 6 candidates on Windows (unified list)", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `rc_files | wc -l`, { globals: { OS: "windows" } });
      expect(r.stdout.trim()).toBe("6");
    } finally {
      sb.cleanup();
    }
  });

  it("adds $ZDOTDIR/.zshrc when ZDOTDIR points elsewhere", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `rc_files | wc -l`, {
        globals: { OS: "linux" },
        env: { ZDOTDIR: "/custom/zdot" },
      });
      expect(r.stdout.trim()).toBe("7");
      const list = sourceEval(sb, `rc_files`, {
        globals: { OS: "linux" },
        env: { ZDOTDIR: "/custom/zdot" },
      });
      expect(list.stdout).toContain("/custom/zdot/.zshrc");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install login_rc", () => {
  it("picks the first existing of .bash_profile → .bash_login → .profile", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bash_login", "# login\n");
      sb.write("home/.profile", "# profile\n");
      const r = sourceEval(sb, `echo "$(login_rc)"`, { globals: { OS: "linux" } });
      // .bash_profile absent → .bash_login wins over the also-present .profile
      expect(r.stdout.trim().endsWith("/.bash_login")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("creates .profile (never .bash_profile) when none of the three exist", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `echo "$(login_rc)"`, { globals: { OS: "linux" } });
      expect(r.stdout.trim().endsWith("/.profile")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("prefers an existing .bash_profile over .profile (never masks .profile)", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bash_profile", "# bp\n");
      sb.write("home/.profile", "# p\n");
      const r = sourceEval(sb, `echo "$(login_rc)"`, { globals: { OS: "linux" } });
      expect(r.stdout.trim().endsWith("/.bash_profile")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});
