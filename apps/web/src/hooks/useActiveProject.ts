// ru-fork: the single source of truth for "which project is the user looking at",
// identical whether they're in an open thread OR a draft dialog (the sidebar
// "new dialog" pencil opens a draft for a project before any ACP session exists).
// General app state — not MCP-specific; MCP is one of several consumers (active-
// project sync, the panel's recheck actions, project-scoped defaults).

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { selectProjectByRef, useStore, type AppState } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { Project } from "../types";

interface ActiveProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * The active project's scoped ref (environment + project), or null on routes
 * with no project (e.g. the empty index). A thread takes precedence over a draft.
 */
function useActiveProjectScopedRef(): ActiveProjectRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const draftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  // Select PRIMITIVES from the draft store — returning a fresh object here would
  // never be Object.is-equal to the previous render and would loop forever.
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId)?.environmentId ?? null : null,
  );
  const draftProjectId = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId)?.projectId ?? null : null,
  );

  if (activeThread) {
    return { environmentId: activeThread.environmentId, projectId: activeThread.projectId };
  }
  if (draftEnvironmentId !== null && draftProjectId !== null) {
    return { environmentId: draftEnvironmentId, projectId: draftProjectId };
  }
  return null;
}

/** The active project's id (draft or thread), or null. */
export function useActiveProjectRef(): ProjectId | null {
  return useActiveProjectScopedRef()?.projectId ?? null;
}

/** The full active project — including its `cwd` (the working directory) — or null. */
export function useActiveProject(): Project | null {
  const ref = useActiveProjectScopedRef();
  const environmentId = ref?.environmentId ?? null;
  const projectId = ref?.projectId ?? null;
  const project = useStore(
    useMemo(
      () => (state: AppState) =>
        environmentId && projectId
          ? selectProjectByRef(state, { environmentId, projectId })
          : undefined,
      [environmentId, projectId],
    ),
  );
  return project ?? null;
}
