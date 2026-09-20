import { ArrowLeftIcon, GitPullRequestIcon, SettingsIcon } from "lucide-react";
// ru-code: "Reload CLI" header action (icon + confirm modal), right of the brand.
import { CliReloadHeaderAction } from "../../ru-code/cliReload/CliReloadHeaderAction";
// ru-code: the fork's single footer seam (auto-update pill + feature rows).
import { RuCodeFeaturesMenu } from "../../ru-code/sidebar/RuCodeFeaturesMenu";
// ru-code: global-panel triggers (skills/agents/commands/mcp) live in the footer icon row.
import { useNavPanels } from "../../ru-code/skills-agents/rightGlobalPanel/registry";
import { PluginIcon } from "../../ru-code/plugins/PluginIcon"; // ru-code: plugins — lucide-by-name glyph
import { usePluginNavEntries } from "../../ru-code/plugins/slots"; // ru-code: plugins — footer rail entries
import {
  useRightGlobalPanelStore,
  type GlobalPanelId,
} from "../../ru-code/skills-agents/rightGlobalPanel/store";

// ru-code: which whole-area page the bar is on (/usage, /pull-requests).
import { resolveSidebarFooterPage } from "../../ru-code/sidebar/footerPage";
import { APP_NAME, PR_STATUS_LOOKUP_ENABLED } from "@ru-code/branding"; // ru-code

import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      <CliReloadHeaderAction onBackdrop={backdropVariant !== null} /> {/* ru-code */}
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      {/* ru-code: T3Wordmark dropped; the fork's name is the wordmark. */}
      <span
        className={cn(
          "-translate-y-px truncate text-sm font-semibold tracking-tight", // ru-code
          onBackdrop ? "text-white/70" : "text-foreground/90", // ru-code
        )}
      >
        {APP_NAME}
      </span>
    </Link>
  );
}

// ru-code: PR status lookup kill switch (@ru-code/branding). Pure decision — exported for
// tests — mirrors isTerminalUiEnabledForOs's precedent for gating sidebar UI on a fork const
// without standing up a router/provider render harness just to pin one boolean.
export function isPullRequestsFooterTriggerVisible(pullRequestsSupported: boolean): boolean {
  return pullRequestsSupported && PR_STATUS_LOOKUP_ENABLED;
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // ru-code: which whole-area page the bar is on, via the shared helper.
  const currentFooterPage = useLocation({
    select: (location) => resolveSidebarFooterPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  // ru-code: PR_STATUS_LOOKUP_ENABLED folded in via isPullRequestsFooterTriggerVisible — the
  // footer trigger for the standalone Pull Requests list is hidden entirely when the fork's
  // automatic PR lookup is off, default OFF.
  const pullRequestsSupported = isPullRequestsFooterTriggerVisible(
    environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    ),
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/" });
  }, [closeMobileSidebar, navigate]);

  // ru-code: global panels (skills/agents/commands/mcp) — same toggle the text menu used;
  // the open panel's icon stays selected via isActive until the panel closes.
  const openGlobalPanel = useRightGlobalPanelStore((state) => state.open);
  const toggleGlobalPanel = useRightGlobalPanelStore((state) => state.toggle);
  // ru-code: reactive registry read — see the comment on the icon row below.
  const navPanelEntries = useNavPanels();
  // ru-code: plugins — footer entries for plugin PAGES and for TAB-mounted panels (V2-27). Each
  // entry carries its own action, so this file neither navigates nor opens a panel for a plugin.
  const pluginPageEntries = usePluginNavEntries();
  const handleGlobalPanelClick = useCallback(
    (id: GlobalPanelId) => {
      closeMobileSidebar();
      toggleGlobalPanel(id);
    },
    [closeMobileSidebar, toggleGlobalPanel],
  );

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <RuCodeFeaturesMenu /> {/* ru-code */}
      {/* ru-code: flex-wrap — the icon row breaks onto a second line when too narrow. */}
      <SidebarMenu className="flex-row flex-wrap items-center">
        {currentFooterPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Settings"
                      onClick={handleSettingsClick}
                      size="icon"
                    >
                      <SettingsIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Settings</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
            {pullRequestsSupported ? (
              <SidebarMenuItem className="shrink-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Pull Requests"
                        onClick={handlePullRequestsClick}
                        size="icon"
                      >
                        <GitPullRequestIcon />
                      </SidebarMenuButton>
                    }
                  />
                  <TooltipPopup side="top">Pull Requests</TooltipPopup>
                </Tooltip>
              </SidebarMenuItem>
            ) : null}
            {/* ru-code: global-panel triggers — same item shape as
                Settings above; selected (isActive) while their panel is open. The row
                flex-wraps onto a second line when the sidebar is too narrow. `navPanels()` is
                the registry (seed + whatever a dropped-in plugin registered) minus the
                `navHidden` entries (the extended view's detail panel opens from the thread,
                never from an icon). It is READ REACTIVELY (`useNavPanels`): plugins load
                after the first render (A4 H2/M2), so a plugin's icon appears when the plugin
                registers it, not only if it beat `createRoot`. */}
            {navPanelEntries.map((panel) => {
              const Icon = panel.icon;
              return (
                <SidebarMenuItem className="shrink-0" key={panel.id}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton
                          aria-label={panel.label}
                          isActive={openGlobalPanel === panel.id}
                          onClick={() => handleGlobalPanelClick(panel.id)}
                          size="icon"
                        >
                          <Icon />
                        </SidebarMenuButton>
                      }
                    />
                    <TooltipPopup side="top">{panel.label}</TooltipPopup>
                  </Tooltip>
                </SidebarMenuItem>
              );
            })}
            {/* ru-code: plugins — one footer button per plugin PAGE, and per TAB-mounted panel, that
                asked for a nav entry (V2-27). Same item shape as the panels above; the icon is a
                lucide NAME the host renders, and `activate` is the entry's own action — a route for
                a page, the thread's right panel for a tab. A tab entry off a thread is DISABLED:
                there is no panel to open it in. */}
            {pluginPageEntries.map((entry) => (
              <SidebarMenuItem className="shrink-0" key={entry.key}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        aria-label={entry.label}
                        disabled={entry.disabled}
                        onClick={() => {
                          closeMobileSidebar();
                          entry.activate();
                        }}
                        size="icon"
                      >
                        <PluginIcon name={entry.icon} />
                      </SidebarMenuButton>
                    }
                  />
                  <TooltipPopup side="top">{entry.label}</TooltipPopup>
                </Tooltip>
              </SidebarMenuItem>
            ))}
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
