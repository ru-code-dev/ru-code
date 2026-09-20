// ru-code: which whole-area page the sidebar's bottom bar is currently sitting on, if any. Lives in
// the fork zone (beside RuCodeFeaturesMenu) so SidebarChrome.tsx carries one marked import instead
// of a growing ternary, and so each branch is testable without rendering the sidebar.
//
// A PLUGIN PAGE (`/plugins/<pluginId>/<pageId>`, decision V2-4) IS one of these (S22, owner): it is
// a whole-area page like `/usage`, and the bar collapses to the same Back button on it — with no
// plugin involvement, because the route is the app's own. Back keeps the behaviour it has on the
// other two: it returns to the threads.
export type SidebarFooterPage = "usage" | "pull-requests" | "plugin-page";

/** The host-owned plugin page route, `apps/web/src/routes/plugins.$pluginId.$pageId.tsx`. */
const PLUGIN_PAGE_PATH = /^\/plugins\/[^/]+\/[^/]+\/?$/;

export function resolveSidebarFooterPage(pathname: string): SidebarFooterPage | null {
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pull-requests";
  if (PLUGIN_PAGE_PATH.test(pathname)) return "plugin-page";
  return null;
}
