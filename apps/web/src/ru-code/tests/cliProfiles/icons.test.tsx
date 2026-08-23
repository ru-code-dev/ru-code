// ru-code: render/e2e coverage for the brand-profile icons. Beyond the pure resolver
// it drives the REAL ProviderInstanceIcon (the hub used by the card + model pickers +
// composer) with our profile logic injected, and asserts the correct mark actually
// renders — plus that useId uniquifies the SVG ids so two icons on a page don't collide.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  CustomCodeIcon,
  QwenCodeIcon,
  iconForConfig,
  iconForProfile,
} from "../../cliProfiles/icons";
import { ProviderInstanceIcon } from "../../../components/chat/ProviderInstanceIcon";

const QWEN = ProviderDriverKind.make("qwen");
const OPENCODE = ProviderDriverKind.make("opencode");

describe("cli-profile icon components", () => {
  it("each mark renders its own data-cli-profile + viewBox", () => {
    const custom = renderToStaticMarkup(<CustomCodeIcon />);
    expect(custom).toContain('data-cli-profile="custom"');
    expect(custom).toContain('viewBox="0 0 65 64"');

    const qwen = renderToStaticMarkup(<QwenCodeIcon />);
    expect(qwen).toContain('data-cli-profile="qwen"');
    // ru-code: viewBox tightened to hug the artwork so the glyph fills the frame.
    expect(qwen).toContain('viewBox="26 15 150 150"');
  });

  it("useId uniquifies internal gradient ids across two renders (no collision)", () => {
    const markup = renderToStaticMarkup(
      <>
        <QwenCodeIcon />
        <QwenCodeIcon />
      </>,
    );
    const ids = [...markup.matchAll(/<radialGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(4); // 2 gradients × 2 renders
    expect(new Set(ids).size).toBe(4); // every id unique
    // and the fills reference those unique ids
    for (const id of ids) expect(markup).toContain(`url(#${id})`);
  });

  it("custom mark uniquifies its mask/filter ids too", () => {
    const markup = renderToStaticMarkup(
      <>
        <CustomCodeIcon />
        <CustomCodeIcon />
      </>,
    );
    const maskIds = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(maskIds.length).toBe(2);
    expect(new Set(maskIds).size).toBe(2);
  });
});

describe("iconForProfile / iconForConfig — resolver", () => {
  it("maps a profile id to its component", () => {
    expect(iconForProfile("custom")).toBe(CustomCodeIcon);
    expect(iconForProfile("qwen")).toBe(QwenCodeIcon);
  });
  it("maps an instance config blob to its component (default when absent)", () => {
    expect(iconForConfig({ profile: "qwen" })).toBe(QwenCodeIcon);
    expect(iconForConfig({ profile: "custom" })).toBe(CustomCodeIcon);
    expect(iconForConfig({})).toBe(CustomCodeIcon); // default profile
    expect(iconForConfig(null)).toBe(CustomCodeIcon);
  });
});

describe("ProviderInstanceIcon — profile-aware (e2e through the real hub component)", () => {
  it("renders the CUSTOM mark for a custom-profile qwen instance", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={QWEN} profile="custom" displayName="Custom Code" />,
    );
    expect(markup).toContain('data-cli-profile="custom"');
    expect(markup).not.toContain('data-cli-profile="qwen"');
  });

  it("renders the QWEN mark for a qwen-profile instance", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={QWEN} profile="qwen" displayName="Qwen Code" />,
    );
    expect(markup).toContain('data-cli-profile="qwen"');
    expect(markup).not.toContain('data-cli-profile="custom"');
  });

  it("two instances of different profiles render distinct marks side by side", () => {
    const markup = renderToStaticMarkup(
      <>
        <ProviderInstanceIcon driverKind={QWEN} profile="custom" displayName="Custom Code" />
        <ProviderInstanceIcon driverKind={QWEN} profile="qwen" displayName="Qwen Code" />
      </>,
    );
    expect(markup).toContain('data-cli-profile="custom"');
    expect(markup).toContain('data-cli-profile="qwen"');
  });

  it("no profile → qwen falls to the default-profile mark (never OpenAI); non-qwen unaffected", () => {
    // ru-code: the kind-level fallback for qwen now wears the default-profile
    // mark instead of a competitor's brand (OpenAI) — see providerIconUtils.ts:11.
    expect(
      renderToStaticMarkup(<ProviderInstanceIcon driverKind={QWEN} displayName="Qwen" />),
    ).toContain('data-cli-profile="custom"');
    expect(
      renderToStaticMarkup(<ProviderInstanceIcon driverKind={OPENCODE} displayName="OpenCode" />),
    ).not.toContain("data-cli-profile");
  });
});
