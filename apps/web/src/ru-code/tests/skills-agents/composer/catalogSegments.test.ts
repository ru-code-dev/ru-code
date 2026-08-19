import { describe, expect, it } from "vite-plus/test";

import { buildCatalogToken } from "@smart-tools/qwen-cli-catalog-core/contracts";

import {
  collectComposerSegmentTokens,
  catalogSegmentExpandedLength,
} from "../../../skills-agents/composer/catalogSegments";
import { splitPromptIntoComposerSegments } from "../../../../composer-editor-mentions";
import {
  expandCollapsedComposerCursor,
  collapseExpandedComposerCursor,
} from "../../../../composer-logic";

const SKILL = buildCatalogToken("skill", "refactorer"); // skill:⟦refactorer⟧
const AGENT = buildCatalogToken("agent", "reviewer"); // agent:⟦reviewer⟧

describe("catalogSegments — collectComposerSegmentTokens", () => {
  it("parses delimited skill + agent tokens with correct kind and source", () => {
    const text = `use ${SKILL} then ${AGENT} ok`;
    const tokens = collectComposerSegmentTokens(text).filter((t) => {
      const s = t.build();
      return s.type === "catalog-skill" || s.type === "catalog-agent";
    });
    expect(tokens).toHaveLength(2);
    const first = tokens[0]!.build();
    const second = tokens[1]!.build();
    expect(first).toMatchObject({ type: "catalog-skill", name: "refactorer", source: SKILL });
    expect(second).toMatchObject({ type: "catalog-agent", name: "reviewer", source: AGENT });
  });

  it("keeps the native $skill and @mention tokens alongside catalog tokens, position-sorted", () => {
    const text = `$native and ${SKILL} `;
    const built = collectComposerSegmentTokens(text).map((t) => t.build().type);
    expect(built).toEqual(["skill", "catalog-skill"]);
  });
});

describe("catalogSegments — catalogSegmentExpandedLength", () => {
  it("returns the delimited source length for catalog segments", () => {
    const [seg] = collectComposerSegmentTokens(SKILL).map((t) => t.build());
    expect(catalogSegmentExpandedLength(seg!)).toBe(SKILL.length);
  });
  it("returns null for non-catalog segments", () => {
    expect(catalogSegmentExpandedLength({ type: "text", text: "hi" })).toBeNull();
    expect(catalogSegmentExpandedLength({ type: "skill", name: "x" })).toBeNull();
  });
});

describe("splitPromptIntoComposerSegments — catalog chips", () => {
  it("splits text around a delimited catalog token", () => {
    const segments = splitPromptIntoComposerSegments(`a ${SKILL} b`);
    expect(segments.map((s) => s.type)).toEqual(["text", "catalog-skill", "text"]);
  });
});

describe("composer cursor math — delimited catalog tokens", () => {
  // A chip is ONE collapsed char but its expanded length is the full delimited token. Collapse∘expand
  // must be identity at the token boundary (regression guard for the source.length cursor logic).
  const text = `x ${SKILL} y`;
  it("collapse(expand(collapsed)) === collapsed across the chip", () => {
    // collapsed positions: 'x'(0) ' '(1) [chip](2) ' '(3) 'y'(4) end(5)
    for (let collapsed = 0; collapsed <= 5; collapsed += 1) {
      const expanded = expandCollapsedComposerCursor(text, collapsed);
      expect(collapseExpandedComposerCursor(text, expanded)).toBe(collapsed);
    }
  });
});
