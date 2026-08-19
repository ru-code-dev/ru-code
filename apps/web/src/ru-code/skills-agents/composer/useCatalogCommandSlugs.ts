// ru-code: the LIVE set of catalog custom-command slugs (lowercased) that are EFFECTIVE — i.e. have an
// enabled binding for the active project (or globally) — which is exactly the set qwen has deployed under
// `<cwd>/.qwen/commands/` and can run. Reads the same catalog snapshot atom the `/` picker reads (via
// useCatalogComposerItems with an empty query), so the set recomputes whenever a command is added,
// removed, connected, or disconnected — no stale allowlist. Fed to the submit guard
// (`resolveQwenSubmitPrompt`) so a `/mycommand` is recognized instead of aborted as "unknown".
import { useMemo } from "react";

import { useCatalogComposerItems } from "./useCatalogComposerItems.ts";

export function useCatalogCommandSlugs(enabled: boolean): ReadonlySet<string> {
  // Empty query → every effective command for the active project; also primes the shared snapshot.
  const items = useCatalogComposerItems("commandCatalog", "", enabled);
  return useMemo(() => new Set(items.map((item) => item.name.toLowerCase())), [items]);
}
