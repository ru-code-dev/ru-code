// ru-code: the presentation layer — the cyan→violet truecolor gradient wordmark (ported from
// ru-code/daemon/src/paint.ts), the brand line, and the progress bar geometry.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval } from "./harness.ts";

describe("install gradient", () => {
  it("emits a 24-bit truecolor escape per character, ramping cyan→violet", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `gradient "Ru"`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("38;2;56;217;238"); // first char = cyan endpoint
      expect(r.stdout).toContain("38;2;167;139;250"); // last char = violet endpoint
      expect(r.stdout).toContain("R");
      expect(r.stdout).toContain("u");
    } finally {
      sb.cleanup();
    }
  });

  it("passes spaces through without an escape", () => {
    const sb = makeSandbox();
    try {
      // "A B" → the middle space stays a bare space (no color run for it)
      const r = sourceEval(sb, `gradient "A B" | cat -v`);
      expect(r.stdout).toContain("A");
      expect(r.stdout).toContain("B");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install brand_wordmark", () => {
  it("is plain off-TTY", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `brand_wordmark`, { globals: { TTY: "0" } });
      expect(r.stdout).toContain("> Ru Code");
    } finally {
      sb.cleanup();
    }
  });

  it("uses the gradient on a truecolor TTY", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `brand_wordmark`, {
        env: { COLORTERM: "truecolor" },
        globals: { TTY: "1", TRUECOLOR: "1" },
      });
      expect(r.stdout).toContain("38;2;"); // truecolor escape present
    } finally {
      sb.cleanup();
    }
  });

  it("degrades to a plain bold wordmark on a non-truecolor TTY (no gradient)", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `brand_wordmark`, { globals: { TTY: "1", TRUECOLOR: "0" } });
      expect(r.stdout).not.toContain("38;2;");
      expect(r.stdout).toContain("Ru Code");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install box_line width", () => {
  it("pads by DISPLAY width so a Cyrillic row aligns with a Latin row of equal length (UTF-8 measure)", () => {
    const sb = makeSandbox();
    try {
      const cyr = sourceEval(sb, `BOX_INNER=63; box_line "Проверка окружения"`, {
        env: { LC_ALL: "C.UTF-8" },
      });
      const lat = sourceEval(sb, `BOX_INNER=63; box_line "Test environment!!"`, {
        env: { LC_ALL: "C.UTF-8" },
      });
      // Both content strings are 18 characters; correct (char, not byte) measurement pads both to the
      // same total width. A byte-count would under-pad the Cyrillic row, making it shorter.
      const cLen = cyr.stdout.replace(/\n+$/, "").length;
      const lLen = lat.stdout.replace(/\n+$/, "").length;
      expect(cLen).toBe(lLen);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install draw_bar", () => {
  it("renders an empty bar at 0% and a full bar at 100%", () => {
    const sb = makeSandbox();
    try {
      const empty = sourceEval(sb, `draw_bar 0 "x"`);
      const full = sourceEval(sb, `draw_bar 100 "x"`);
      expect(empty.stdout).toContain("░");
      expect(empty.stdout).not.toContain("▓");
      expect(full.stdout).toContain("▓");
      expect(full.stdout).not.toContain("░");
      expect(full.stdout).toContain("100%");
    } finally {
      sb.cleanup();
    }
  });
});
