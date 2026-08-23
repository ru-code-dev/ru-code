// ru-code: pin for the left sidebar footer's Pull Requests trigger, gated by the PR status
// lookup kill switch (@ru-code/branding PR_STATUS_LOOKUP_ENABLED, default OFF). SidebarChromeFooter
// needs a TanStack Router + SidebarProvider + environments-store harness to render at all, so —
// mirroring the isTerminalUiEnabledForOs precedent (apps/web/src/ru-code/platform-compat/terminalUiGate.ts)
// — the gating decision is pulled out into a pure, exported predicate and pinned directly instead
// of standing up that render harness for one boolean.
import { describe, expect, it, vi } from "vite-plus/test";

import { isPullRequestsFooterTriggerVisible } from "~/components/sidebar/SidebarChrome";

describe("isPullRequestsFooterTriggerVisible — PR status lookup kill switch (default OFF)", () => {
  it("stays hidden even when a connected server supports pull requests", () => {
    expect(isPullRequestsFooterTriggerVisible(true)).toBe(false);
  });

  it("stays hidden when no server supports pull requests", () => {
    expect(isPullRequestsFooterTriggerVisible(false)).toBe(false);
  });
});

describe("isPullRequestsFooterTriggerVisible — PR status lookup ON (const flipped true)", () => {
  it("follows server support once more, as before the kill switch existed", async () => {
    vi.resetModules();
    vi.doMock("@ru-code/branding", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@ru-code/branding")>()),
      PR_STATUS_LOOKUP_ENABLED: true,
    }));
    const { isPullRequestsFooterTriggerVisible: isVisibleOn } =
      await import("~/components/sidebar/SidebarChrome");
    expect(isVisibleOn(true)).toBe(true);
    expect(isVisibleOn(false)).toBe(false);
    vi.doUnmock("@ru-code/branding");
    vi.resetModules();
  });
});
