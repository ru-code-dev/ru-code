// ru-code: the global overlay-panel registry. One entry per panel drives BOTH the sidebar nav
// buttons and the panel host's content mount, so adding a panel is a single registry entry
// (plus a GlobalPanelId union member). Ported from the ru-code overlay coordinator.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
// ru-code zone → hand seam (R19): module-const L is safe — the locale module self-seeds
// from the server-stamped window.__RU_LOCALE__ at its own init (localeInit.test.ts).
import { L } from "@ru-code/localization";
import {
  BotIcon,
  PenToolIcon,
  ScrollTextIcon,
  ServerIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { ExtendedViewPanelHost } from "../../extended-chat/extendedViewPanelHost";
import { McpPanelHost } from "../../mcp/McpPanelHost";
import { AgentsPanelHost } from "../agents-manager/host";
import { CommandsPanelHost } from "../commands-manager/host";
import { SkillsPanelHost } from "../skill-manager/host";
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

export interface OverlayPanel {
  readonly id: GlobalPanelId;
  /** Sidebar button label + panel title. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** A panel that opens ONLY from its own surface (never from a nav). The extended view's
   *  detail panel is opened by the thread, from the row the reader clicked — a rail icon would
   *  offer to open it with nothing to show. Every nav renders `NAV_PANELS`, not this list. */
  readonly navHidden?: boolean;
  /** Render the panel body; `mode` follows the layout (inline sidebar vs mobile sheet). */
  readonly render: (mode: DiffPanelMode, onClose: () => void) => ReactNode;
}

export const OVERLAY_PANELS: readonly OverlayPanel[] = [
  {
    id: "skills",
    label: L("Skills", "Навыки"),
    icon: SparklesIcon,
    render: (mode, onClose) => <SkillsPanelHost mode={mode} onClose={onClose} />,
  },
  {
    id: "agents",
    label: L("Agents", "Агенты"),
    icon: BotIcon,
    render: (mode, onClose) => <AgentsPanelHost mode={mode} onClose={onClose} />,
  },
  {
    id: "commands",
    label: L("Commands", "Команды"),
    icon: TerminalIcon,
    render: (mode, onClose) => <CommandsPanelHost mode={mode} onClose={onClose} />,
  },
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

/** The panels a NAV may offer. `navHidden` entries are excluded here once, so no nav has to
 *  know which panels open from elsewhere (sidebar footer row, features menu). */
export const NAV_PANELS: readonly OverlayPanel[] = OVERLAY_PANELS.filter(
  (panel) => panel.navHidden !== true,
);

export function overlayPanelById(id: GlobalPanelId): OverlayPanel | null {
  return OVERLAY_PANELS.find((panel) => panel.id === id) ?? null;
}
