// ru-code: render-level coverage of the extracted auto-compact settings row —
// the real SettingsRow + Switch markup (title, description, switch state).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AutoCompactContextRow } from "../../settings/AutoCompactContextRow";

function renderRow({ checked, isModified }: { checked: boolean; isModified: boolean }): string {
  return renderToStaticMarkup(
    <AutoCompactContextRow
      checked={checked}
      isModified={isModified}
      onCheckedChange={() => {}}
      onReset={() => {}}
    />,
  );
}

describe("auto-compact context settings row — rendered markup", () => {
  it("renders the row title", () => {
    const markup = renderRow({ checked: true, isModified: false });
    expect(markup).toContain("Auto-compact context");
  });

  it("renders the row description", () => {
    const markup = renderRow({ checked: true, isModified: false });
    expect(markup).toContain(
      "Automatically compact the conversation history when the context is over 75% full (for CLIs without built-in auto-compaction).",
    );
  });

  it("reflects checked=true in the switch state", () => {
    const markup = renderRow({ checked: true, isModified: false });
    expect(markup).toContain('aria-checked="true"');
    expect(markup).not.toContain('aria-checked="false"');
  });

  it("reflects checked=false in the switch state", () => {
    const markup = renderRow({ checked: false, isModified: false });
    expect(markup).toContain('aria-checked="false"');
    expect(markup).not.toContain('aria-checked="true"');
  });
});
