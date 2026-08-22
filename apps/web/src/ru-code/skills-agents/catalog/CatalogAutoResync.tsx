// ru-code: CATALOG AUTO-RESYNC — the ONE owner of every automatic catalog rescan.
//
// Design (ratified; supersedes the panel-scoped triggers that used to live in
// ItemsPanel.tsx — see SPECS/catalog-refactoring.md):
//
//   reconcile ⇔ rpcReady ∧ projectsLoaded ∧ (no baseline ∨ project-set changed)
//
// One rule covers every case with ZERO redundancy and ZERO polling:
//   · boot / F5 — the first satisfaction of the condition fires the one boot
//     reconcile (global root + every live project root; the SERVER enumerates
//     projects itself via listLive, so the scan is complete regardless of what
//     the client has loaded);
//   · project add/remove mid-session — the sorted-set key changes → one rescan;
//     reorder-only never fires (sorted key);
//   · zero-projects user — projectsLoaded lets the first reconcile fire even
//     with an empty list (global-only skills still discovered);
//   · reconnect — the baseline key is already set, so a connection flap alone
//     never rescans;
//   · while connecting — rpcReady is false, so there are NO attempts and no
//     console errors (same gate as the composer prime, primeReadiness.ts).
// The panel no longer auto-rescans (it reads the shared atom, warm by the time
// a human can open it); its manual Refresh button and the per-mutation rescans
// (rescanAndPrime call sites) are untouched — they are per-action, never
// redundant. A failed reconcile keeps the baseline unset, so the next readiness
// or key change retries; mid-session out-of-band disk edits remain covered by
// the manual Refresh button only (accepted trade — no FS watcher).

import { useContext, useEffect, useRef } from "react";
import { RegistryContext } from "@effect/atom-react";
import type { CatalogItem } from "@smart-tools/qwen-cli-catalog-core/contracts";
import { catalogDataAtom, primeCatalog } from "@smart-tools/qwen-cli-catalog-core/web";

import { useAllEnvironmentShellsBootstrapped } from "../../../state/entities";
import { useCatalogClient } from "./useCatalogClient.ts";
import { usePrimaryEnvironmentRpcReady } from "./primeReadiness.ts";
import { useProjectsSource } from "./hostPorts.ts";

export const CATALOG_PREFIXES = ["skillCatalog", "agentCatalog", "commandCatalog"] as const;
export type CatalogPrefix = (typeof CATALOG_PREFIXES)[number];

/** Sorted-set key: a function of the project SET, insensitive to order. */
export const projectSetKey = (projectIds: ReadonlyArray<string>): string =>
  [...projectIds].toSorted().join(",");

/** The ONE reconcile rule — pure, exported for the law tests. */
export const shouldReconcileCatalogs = (input: {
  readonly rpcReady: boolean;
  readonly projectsLoaded: boolean;
  readonly projectSetKey: string;
  readonly baselineKey: string | null;
}): boolean => input.rpcReady && input.projectsLoaded && input.baselineKey !== input.projectSetKey;

/**
 * A reconcile that found NOTHING new must not touch the atom: no write, no
 * re-render, no chance of a frame hitch colliding with an in-flight send
 * animation (the reconcile response can land seconds after boot — the scan is
 * a real disk walk). Pure, exported for the law tests. A false negative (an
 * ordering difference read as a change) merely primes — the old behavior.
 */
export const sameCatalogItems = (
  current: ReadonlyArray<CatalogItem>,
  next: ReadonlyArray<CatalogItem>,
): boolean => current.length === next.length && JSON.stringify(current) === JSON.stringify(next);

function CatalogResyncDriver(props: {
  readonly prefix: CatalogPrefix;
  readonly rpcReady: boolean;
  readonly projectsLoaded: boolean;
  readonly projectSetKey: string;
}) {
  const registry = useContext(RegistryContext);
  const client = useCatalogClient(props.prefix);
  // Per-prefix baseline: the project-set key of the last SUCCESSFUL reconcile.
  const baselineKey = useRef<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (inFlight.current) return;
    if (
      !shouldReconcileCatalogs({
        rpcReady: props.rpcReady,
        projectsLoaded: props.projectsLoaded,
        projectSetKey: props.projectSetKey,
        baselineKey: baselineKey.current,
      })
    ) {
      return;
    }
    inFlight.current = true;
    const reconciledKey = props.projectSetKey;
    client
      .rescan()
      .then((next) => {
        const current = registry.get(catalogDataAtom(props.prefix));
        if (!sameCatalogItems(current, next)) {
          primeCatalog(registry, props.prefix, next);
        }
        baselineKey.current = reconciledKey;
      })
      .catch(() => {
        // Transient refusal (connection dropped between the readiness check and
        // the RPC). Baseline stays unset — the next readiness flip or key change
        // retries. Never an unhandled rejection.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [client, props.prefix, props.projectSetKey, props.projectsLoaded, props.rpcReady, registry]);

  return null;
}

/** Render-nothing host, mounted once in AppSidebarLayout (marked seam). */
export function CatalogAutoResync() {
  const rpcReady = usePrimaryEnvironmentRpcReady();
  const projectsLoaded = useAllEnvironmentShellsBootstrapped();
  const projects = useProjectsSource();
  const setKey = projectSetKey(projects.map((project) => project.id));

  return (
    <>
      {CATALOG_PREFIXES.map((prefix) => (
        <CatalogResyncDriver
          key={prefix}
          prefix={prefix}
          rpcReady={rpcReady}
          projectsLoaded={projectsLoaded}
          projectSetKey={setKey}
        />
      ))}
    </>
  );
}
