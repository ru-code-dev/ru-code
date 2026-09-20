// ru-code v2 (S1 §7.5): name the plugin behind a fault React routes past every error boundary.
//
// THE ONE CLASS THE BOUNDARIES CANNOT SEE. `PluginSurface` wraps every rendered seam, and a throw
// from a plugin's render or from an event handler lands there. A throw from a `useEffect` CLEANUP
// does not: React 19 catches it at the ROOT and logs it, so containment holds — the app stays up,
// no crash card, nothing else unmounts — but the console line says only "an error occurred" and the
// user has no idea which plugin to remove. v1 named the plugin for this one class; v2's boundaries
// could not, because the fault never reaches one.
//
// `createRoot(..., { onCaughtError, onUncaughtError })` is the only hook React offers here, and the
// only evidence available at that point is the STACK. A plugin's module URL is
// `/plugins/<id>/web/index.mjs` — the route the host serves its folder from — so a frame naming it
// is the plugin's own code, and it cannot be forged by another plugin (the id is its folder name).
// No stack, or no plugin frame ⇒ this is the APP's error and nothing is reported: blaming a plugin
// for an app fault is worse than saying nothing, which is the mistake v1 round 2 made by asking
// instead whether a plugin panel happened to be open.

import { L } from "@ru-code/localization";

import { isPluginSlug } from "./caps";
import { reportPluginProblem } from "./problems";
import { pluginDisplayName } from "./status";

/** `…/plugins/<id>/web/index.mjs` — the route the host serves a plugin folder from. */
const PLUGIN_FRAME = /\/plugins\/([^/\s)"']+)\//g;

/** The plugin a stack blames, or `null` when no frame names one. */
export function pluginIdFromStack(stack: unknown): string | null {
  if (typeof stack !== "string") return null;
  PLUGIN_FRAME.lastIndex = 0;
  for (let m = PLUGIN_FRAME.exec(stack); m !== null; m = PLUGIN_FRAME.exec(stack)) {
    if (isPluginSlug(m[1])) return m[1];
  }
  return null;
}

/**
 * Report a root-level fault, but only when a plugin frame is in the stack.
 *
 * `componentStack` is React's own tree trace and `error.stack` the JS one; either may carry the
 * frame, so both are read. Returns the plugin id it blamed, for the unit tier.
 */
export function reportPluginRootError(error: unknown, componentStack?: unknown): string | null {
  const stack = `${error instanceof Error ? (error.stack ?? "") : String(error)}\n${
    typeof componentStack === "string" ? componentStack : ""
  }`;
  const pluginId = pluginIdFromStack(stack);
  if (pluginId === null) return null;
  const name = pluginDisplayName(pluginId);
  reportPluginProblem({
    kind: "error",
    pluginId,
    // One report per plugin per page load: a cleanup that throws on every unmount would otherwise
    // storm the toaster, which is the defect `problems.ts`' `code` gate exists for.
    code: "root",
    title: L(`Plugin "${name}" raised an error`, `Плагин «${name}» вызвал ошибку`),
    detail: error instanceof Error ? error.message : String(error),
  });
  return pluginId;
}
