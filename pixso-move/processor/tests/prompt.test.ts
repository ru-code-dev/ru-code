import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/prompt.ts";

describe("buildPrompt", () => {
  it("includes the trimmed instruction, the output rule, the name, and fenced JSON", () => {
    const out = buildPrompt({
      prompt: "  Make HTML  ",
      rootName: "Hero",
      nodesJson: '{"id":"1"}',
    });
    expect(out).toContain("Make HTML");
    expect(out).not.toContain("  Make HTML  ");
    expect(out).toContain("Верни только результат, без пояснений.");
    expect(out).toContain("Компонент: Hero");
    expect(out).toContain("```json\n{\"id\":\"1\"}\n```");
  });

  it("is deterministic", () => {
    const input = { prompt: "p", rootName: "n", nodesJson: "{}" };
    expect(buildPrompt(input)).toBe(buildPrompt(input));
  });
});
