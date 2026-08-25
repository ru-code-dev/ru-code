// ru-code: the analytics settings page host. Adapts the host runtime (primary environment
// + RPC commands) to the package's AnalyticsWebPorts, then renders the shared dashboard
// inside its provider — the same shape as the MCP panel host.

import { lazy, Suspense, useMemo } from "react";

import { getLocale } from "@ru-code/localization";
import { AnalyticsError } from "@smart-tools/qwen-cli-analytics/contracts";
import {
  AnalyticsProvider,
  configureAnalyticsLocale,
  type AnalyticsWebPorts,
} from "@smart-tools/qwen-cli-analytics/web";

const LazyAnalyticsDashboard = lazy(() =>
  import("@smart-tools/qwen-cli-analytics/web/dashboard").then((m) => ({
    default: m.AnalyticsDashboard,
  })),
);

import { usePrimaryEnvironmentId } from "~/state/environments";

import {
  analyticsGetSnapshot,
  analyticsRefresh,
  useAnalyticsConnectionPhase,
} from "./analyticsActions";

// ru-code: top-level page frame (owner decision row 4) — the same pieces the Usage page uses.
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

// The package resolves its own bilingual strings — point it at the app locale, exactly
// like the extended-chat host does. Module level, so it is wired before the first render;
// the package reads it per render (never a frozen module-level constant).
configureAnalyticsLocale(getLocale);

export function AnalyticsPage() {
  const environmentId = usePrimaryEnvironmentId();

  const ports = useMemo<AnalyticsWebPorts>(() => {
    // A TAGGED reason, not prose. The package renders localized copy per reason; the
    // literal Russian sentence that used to live here was printed verbatim to English
    // users — the one localization gap that lived on the host side of the seam.
    const noConnection = () =>
      Promise.reject(
        new AnalyticsError({
          reason: "scanner-unavailable",
          detail: "No active connection to the server.",
        }),
      );
    return {
      getSnapshot: () =>
        environmentId === null ? noConnection() : analyticsGetSnapshot(environmentId),
      refresh: () => (environmentId === null ? noConnection() : analyticsRefresh(environmentId)),
      // A hook, so the panel re-renders (and re-runs its fetch effect) when the socket
      // comes up. Reading a value here instead would freeze it inside this memo, which is
      // memoized on `environmentId` — and that does NOT change when the transport
      // connects. That stale capture is exactly the bug this gate exists to prevent.
      useConnectionPhase: () => useAnalyticsConnectionPhase(environmentId),
    };
  }, [environmentId]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Analytics breadcrumb">
              <WorkspaceBreadcrumbItem current>Analytics</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Analytics breadcrumb">
              <WorkspaceBreadcrumbItem current>Analytics</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <AnalyticsProvider ports={ports}>
          <Suspense>
            <LazyAnalyticsDashboard />
          </Suspense>
        </AnalyticsProvider>
      </div>
    </SidebarInset>
  );
}
