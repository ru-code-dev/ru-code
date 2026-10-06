// ru-code: the global right-panel coordinator.
//
// Port's built-in right panel (rightPanelStore.ts) is THREAD-scoped — its surfaces
// (diff/files/preview/terminal/plan) belong to one thread. The skills/agents managers are
// GLOBAL (a skill is not owned by a thread), so they get their own coordinator that overlays
// the right slot and hides the thread panel while open (see ChatView's visibility gate). Only
// one global panel is open at a time (N-way mutual exclusion via the enum), mirroring the
// ru-code overlay coordinator this is ported from.

import { PLUGIN_ID_PATTERN } from "@smart-tools/plugin-sdk/contracts";
import { isPluginSlug } from "@smart-tools/plugin-sdk/host-rules";
import { create } from "zustand";

// ru-code: the id is an OPEN branded slug, not a closed literal union.
//
// WHY (mvp-plan D13/§1.4): a plugin dropped into `~/.ru-code/plugins/` registers its own
// overlay panel at boot, so this build cannot know every panel id it will host — exactly the
// forward-compatibility problem `ProviderDriverKind` solves for driver kinds
// (`packages/contracts/src/providerInstance.ts:59-70`), and solved the same way: the KNOWN
// panels keep their literal types (so `open === "mcp"` still narrows and a typo in app code
// is still an error), and anything else must come through `pluginPanelId`, which
// validates the slug. Every consumer resolves an id through the registry, never through an
// exhaustive switch, so an id this build has never heard of degrades to "no such panel"
// instead of crashing.
//
// Not an `effect/Schema` brand (the `ProviderDriverKind` letter): these ids never cross the
// wire — they are minted in-process from a manifest the server already validated — so a
// decoder would buy nothing and would drag Schema into the sidebar's render path.

/** The panels this build ships itself. */
export type KnownGlobalPanelId = "mcp" | "extended-view";

declare const globalPanelIdBrand: unique symbol;

/** A validated slug for a panel this build does not know about (a plugin's). */
export type PluginGlobalPanelId = string & { readonly [globalPanelIdBrand]: true };

/** Any global overlay panel: the built-ins by literal, everything else validated. */
export type GlobalPanelId = KnownGlobalPanelId | PluginGlobalPanelId;

/**
 * The id of a panel contributed by a plugin — `plugin:<pluginId>` / `plugin:<pluginId>:<panelId>`;
 * `panelId` is omitted for a plugin's only panel. `null` (never a throw) when a part is not legal.
 *
 * ru-code: plugins — S111 #1, ONE rule for a panel id. The id is COMPOSED from the two rules that
 * already accepted its parts — the manifest's `PLUGIN_ID_PATTERN` for the plugin and the seam's
 * `isPluginSlug` (`@smart-tools/plugin-sdk/host-rules`) for the panel — and never re-judged. Its
 * old second pattern (`^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$`) wanted every segment to start
 * with a letter, so `2fa` passed the seam and was then dropped from the global slot with no report
 * (S110 R04). The `plugin:` prefix keeps every such id apart from the built-in literals.
 */
export function pluginPanelId(pluginId: string, panelId?: string): GlobalPanelId | null {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) return null;
  if (panelId === undefined || panelId === "") return `plugin:${pluginId}` as GlobalPanelId;
  return isPluginSlug(panelId) ? (`plugin:${pluginId}:${panelId}` as GlobalPanelId) : null;
}

interface RightGlobalPanelState {
  /** The open global panel, or null when the thread panel owns the right slot. */
  readonly open: GlobalPanelId | null;
  /** Click-to-open, click-again-to-close (the sidebar nav buttons). */
  readonly toggle: (panel: GlobalPanelId) => void;
  /** Close the global panel (hand the right slot back to the thread panel). */
  readonly close: () => void;
}

export const useRightGlobalPanelStore = create<RightGlobalPanelState>((set) => ({
  open: null,
  toggle: (panel) => set((state) => ({ open: state.open === panel ? null : panel })),
  close: () => set({ open: null }),
}));

/** Non-reactive read for guards outside React (kept tiny so call sites stay obvious). */
export const isGlobalPanelOpen = (): boolean => useRightGlobalPanelStore.getState().open !== null;

/**
 * Close the global panel if one is open; returns whether it was. Lets the port's right-panel toggle
 * consume the click when the global panel owns the right slot (so the button closes IT, revealing the
 * thread panel again — non-destructive), instead of toggling the hidden thread panel underneath.
 */
export const closeGlobalPanelIfOpen = (): boolean => {
  if (useRightGlobalPanelStore.getState().open === null) return false;
  useRightGlobalPanelStore.getState().close();
  return true;
};
