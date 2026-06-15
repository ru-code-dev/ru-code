import { describe, expect, it } from "vitest";

import { extractText } from "../src/extract.ts";

describe("extractText", () => {
  it("unwraps a single fenced block", () => {
    expect(extractText("```\n<div></div>\n```").text).toBe("<div></div>");
  });

  it("unwraps a fenced block with a language tag", () => {
    expect(extractText("```html\n<p>hi</p>\n```").text).toBe("<p>hi</p>");
  });

  it("unwraps a fence with no trailing newline before the closing fence", () => {
    expect(extractText("```html\n<p>hi</p>```").text).toBe("<p>hi</p>");
  });

  it("returns the trimmed whole when there is no single fence", () => {
    expect(extractText("  just text  ").text).toBe("just text");
  });

  it("returns the whole when there are multiple fences (not a single block)", () => {
    const raw = "```\na\n```\n```\nb\n```";
    expect(extractText(raw).text).toBe(raw);
  });
});
