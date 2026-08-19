// ru-code: RENDER-LEVEL coverage of the model-picker rail — disabled instances
// must be shown-but-not-selectable (disabled button + explanatory tooltip),
// available ones selectable. The instance-view composite is tested one layer
// below; nothing rendered the rail until now.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerSidebar } from "../../../components/chat/ModelPickerSidebar";
import { type ProviderInstanceEntry } from "../../../providerInstances";

function entry(input: { instanceId: string; driverKind?: string }): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: ProviderDriverKind.make(input.driverKind ?? input.instanceId),
    displayName: input.instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {} as ServerProvider,
    models: [],
  };
}

const DISABLED_TOOLTIP = "Недоступен в этом диалоге — продолжение использует другой CLI.";

describe("model picker rail — rendered instance buttons", () => {
  it("renders one button per instance; the context-disabled one is disabled with a tooltip", () => {
    const qwen = entry({ instanceId: "qwen" });
    const custom = entry({ instanceId: "qwen_custom", driverKind: "qwen" });
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        selectedInstanceId={qwen.instanceId}
        onSelectInstance={() => {}}
        instanceEntries={[qwen, custom]}
        showFavorites={false}
        disabledInstanceIds={new Set([custom.instanceId])}
        getDisabledInstanceTooltip={() => DISABLED_TOOLTIP}
      />,
    );
    expect(markup).toContain('data-model-picker-provider="qwen"');
    expect(markup).toContain('data-model-picker-provider="qwen_custom"');
    // Exactly one disabled rail button — the context-disabled instance.
    expect(markup.split('disabled=""').length - 1).toBe(1);
    expect(markup).toContain(DISABLED_TOOLTIP);
  });

  it("no disabled set: every instance button is selectable", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        selectedInstanceId={ProviderInstanceId.make("qwen")}
        onSelectInstance={() => {}}
        instanceEntries={[entry({ instanceId: "qwen" })]}
        showFavorites={false}
      />,
    );
    expect(markup).toContain('data-model-picker-provider="qwen"');
    expect(markup).not.toContain('disabled=""');
  });
});
