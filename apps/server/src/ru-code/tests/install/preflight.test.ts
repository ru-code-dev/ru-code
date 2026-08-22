// ru-code: run_preflight — the KEY=VALUE contract parse. Keys are read regardless of the
// preflight's exit status; native backslash paths are normalized to forward slashes; --install-dir
// overrides OUR_ROOT; an empty OUR_ROOT rolls back and dies. NODE_PATH points at the real node so
// the fake preflight.mjs actually runs.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval, writeFakePreflight } from "./harness.ts";

const withNode = (extra?: Record<string, string>) => ({ NODE_PATH: process.execPath, ...extra });

describe("install run_preflight", () => {
  it("parses OUR_ROOT / APP_BIN / NODE_OK and derives BIN_DIR + app dir name", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        appBin: "ru-code",
        nodeOk: "1",
      });
      const r = sourceEval(
        sb,
        `run_preflight; echo "R=$APP_ROOT|B=$APP_BIN|N=$NODE_OK|BIN=$BIN_DIR|DN=$APP_DIR_NAME|S=$PREFLIGHT_STATUS"`,
        { globals: withNode(), env: { RU_CODE_PREFLIGHT: preflight } },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`R=${sb.appRoot}`);
      expect(r.stdout).toContain("B=ru-code");
      expect(r.stdout).toContain("N=1");
      expect(r.stdout).toContain(`BIN=${sb.appRoot}/bin`);
      expect(r.stdout).toContain("DN=.ru-code");
      expect(r.stdout).toContain("S=0");
    } finally {
      sb.cleanup();
    }
  });

  it("normalizes Windows backslash paths to forward slashes", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: "C:\\Users\\x\\.ru-code",
        legacyRoot: "D:\\old\\.ru-code",
      });
      const r = sourceEval(sb, `run_preflight; echo "R=$APP_ROOT|L=$LEGACY_ROOT"`, {
        globals: withNode(),
        env: { RU_CODE_PREFLIGHT: preflight },
      });
      expect(r.stdout).toContain("R=C:/Users/x/.ru-code");
      expect(r.stdout).toContain("L=D:/old/.ru-code");
      expect(r.stdout).not.toContain("\\");
    } finally {
      sb.cleanup();
    }
  });

  it("--install-dir overrides the reported OUR_ROOT", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      const r = sourceEval(sb, `run_preflight; echo "R=$APP_ROOT|BIN=$BIN_DIR"`, {
        globals: withNode({ INSTALL_DIR: "/opt/custom/.ru-code" }),
        env: { RU_CODE_PREFLIGHT: preflight },
      });
      expect(r.stdout).toContain("R=/opt/custom/.ru-code");
      expect(r.stdout).toContain("BIN=/opt/custom/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("keeps keys even when the preflight exits non-zero (incompatible env)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, nodeOk: "0", status: 1 });
      const r = sourceEval(sb, `run_preflight; echo "R=$APP_ROOT|N=$NODE_OK|S=$PREFLIGHT_STATUS"`, {
        globals: withNode(),
        env: { RU_CODE_PREFLIGHT: preflight },
      });
      expect(r.stdout).toContain(`R=${sb.appRoot}`);
      expect(r.stdout).toContain("N=0");
      expect(r.stdout).toContain("S=1");
    } finally {
      sb.cleanup();
    }
  });

  it("crashes when OUR_ROOT is missing (no path resolved)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { emitKeys: false });
      const r = sourceEval(sb, `run_preflight`, {
        globals: withNode(),
        env: { RU_CODE_PREFLIGHT: preflight },
      });
      expect(r.status).toBe(2); // BLOCKED_CRASH
      expect(r.all).toContain("Что-то пошло не так");
    } finally {
      sb.cleanup();
    }
  });
});
