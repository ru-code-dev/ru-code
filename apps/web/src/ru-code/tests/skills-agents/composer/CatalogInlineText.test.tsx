import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildCatalogToken } from "@smart-tools/qwen-cli-catalog-core/contracts";

import { CatalogInlineText } from "../../../skills-agents/composer/CatalogInlineText";

describe("CatalogInlineText (sent-message bubble)", () => {
  it("renders skill + agent delimited tokens as chips, preserving surrounding text", () => {
    const text = `use ${buildCatalogToken("skill", "refactorer")} and ${buildCatalogToken("agent", "reviewer")} now`;
    const html = renderToStaticMarkup(<CatalogInlineText text={text} />);
    expect(html).toContain("Refactorer"); // skill chip label (formatted)
    expect(html).toContain("Reviewer"); // agent chip label (formatted)
    expect(html).toContain("fuchsia"); // skill chip colour family
    expect(html).toContain("emerald"); // agent chip colour family
    expect(html).toContain("use "); // leading text
    expect(html).toContain(" now"); // trailing text
  });

  // R4: the bubble shows the FORMATTED display name, while data-markdown-copy keeps the RAW wire token
  // (so copy/paste round-trips the real name and the send path is unaffected).
  it("shows the formatted display label but keeps the raw token in data-markdown-copy", () => {
    const text = `run ${buildCatalogToken("skill", "code-reviewer")}`;
    const html = renderToStaticMarkup(<CatalogInlineText text={text} />);
    expect(html).toContain("Code Reviewer"); // formatted visible label
    expect(html).toContain(`data-markdown-copy="${buildCatalogToken("skill", "code-reviewer")}"`);
    expect(buildCatalogToken("skill", "code-reviewer")).toContain("code-reviewer"); // raw name in token
  });

  it("passes plain text through unchanged (no chip markup)", () => {
    const html = renderToStaticMarkup(<CatalogInlineText text="hello world" />);
    expect(html).toContain("hello world");
    expect(html).not.toContain("data-markdown-copy");
  });
});
