// ru-code: render proof that the REAL ModelListRow presents a context-disabled
// model as disabled — the combobox row carries the disabled state, keeps the
// not-allowed cursor treatment, and the row is wrapped in the reason tooltip.
//
// NOTE: the unit project runs in Node (no DOM), so base-ui's portaled tooltip
// POPUP does not render in renderToStaticMarkup — the reason TEXT itself is
// pinned by the picker's pure pipeline (CONTEXT_OVERFLOW_DISABLED_REASON in
// modelListView + the ModelPickerContent seam that feeds it as disabledReason).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { Combobox } from "~/components/ui/combobox";
import { ModelListRow } from "~/components/chat/ModelListRow";
import { CONTEXT_OVERFLOW_DISABLED_REASON } from "~/ru-code/modelPicker/modelListView";

const QWEN = ProviderDriverKind.make("qwen");
const INSTANCE = ProviderInstanceId.make("qwen");

const renderRow = (disabledReason: string | null) =>
  renderToStaticMarkup(
    <Combobox items={[`${INSTANCE}:acme/chat-mini`]}>
      <ModelListRow
        index={0}
        model={{ slug: "acme/chat-mini", name: "Acme Chat Mini", contextWindowTokens: 32_768 }}
        instanceId={INSTANCE}
        driverKind={QWEN}
        providerDisplayName="qwen"
        isFavorite={false}
        isSelected={false}
        showProvider
        useTriggerLabel={false}
        disabledReason={disabledReason}
        onToggleFavorite={() => {}}
      />
    </Combobox>,
  );

describe("ModelListRow — context-disabled row", () => {
  it("renders the row disabled with the not-allowed treatment when a reason is set", () => {
    const markup = renderRow(CONTEXT_OVERFLOW_DISABLED_REASON);
    expect(markup).toContain("cursor-not-allowed");
    expect(markup).toContain('aria-disabled="true"');
    // The favorite toggle inside the row is disabled too.
    expect(markup).toContain("disabled=");
  });

  it("renders a normal, enabled row when there is no reason", () => {
    const markup = renderRow(null);
    // ru-code: fixture rot fix (F2/F3) — the combobox item's base class list now
    // always carries the `data-disabled:cursor-not-allowed` Tailwind variant
    // (a CSS selector, present whether or not the row is actually disabled), so
    // a raw substring check on "cursor-not-allowed" can no longer tell the two
    // states apart. The real, state-varying signal is the `aria-disabled`
    // attribute itself.
    expect(markup).not.toContain('aria-disabled="true"');
  });
});
