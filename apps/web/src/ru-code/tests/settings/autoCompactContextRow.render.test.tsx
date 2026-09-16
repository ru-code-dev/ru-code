// ru-code: render-level coverage of the extracted auto-compact settings row —
// the real SettingsRow + Switch markup (title, description, switch state).
//
// ru-code (qwen-compression wave): the row is GATED. No provider runs app-side
// auto-compaction any more (qwen 0.21.1 compresses itself before every model
// send), so `AutoCompactContextRow` renders nothing and the markup cases moved
// onto `AutoCompactContextRowBody` — which keeps them honest for the day the
// capability flips back, instead of deleting coverage for code that still ships.
import { APP_AUTO_COMPACTION_ANYWHERE } from "@ru-code/provider-capabilities";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AutoCompactContextRow,
  AutoCompactContextRowBody,
} from "../../settings/AutoCompactContextRow";

function renderRow({ checked, isModified }: { checked: boolean; isModified: boolean }): string {
  return renderToStaticMarkup(
    <AutoCompactContextRowBody
      checked={checked}
      isModified={isModified}
      onCheckedChange={() => {}}
      onReset={() => {}}
    />,
  );
}

describe("auto-compact context settings row — the gate", () => {
  it("no provider runs app-side auto-compaction", () => {
    expect(APP_AUTO_COMPACTION_ANYWHERE).toBe(false);
  });

  it("renders NOTHING while the feature is dormant", () => {
    const markup = renderToStaticMarkup(
      <AutoCompactContextRow
        checked={true}
        isModified={false}
        onCheckedChange={() => {}}
        onReset={() => {}}
      />,
    );
    expect(markup).toBe("");
  });
});

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
