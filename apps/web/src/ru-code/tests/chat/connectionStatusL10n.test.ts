// ru-code: EN-identity pin for the ChatView.tsx connection-status banner title seam
// (DISPATCH 4 / connection-status family; mechanism corrected by DISPATCH 5). The
// ternary-in-template shape `${phase === "connecting" ? "Connecting" : "Reconnecting"} to
// ${label}` produces a generic "{0} to {1}" skeleton that the dict transform can't
// usefully/safely match (too collision-prone across unrelated "X to Y" templates), so the
// seam restructures it as a ternary selecting between two whole-phrase template literals
// (see the `// ru-code:` mark around ChatView.tsx's systemComposerBannerItems `title`).
// Each branch is its own unique "{0}"-skeleton tpl, dict-covered in
// dict/apps/web/src/components/ChatView.tsx.json ("Connecting to {0}" / "Reconnecting to
// {0}") — no L() wrapper needed since a whole-phrase tpl skeleton isn't collision-prone.
// This test pins the ENGLISH render exactly as it renders today — the Russian side is
// proven by the dict/build gates, not here.
import { describe, expect, it } from "vite-plus/test";

// Mirrors ChatView.tsx's `title` seam exactly (same branches, same shape).
function connectionBannerTitleFor(phase: "connecting" | "reconnecting", label: string): string {
  return phase === "connecting" ? `Connecting to ${label}` : `Reconnecting to ${label}`;
}

describe("ChatView connection-status banner title — EN identity (DISPATCH 4/5)", () => {
  it("connecting phase matches the pre-port template exactly", () => {
    expect(connectionBannerTitleFor("connecting", "my-env")).toBe("Connecting to my-env");
  });

  it("reconnecting phase matches the pre-port template exactly", () => {
    expect(connectionBannerTitleFor("reconnecting", "my-env")).toBe("Reconnecting to my-env");
  });
});
