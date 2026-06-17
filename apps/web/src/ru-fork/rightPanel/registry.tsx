import type { LucideIcon } from "lucide-react";
import { LayersIcon, ServerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { McpPanel } from "~/ru-fork/mcp-manage/components/McpPanel";
import { PixsoPanel } from "~/ru-fork/pixso-move/components/PixsoPanel";

/**
 * The form a panel is rendered in: a wide-screen offcanvas sidebar or a narrow-screen
 * sheet. Values are a subset of `DiffPanelMode` so they pass straight through as a
 * panel's `mode` (no mapping). ("inline" — the legacy full-width diff — is unused here.)
 */
export type OverlayPanelForm = "sidebar" | "sheet";

export interface OverlayPanelWidth {
  readonly storageKey: string;
  readonly defaultWidth: string;
  readonly minWidth: number;
  readonly maxWidth: number;
}

export interface OverlayPanelEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly width: OverlayPanelWidth;
  readonly render: (form: OverlayPanelForm, onClose: () => void) => ReactNode;
}

/**
 * ru-fork: the registry of global right-side overlay panels. Adding a panel = one
 * entry here; the id-union, the left-nav button, the mount, and N-way mutual
 * exclusion all follow automatically. `as const satisfies` keeps each entry
 * type-checked while preserving the literal `id`s for the derived union below.
 */
export const OVERLAY_PANELS = [
  {
    id: "mcp",
    label: "MCP Серверы",
    icon: ServerIcon,
    width: {
      storageKey: "chat_mcp_sidebar_width",
      defaultWidth: "clamp(24rem,32vw,34rem)",
      minWidth: 22 * 16,
      maxWidth: 40 * 16,
    },
    render: (form: OverlayPanelForm, onClose: () => void) => (
      <McpPanel onClose={onClose} mode={form} />
    ),
  },
  {
    id: "pixso",
    label: "Макеты Pixso",
    icon: LayersIcon,
    width: {
      storageKey: "chat_pixso_sidebar_width",
      defaultWidth: "clamp(24rem,32vw,34rem)",
      minWidth: 22 * 16,
      maxWidth: 40 * 16,
    },
    render: (form: OverlayPanelForm, onClose: () => void) => (
      <PixsoPanel onClose={onClose} mode={form} />
    ),
  },
] as const satisfies readonly OverlayPanelEntry[];

/** Union of overlay-panel ids, derived from the registry — never hand-maintained. */
export type OverlayPanel = (typeof OVERLAY_PANELS)[number]["id"];
