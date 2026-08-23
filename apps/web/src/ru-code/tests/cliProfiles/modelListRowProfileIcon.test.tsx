// ru-code: the flat per-model rows in the chat + settings text-gen pickers must
// show the OWNING INSTANCE's brand-profile mark, not the stock kind glyph (qwen
// was falling back to the OpenAI mark). Renders the REAL ModelListRow and asserts
// the rendered SVG carries the right `data-cli-profile` for the profile it's given.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { CliProfileId } from "@ru-code/branding";

import { Combobox } from "~/components/ui/combobox";
import { ModelListRow } from "~/components/chat/ModelListRow";

const QWEN = ProviderDriverKind.make("qwen");
const OPENCODE = ProviderDriverKind.make("opencode");
const INSTANCE = ProviderInstanceId.make("qwen");

const renderRow = (input: {
  readonly driverKind: ProviderDriverKind;
  readonly profile?: CliProfileId;
}) =>
  renderToStaticMarkup(
    <Combobox items={[`${INSTANCE}:m`]}>
      <ModelListRow
        index={0}
        model={{ slug: "m", name: "My Model" }}
        instanceId={INSTANCE}
        driverKind={input.driverKind}
        {...(input.profile ? { profile: input.profile } : {})}
        providerDisplayName="My Instance"
        isFavorite={false}
        isSelected={false}
        showProvider
        useTriggerLabel={false}
        onToggleFavorite={() => {}}
      />
    </Combobox>,
  );

describe("ModelListRow — profile-aware provider icon", () => {
  it("renders the CUSTOM mark for a custom-profile qwen model row", () => {
    const markup = renderRow({ driverKind: QWEN, profile: "custom" });
    expect(markup).toContain('data-cli-profile="custom"');
    expect(markup).not.toContain('data-cli-profile="qwen"');
  });

  it("renders the QWEN mark for a stock-qwen-profile model row", () => {
    const markup = renderRow({ driverKind: QWEN, profile: "qwen" });
    expect(markup).toContain('data-cli-profile="qwen"');
    expect(markup).not.toContain('data-cli-profile="custom"');
  });

  it("renders the default-profile mark (never OpenAI) when no profile is set", () => {
    // ru-code: qwen with no profile falls back to the kind map, which now wears
    // the default-profile mark instead of a competitor's brand (OpenAI) — see
    // providerIconUtils.ts:11.
    const markup = renderRow({ driverKind: QWEN });
    expect(markup).toContain('data-cli-profile="custom"');
  });

  it("is unaffected for a non-profile driver (opencode → kind glyph)", () => {
    const markup = renderRow({ driverKind: OPENCODE });
    expect(markup).not.toContain("data-cli-profile");
  });
});
