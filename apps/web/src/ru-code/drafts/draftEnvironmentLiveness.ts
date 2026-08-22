// ru-code: DEAD-ENVIRONMENT DRAFT RETIREMENT.
//
// Draft sessions persist in localStorage keyed by the server's environmentId.
// That id lives in a file inside the server's data dir — wiping/reinstalling
// the app data (or pointing the same origin at a different backend) mints a
// NEW id, and every persisted draft then references an environment that no
// longer exists. The /draft/$draftId route used to render such a draft as-is,
// forever: empty project picker («Выберите проект»), disabled composer
// («Окружение отключено»), no recovery short of clearing site data.
//
// The cure reuses the route's existing fallback: a draft whose environment is
// PROVABLY dead is treated like a missing draft — navigate("/", replace), and
// the index route re-mints a fresh draft from live data (project picked).
//
// "Provably dead" is deliberately strict:
//   · the environment catalog must have finished loading (`isReady`) — during
//     startup the map is empty and nothing may be retired on that emptiness;
//   · the id must be absent from the CATALOG (registration entries, which
//     persist in IndexedDB even for offline/disconnected environments) — an
//     offline environment is NOT dead, its draft keeps rendering as before.

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";

/** Pure decision — exported for the law tests. */
export const shouldRetireDraftForDeadEnvironment = (input: {
  readonly catalogReady: boolean;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly liveEnvironmentIds: ReadonlySet<string>;
}): boolean =>
  input.catalogReady &&
  input.draftEnvironmentId !== null &&
  !input.liveEnvironmentIds.has(input.draftEnvironmentId);

/**
 * True only when the draft's environment is provably dead (catalog loaded,
 * id absent). Called from the marked seam in routes/_chat.draft.$draftId.tsx.
 */
export function useDraftEnvironmentRetired(
  draftSession: { readonly environmentId: EnvironmentId } | null,
): boolean {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  if (draftSession === null) {
    return false;
  }
  return shouldRetireDraftForDeadEnvironment({
    catalogReady: catalog.isReady,
    draftEnvironmentId: draftSession.environmentId,
    liveEnvironmentIds: new Set(catalog.entries.keys()),
  });
}
