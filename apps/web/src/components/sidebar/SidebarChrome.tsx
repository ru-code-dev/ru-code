import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon, // ru-code: analytics footer button (owner decision row 4)
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
// ru-code: the fork's single footer seam (auto-update pill + feature rows).
import { RuCodeFeaturesMenu } from "../../ru-code/sidebar/RuCodeFeaturesMenu";

// ru-code: which whole-area page the bar is on (analytics added — owner decision row 4).
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
  // ru-code: which whole-area page the bar is on, via the shared helper (analytics added).
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

  // ru-code: analytics — the parked Usage slot, re-pointed (owner decision row 4).
  const handleAnalyticsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/analytics" });
  }, [closeMobileSidebar, navigate]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/" });
  }, [closeMobileSidebar, navigate]);

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <RuCodeFeaturesMenu /> {/* ru-code */}
      <SidebarMenu className="flex-row items-center">
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
            {/* ru-code: the parked Usage slot, now the analytics entry (owner decision row 4).
                The /usage route and its Back state are untouched. */}
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Analytics"
                      onClick={handleAnalyticsClick}
                      size="icon"
                    >
                      <ChartNoAxesColumnIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Analytics</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
