// ru-code: the global overlay-panel registry. One entry per panel drives BOTH the sidebar nav
// buttons and the panel host's content mount, so adding a panel is a single registry entry
// (plus a GlobalPanelId union member). Ported from the ru-code overlay coordinator.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
// ru-code zone → hand seam (R19): module-const L is safe — the locale module self-seeds
// from the server-stamped window.__RU_LOCALE__ at its own init (localeInit.test.ts).
import { L } from "@ru-code/localization";
import { PenToolIcon, ScrollTextIcon, ServerIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { create } from "zustand";

import { ExtendedViewPanelHost } from "../../extended-chat/extendedViewPanelHost";
import { McpPanelHost } from "../../mcp/McpPanelHost";
import type { GlobalPanelId } from "./store";

// ru-code: the Pixso host pulls in the whole assistant package (panel tree, parser,
// preview renderer). A static import puts all of it in the initial chunk of every cold
// boot, for a panel most sessions never open — so this one entry is code-split. The other
// panels stay static: they are small and their hosts are already on the app's own graph.
const PixsoAssistantPanelHost = lazy(() =>
  import("../../pixso-assistant/host").then((module) => ({
    default: module.PixsoAssistantPanelHost,
  })),
);

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
  // ru-code: the Pixso MCP assistant (scan → gallery → detail → diagnostics).
  {
    id: "pixso",
    label: "Pixso",
    icon: PenToolIcon,
    render: (mode, onClose) => (
      <Suspense fallback={null}>
        <PixsoAssistantPanelHost mode={mode} onClose={onClose} />
      </Suspense>
    ),
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

// ru-code: panels contributed at boot by dropped-in plugins (mvp-plan §1.4).
//
// REACTIVE (A4 finding H2/M2, decision 2026-09-08): `loadPlugins()` no longer runs before
// `createRoot(...)` — a plugin whose `activate()` never settled used to white-screen the app
// permanently (`main.tsx` awaited it). Plugins now load AFTER the first render, so this map
// IS observed changing and has to be a store: a panel registered a second after boot must
// still reach the sidebar, the nav and the panel host. The non-reactive readers
// (`overlayPanels()` / `navPanels()` / `overlayPanelById()`) stay for callers outside React;
// React reads through `useOverlayPanels()` / `useNavPanels()`.
interface RegisteredOverlayPanelsState {
  /** Registration order; the seed array always comes first (see `overlayPanels`). */
  readonly panels: ReadonlyArray<OverlayPanel>;
}

const useRegisteredOverlayPanels = create<RegisteredOverlayPanelsState>(() => ({ panels: [] }));

/**
 * Add (or replace) a panel outside the seed array. Returns the id it was stored under.
 *
 * Replace-and-warn rather than throw: a duplicate id means a plugin registered twice or two
 * plugins collided, and mvp-plan guardrail 8 says a misbehaving plugin must never take the
 * host down — the last registration wins and the problem is visible in the console.
 */
export function registerOverlayPanel(panel: OverlayPanel): GlobalPanelId {
  if (OVERLAY_PANELS.some((seed) => seed.id === panel.id)) {
    console.warn(
      `[plugins] overlay panel "${panel.id}" shadows a built-in panel; the built-in wins`,
    );
    return panel.id;
  }
  useRegisteredOverlayPanels.setState((state) => {
    const index = state.panels.findIndex((entry) => entry.id === panel.id);
    if (index < 0) {
      return { panels: [...state.panels, panel] };
    }
    console.warn(`[plugins] overlay panel "${panel.id}" registered twice; replacing`);
    const panels = [...state.panels];
    panels[index] = panel;
    return { panels };
  });
  return panel.id;
}

/** Test seam: drop every registered (non-seed) panel. */
export function resetRegisteredOverlayPanels(): void {
  useRegisteredOverlayPanels.setState({ panels: [] });
}

const mergePanels = (registered: ReadonlyArray<OverlayPanel>): readonly OverlayPanel[] =>
  registered.length === 0 ? OVERLAY_PANELS : [...OVERLAY_PANELS, ...registered];

const withoutNavHidden = (panels: readonly OverlayPanel[]): readonly OverlayPanel[] =>
  panels.filter((panel) => panel.navHidden !== true);

/** Every overlay panel: the seed array first, then whatever registered on top of it. */
export function overlayPanels(): readonly OverlayPanel[] {
  return mergePanels(useRegisteredOverlayPanels.getState().panels);
}

/** The panels a NAV may offer. `navHidden` entries are excluded here once, so no nav has to
 *  know which panels open from elsewhere (sidebar footer row, features menu). */
export function navPanels(): readonly OverlayPanel[] {
  return withoutNavHidden(overlayPanels());
}

/** Reactive `overlayPanels()` — re-renders when a plugin registers after first paint.
 *
 *  `useSyncExternalStore` rather than zustand's own `useStore` hook: zustand serves
 *  `getInitialState()` as the SERVER snapshot, which would make any render outside the
 *  browser (and every SSR-shaped unit test) show the seed array only. The live state is the
 *  right answer in both places — the registry is process state, not request state. */
function useRegisteredPanels(): ReadonlyArray<OverlayPanel> {
  return useSyncExternalStore(
    useRegisteredOverlayPanels.subscribe,
    () => useRegisteredOverlayPanels.getState().panels,
    () => useRegisteredOverlayPanels.getState().panels,
  );
}

export function useOverlayPanels(): readonly OverlayPanel[] {
  const registered = useRegisteredPanels();
  return useMemo(() => mergePanels(registered), [registered]);
}

/** Reactive `navPanels()` — what every nav renders. */
export function useNavPanels(): readonly OverlayPanel[] {
  const panels = useOverlayPanels();
  return useMemo(() => withoutNavHidden(panels), [panels]);
}

export function overlayPanelById(id: GlobalPanelId): OverlayPanel | null {
  return (
    OVERLAY_PANELS.find((panel) => panel.id === id) ??
    useRegisteredOverlayPanels.getState().panels.find((panel) => panel.id === id) ??
    null
  );
}
