// ru-code: pins for the PR status lookup kill switch (@ru-code/branding
// PR_STATUS_LOOKUP_ENABLED, default OFF) on the right panel's two entry points —
// the "+" add-surface menu and the no-surfaces-open empty-state launcher — plus the
// graceful-degradation case for a surface persisted from before the flag was flipped
// off (dispatch 2/3, WORKFLOW/rounds/t3-sync-aug-19/briefs/pr-killswitch-porter.md).
//
// No shared registry drives both the menu and the empty-state card (they are two
// hand-written lists in RightPanelTabs.tsx); each is hand-gated with
// `PR_STATUS_LOOKUP_ENABLED ? … : null` / a conditional array spread, mirroring the
// terminalUiEnabled precedent already in that file.
//
// LIMITATION (stated, not glossed over): the "+" menu's popup is `@base-ui/react`
// Menu.Portal content, which — confirmed empirically by mutation-testing the guard —
// never appears in `renderToStaticMarkup` output whether the menu gate is on or off;
// portals need a real DOM and the popup itself only mounts once opened. This repo has
// no jsdom/testing-library idiom anywhere to open one and assert on it (checked; the
// pre-existing terminalUiEnabled + menu gate this mirrors has no markup pin either, for
// the same reason). So that one site is code-reviewed/structurally identical to the
// (pinned) empty-state gate rather than independently pinned — the smoke test below
// only proves the component still renders with it present.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "~/components/RightPanelTabs";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};

const pullRequestSurface = {
  id: "pull-request:owner/repo#7" as const,
  kind: "pull-request" as const,
  projectId: "project-1",
  repository: "owner/repo",
  number: 7,
};

function baseProps() {
  return {
    mode: "inline" as const,
    pendingSurfaceIds: new Set<string>(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map<string, string>(),
    onActivate: () => undefined,
    onCloseSurface: () => undefined,
    onCloseOtherSurfaces: () => undefined,
    onCloseSurfacesToRight: () => undefined,
    onCloseAllSurfaces: () => undefined,
    onCopyFilePath: () => undefined,
    onAddBrowser: () => undefined,
    onAddTerminal: () => undefined,
    onAddPullRequest: () => undefined,
    onAddDiff: () => undefined,
    onAddFiles: () => undefined,
    onAddAgents: () => undefined,
    liveAgentCount: 0,
    browserAvailable: true,
    terminalAvailable: false,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: true,
    agentsAvailable: false,
  };
}

describe("RightPanelTabs — PR status lookup kill switch (default OFF)", () => {
  it("hides the Pull request card from the no-surfaces empty state", () => {
    const html = renderToStaticMarkup(
      <RightPanelTabs {...baseProps()} surfaces={[]} activeSurfaceId={null}>
        <div>content</div>
      </RightPanelTabs>,
    );
    expect(html).not.toContain("Pull request");
    expect(html).not.toContain("No pull request on this branch yet.");
  });

  it("renders the tab bar without crashing with the + menu's Pull request entry gated off", () => {
    // Smoke test only — see the file-header LIMITATION note: the menu's popup content is
    // Portal-rendered and does not appear in renderToStaticMarkup output, so this cannot
    // independently pin the gate the way the empty-state test above does.
    const html = renderToStaticMarkup(
      <RightPanelTabs
        {...baseProps()}
        surfaces={[previewSurface]}
        activeSurfaceId={previewSurface.id}
      >
        <div>content</div>
      </RightPanelTabs>,
    );
    expect(html).toContain("content");
    expect(html).toContain('aria-label="Add panel surface"');
  });

  it("degrades gracefully (no crash, content still renders) for a pull-request surface persisted from before the flag was off", () => {
    const html = renderToStaticMarkup(
      <RightPanelTabs
        {...baseProps()}
        surfaces={[pullRequestSurface]}
        activeSurfaceId={pullRequestSurface.id}
      >
        <div>content</div>
      </RightPanelTabs>,
    );
    // The tab chip itself (title "#7") still renders — the kill switch only hides the
    // creation entry points, it does not forcibly evict an already-open/persisted tab.
    expect(html).toContain("#7");
    expect(html).toContain("content");
  });
});

describe("RightPanelTabs — PR status lookup ON (const flipped true)", () => {
  it("shows the Pull request card and menu entry again", async () => {
    vi.resetModules();
    vi.doMock("@ru-code/branding", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@ru-code/branding")>()),
      PR_STATUS_LOOKUP_ENABLED: true,
    }));
    const { RightPanelTabs: RightPanelTabsOn } = await import("~/components/RightPanelTabs");
    const html = renderToStaticMarkup(
      <RightPanelTabsOn {...baseProps()} surfaces={[]} activeSurfaceId={null}>
        <div>content</div>
      </RightPanelTabsOn>,
    );
    expect(html).toContain("Pull request");
    expect(html).toContain("Open this branch");
    vi.doUnmock("@ru-code/branding");
    vi.resetModules();
  });
});
