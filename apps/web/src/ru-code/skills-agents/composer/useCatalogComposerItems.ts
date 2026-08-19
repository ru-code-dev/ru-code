// ru-code: composer picker data source. Reads the SAME catalog snapshot the panel reads (one registry
// atom — single source of truth, so a panel mutation repaints the picker live), for the active project's
// effective set. Atom-native: the port's data layer is effect-atom (not react-query), so the composer
// reads catalogDataAtom directly via useCatalogList. Only primes when actually read (the panel may never
// have opened).
import { useContext, useEffect } from "react";
import { RegistryContext } from "@effect/atom-react";
import {
  selectEffectiveItems,
  searchCatalogItems,
  type CatalogItem,
} from "@smart-tools/qwen-cli-catalog-core/contracts";
import { useCatalogList, primeCatalog } from "@smart-tools/qwen-cli-catalog-core/web";

import { useCatalogClient } from "../catalog/useCatalogClient.ts";
import { useActiveProjectId } from "../catalog/hostPorts.ts";

export function useCatalogComposerItems(
  prefix: "skillCatalog" | "agentCatalog" | "commandCatalog",
  query: string,
  enabled: boolean,
): ReadonlyArray<CatalogItem> {
  const registry = useContext(RegistryContext);
  const client = useCatalogClient(prefix);
  const projectId = useActiveProjectId();
  const items = useCatalogList(prefix);

  // Prime the shared snapshot once, only for providers whose picker actually sources from the catalog
  // (avoids a needless RPC on a non-catalog thread). Idempotent: the panel's own guard + this length
  // check keep it to one fetch.
  useEffect(() => {
    if (!enabled || items.length > 0) return;
    let cancelled = false;
    void client.snapshot().then((snapshot) => {
      if (!cancelled) primeCatalog(registry, prefix, snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, client, prefix, registry, items.length]);

  if (!enabled) return [];
  return searchCatalogItems(selectEffectiveItems(items, projectId), query);
}
