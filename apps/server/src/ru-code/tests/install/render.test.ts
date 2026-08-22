// ru-code: banner geometry — box_line pads (ANSI-stripped, UTF-8 aware) to the box width and
// clamps over-long content; cmd_row aligns the description at a fixed column. Deterministic in the
// non-TTY harness (color codes resolve to empty), so the visible widths are exact.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval } from "./harness.ts";

/** The inner span between the two box walls (│…│) of a rendered box_line. */
function innerSpan(line: string): string {
  const parts = line.split("║");
  return parts.length >= 3 ? (parts[1] ?? "") : "";
}

describe("install box_line", () => {
  it("pads short content to the box inner width (63)", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `box_line "hello"`);
      expect(r.status).toBe(0);
      const span = innerSpan(r.stdout);
      expect(span.length).toBe(63);
      expect(span.startsWith("hello")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("clamps (never truncates) content wider than the box", () => {
    const sb = makeSandbox();
    try {
      const wide = "x".repeat(70);
      const r = sourceEval(sb, `box_line "${wide}"`);
      expect(r.status).toBe(0);
      const span = innerSpan(r.stdout);
      expect(span.length).toBe(70);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install cmd_row", () => {
  it("aligns the description at the given column", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `cmd_row 20 "cmd" "desc"`);
      expect(r.status).toBe(0);
      const line = r.stdout.replace(/\n$/, "");
      expect(line).toContain("cmd");
      // 4 leading spaces + width(20) → description starts at column 24
      expect(line.indexOf("desc")).toBe(24);
    } finally {
      sb.cleanup();
    }
  });
});
