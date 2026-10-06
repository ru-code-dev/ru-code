// ru-code v2: the `/`-command allowlist the qwen submit guard needs, DERIVED from the composer seam.
//
// WHY THE APP NEEDS IT AT ALL. `resolveQwenSubmitPrompt` aborts a message that opens with an
// UNKNOWN slash command — a `/typo` must never be sent to the CLI as prose, where its ACP path
// answers a raw JSON-RPC error — and it takes the allowlist as a parameter. A plugin that
// contributes `/` rows has to be able to put its names into that set, or every one of its commands
// is refused at send time.
//
// WHY IT IS ONE FILE AND NOT A MECHANISM. v1 spent ~70 lines of host machinery on this: a second
// store of "primed" rows, a `publishPrimedCommandSlugs` writer, and a permanently-mounted invisible
// driver whose only job was to keep one composer provider warm at the empty query so the answer
// was in memory when the user pressed Enter. v2's seam is already a plain call — `composer.items`
// takes the query as an argument — so asking it for the EMPTY query is the whole implementation,
// and the answer refreshes on its own whenever a plugin's rows change.
//
// The slug comes from the row's `insert`, not from a field of its own: the slug IS what the row
// would paste, so `insert: "/review "` is the command `review` and the two cannot disagree.

import { useMemo } from "react";

import { pluginCommandSlugs, toComposerCommandItem } from "./composerRows";
import { useContributedComposerRows } from "./seams";

/** The `/` commands every loaded plugin currently offers. Empty with no such plugin installed. */
export function useQwenPluginCommandSlugs(): ReadonlySet<string> {
  // The EMPTY query: "everything you would offer", which is the set the guard has to know about
  // for a `/name` typed by hand with the menu never opened. EVERY contributed row, not only the ones
  // the menu draws (S111 #6): a plugin offering more than `MAX_COMPOSER_ROWS_PER_PLUGIN` commands
  // used to have the rest refused at submit.
  const rows = useContributedComposerRows("/", "");
  return useMemo(
    () => pluginCommandSlugs(rows.map((row) => toComposerCommandItem(row, "/"))),
    [rows],
  );
}
