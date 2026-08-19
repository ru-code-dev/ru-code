// ru-code: "which project is the user looking at right now" — resolved from the ROUTE (an open thread
// or a draft dialog), independent of any component's props. Returns the project's `ProjectId`, the SAME
// identity the catalog now keys by (see catalogLayers.ts) and the runtime carries (`thread.projectId`),
// so the composer's effective-set filter matches project bindings with zero translation.
//
// The pure `resolveActiveProjectId` holds the decision (route kind → which project id); the hook is thin
// wiring over the route params + entity/draft stores. Testing the pure part guarantees the behaviour
// without a DOM (the port has no effect renderer — see the test-composites-not-fragments rule).

import { useParams } from "@tanstack/react-router";

import { useThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

/** The route's project source: a server thread carries its project id; a draft dialog carries its own. */
export function resolveActiveProjectId(input: {
  readonly routeKind: "server" | "draft" | null;
  readonly threadProjectId: string | null;
  readonly draftProjectId: string | null;
}): string | null {
  if (input.routeKind === "server") return input.threadProjectId;
  if (input.routeKind === "draft") return input.draftProjectId;
  return null;
}

/**
 * The active project's `ProjectId` (or null on a route with no thread/draft — the global surface).
 * A server thread takes precedence over a draft, mirroring the route resolver.
 */
export function useActiveProjectId(): string | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const draftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  // Read both sources unconditionally (stable hook order); the resolver picks by route kind.
  const threadProjectId = useThreadShell(threadRef)?.projectId ?? null;
  const draftProjectId = useComposerDraftStore((store) =>
    draftId ? (store.getDraftSession(draftId)?.projectId ?? null) : null,
  );

  return resolveActiveProjectId({
    routeKind: routeTarget?.kind ?? null,
    threadProjectId,
    draftProjectId,
  });
}
