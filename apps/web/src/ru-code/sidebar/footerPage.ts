// ru-code: which whole-area page the sidebar's bottom bar is currently sitting on, if any. Lives in
// the fork zone (beside RuCodeFeaturesMenu) so SidebarChrome.tsx carries one marked import instead
// of a growing ternary, and so each branch is testable without rendering the sidebar.
export type SidebarFooterPage = "usage" | "pull-requests";

export function resolveSidebarFooterPage(pathname: string): SidebarFooterPage | null {
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pull-requests";
  return null;
}
