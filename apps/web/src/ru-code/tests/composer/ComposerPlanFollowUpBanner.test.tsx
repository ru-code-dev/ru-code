// ru-code: M11 — the plan-ready badge renders its localized text, never the
// opposite-locale literal, with or without a plan title.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPlanFollowUpBanner } from "../../../components/chat/ComposerPlanFollowUpBanner";

describe("ComposerPlanFollowUpBanner", () => {
  it("renders the badge and not the RU literal (planTitle null)", () => {
    const markup = renderToStaticMarkup(<ComposerPlanFollowUpBanner planTitle={null} />);
    expect(markup).toContain("Plan Ready");
    expect(markup).not.toContain("План готов");
  });

  it("keeps the badge alongside a plan title", () => {
    const markup = renderToStaticMarkup(
      <ComposerPlanFollowUpBanner planTitle="Рефакторинг адаптера" />,
    );
    expect(markup).toContain("Plan Ready");
    expect(markup).not.toContain("План готов");
    expect(markup).toContain("Рефакторинг адаптера");
  });
});
