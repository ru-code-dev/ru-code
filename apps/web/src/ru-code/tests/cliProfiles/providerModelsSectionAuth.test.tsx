// ru-code: render proof that ProviderModelsSection surfaces per-model auth for qwen —
// each model row shows its auth-method label, the add form gains the auth-method
// dropdown, and "Auto" reflects the EFFECTIVE instance default passed in
// (`authFallback`), not just the profile. When authFallback is omitted (non-qwen)
// neither appears, so the auth UI is strictly qwen-gated.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { AuthMethodId } from "@ru-code/branding";

import { ProviderModelsSection } from "../../../components/settings/ProviderModelsSection";

const QWEN = ProviderDriverKind.make("qwen");
const INSTANCE = ProviderInstanceId.make("qwen");
const noop = () => {};

const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    isCustom: false,
    capabilities: null,
    authType: "openai",
  },
  { slug: "custom-x", name: "custom-x", isCustom: true, capabilities: null, authType: "anthropic" },
  // no authType → its row's "Auto" must show the fallback (immediate-feedback synth).
  { slug: "pending", name: "pending", isCustom: true, capabilities: null },
];

const render = (props: { readonly authFallback?: AuthMethodId }) =>
  renderToStaticMarkup(
    <ProviderModelsSection
      instanceId={INSTANCE}
      driverKind={QWEN}
      models={models}
      customModels={["custom-x", "pending"]}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={noop}
      onHiddenModelsChange={noop}
      onFavoriteModelsChange={noop}
      onModelOrderChange={noop}
      {...(props.authFallback
        ? { authFallback: props.authFallback, onAddModelWithAuth: noop }
        : {})}
    />,
  );

describe("ProviderModelsSection — per-model auth (qwen)", () => {
  it("shows each model's auth-method label when authFallback is set", () => {
    const markup = render({ authFallback: "qwen-oauth" });
    expect(markup).toContain("OpenAI API"); // qwen3-coder-plus → openai
    expect(markup).toContain("Anthropic"); // custom-x → anthropic
  });

  it("a model with no resolved auth shows Auto with the fallback; add form matches", () => {
    const markup = render({ authFallback: "qwen-oauth" });
    // both the 'pending' row's Auto and the add-form Auto read the fallback
    expect(markup).toContain("Auto (Qwen OAuth)");
  });

  it("Auto honors the EFFECTIVE instance default (override), not just the profile", () => {
    // authFallback = anthropic simulates a card default-auth override; the profile
    // default (qwen-oauth) must NOT be what Auto shows.
    const markup = render({ authFallback: "anthropic" });
    expect(markup).toContain("Auto (Anthropic)");
    expect(markup).not.toContain("Auto (Qwen OAuth)");
  });

  it("shows NO auth UI when authFallback is omitted (non-qwen drivers)", () => {
    const markup = render({});
    expect(markup).not.toContain("OpenAI API");
    expect(markup).not.toContain("Anthropic");
    expect(markup).not.toContain("Auto (");
  });
});
