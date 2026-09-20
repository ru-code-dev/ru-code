// ru-code: the app-side adapters a host-agnostic feature package needs — the app's theme, project
// list, toasts and active project, behind the `ItemManagerWebPorts`-shaped hooks/callbacks those
// packages call. A25 moved the three catalog panels into `@smart-tools/plugin-catalogs` (which gets
// the same values from the plugin host); the remaining consumer is the MCP manager panel, and it
// leaves with its own ports when that is ported.

import { useMemo } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { useProjects } from "~/state/entities";

import { useActiveProjectId } from "./activeProject.ts";

/** Resolved light/dark theme for the panel's syntax highlighting. */
export function useResolvedTheme(): "light" | "dark" {
  return useTheme().resolvedTheme;
}

/**
 * The cross-environment project list, shaped for the catalog. The project `id` is its stable
 * `ProjectId` — the SAME identity the catalog keys by (`listLive` returns `{id: projectId,
 * cwd: workspaceRoot}`) and the runtime carries (`thread.projectId`); `cwd` is the workspaceRoot
 * where connecting a skill/agent materializes into `<cwd>/.qwen`.
 */
export function useProjectsSource(): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
}> {
  const projects = useProjects();
  return useMemo(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.title,
        cwd: project.workspaceRoot,
      })),
    [projects],
  );
}

// The active project (the open thread's / draft's project) the «По проектам» tab follows and the
// composer picker filters by. Re-exported from ./activeProject so the ports contract stays stable.
export { useActiveProjectId };

/** Surface a catalog error as a stacked error toast. */
export function toastError(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}
