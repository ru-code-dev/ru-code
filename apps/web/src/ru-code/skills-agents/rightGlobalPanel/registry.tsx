// ru-code: the global overlay-panel registry. One entry per panel drives BOTH the sidebar nav
// buttons and the panel host's content mount, so adding a panel is a single registry entry
// (plus a GlobalPanelId union member). Ported from the ru-code overlay coordinator.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
// ru-code zone → hand seam (R19): module-const L is safe — the locale module self-seeds
// from the server-stamped window.__RU_LOCALE__ at its own init (localeInit.test.ts).
import { L } from "@ru-code/localization";
import { ScrollTextIcon, ServerIcon } from "lucide-react";
import { useMemo, type ComponentType, type ReactNode } from "react";

import { usePluginOverlayPanels } from "../../plugins/slots"; // ru-code: plugins — panels from dropped-in plugins

import { ExtendedViewPanelHost } from "../../extended-chat/extendedViewPanelHost";
import { McpPanelHost } from "../../mcp/McpPanelHost";
import type { GlobalPanelId } from "./store";

/**
 * ru-code: the icon is any React component that accepts a `className`, not specifically a
 * `LucideIcon`. A plugin's panel icon arrives as a `PluginIconComponent` (SDK `./host`) —
 * usually a `lucide-react` icon, which satisfies this, but nothing forces that. The nav only
 * ever renders `<Icon />`, so the narrower type bought nothing and excluded plugins.
 */
export type OverlayPanelIcon = ComponentType<{
  readonly className?: string;
  readonly size?: number | string;
  readonly strokeWidth?: number;
}>;

export interface OverlayPanel {
  readonly id: GlobalPanelId;
  /** Sidebar button label + panel title. */
  readonly label: string;
  readonly icon: OverlayPanelIcon;
  /** A panel that opens ONLY from its own surface (never from a nav). The extended view's
   *  detail panel is opened by the thread, from the row the reader clicked — a rail icon would
   *  offer to open it with nothing to show. Every nav renders `navPanels()`, not this list. */
  readonly navHidden?: boolean;
  /**
   * ru-code (A16, SDK 0.2.0): the docked width, in CSS pixels, this panel would LIKE when it is
   * opened in `"sidebar"` mode.
   *
   * A DEFAULT, not a size: `RightGlobalPanelHost` clamps it (320–960) and the user's own persisted
   * width, once they have dragged the edge, still wins. Ignored entirely in `"sheet"` mode, where
   * the panel is a full-height mobile sheet with a viewport width. Omitted ⇒ the host's own 448.
   *
   * It exists for the ported packages: `qwen-cli-analytics`'s dashboard is a six-column
   * `max-w-[1400px]` board that degrades to one column below `lg`, so opening it at 448 shows a
   * nine-widget page as a single stack. Raising the shared ceiling instead would have re-sized
   * every panel in the app.
   */
  readonly preferredWidth?: number;
  /** Render the panel body; `mode` follows the layout (inline sidebar vs mobile sheet). */
  readonly render: (mode: DiffPanelMode, onClose: () => void) => ReactNode;
}

export const OVERLAY_PANELS: readonly OverlayPanel[] = [
  {
    id: "mcp",
    label: L("MCP Servers", "MCP-серверы"),
    icon: ServerIcon,
    render: (mode, onClose) => <McpPanelHost mode={mode} onClose={onClose} />,
  },
  // ru-code: the extended chat view's detail panel (agent flow / task board / work block).
  // It is a full member of this family — width, dark tokens, the narrow sheet and the mutual
  // exclusion all come from the host — but it has NO nav entry: it opens from the thread.
  {
    id: "extended-view",
    label: L("Extended view", "Подробный вид"),
    icon: ScrollTextIcon,
    navHidden: true,
    render: (mode, onClose) => <ExtendedViewPanelHost mode={mode} onClose={onClose} />,
  },
];

const mergePanels = (contributed: readonly OverlayPanel[]): readonly OverlayPanel[] =>
  contributed.length === 0 ? OVERLAY_PANELS : [...OVERLAY_PANELS, ...contributed];

const withoutNavHidden = (panels: readonly OverlayPanel[]): readonly OverlayPanel[] =>
  panels.filter((panel) => panel.navHidden !== true);

/** Every overlay panel this build ships. Plugin panels are reactive — see `useOverlayPanels`. */
export function overlayPanels(): readonly OverlayPanel[] {
  return OVERLAY_PANELS;
}

/** The panels a NAV may offer. `navHidden` entries are excluded here once, so no nav has to
 *  know which panels open from elsewhere (sidebar footer row, features menu). */
export function navPanels(): readonly OverlayPanel[] {
  return withoutNavHidden(overlayPanels());
}

export function useOverlayPanels(): readonly OverlayPanel[] {
  const contributed = usePluginOverlayPanels(); // ru-code: plugins — panels from dropped-in plugins
  return useMemo(() => mergePanels(contributed), [contributed]);
}

/** Reactive `navPanels()` — what every nav renders. */
export function useNavPanels(): readonly OverlayPanel[] {
  const panels = useOverlayPanels();
  return useMemo(() => withoutNavHidden(panels), [panels]);
}

export function overlayPanelById(id: GlobalPanelId): OverlayPanel | null {
  return OVERLAY_PANELS.find((panel) => panel.id === id) ?? null;
}
