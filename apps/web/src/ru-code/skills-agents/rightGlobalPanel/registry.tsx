// ru-code: the global overlay-panel registry. One entry per panel drives BOTH the sidebar nav
// buttons and the panel host's content mount, so adding a panel is a single registry entry
// (plus a GlobalPanelId union member). Ported from the ru-code overlay coordinator.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import { BotIcon, SparklesIcon, TerminalIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AgentsPanelHost } from "../agents-manager/host";
import { CommandsPanelHost } from "../commands-manager/host";
import { SkillsPanelHost } from "../skill-manager/host";
import type { GlobalPanelId } from "./store";

export interface OverlayPanel {
  readonly id: GlobalPanelId;
  /** Sidebar button label + panel title. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** Render the panel body; `mode` follows the layout (inline sidebar vs mobile sheet). */
  readonly render: (mode: DiffPanelMode, onClose: () => void) => ReactNode;
}

export const OVERLAY_PANELS: readonly OverlayPanel[] = [
  {
    id: "skills",
    label: "Навыки",
    icon: SparklesIcon,
    render: (mode, onClose) => <SkillsPanelHost mode={mode} onClose={onClose} />,
  },
  {
    id: "agents",
    label: "Агенты",
    icon: BotIcon,
    render: (mode, onClose) => <AgentsPanelHost mode={mode} onClose={onClose} />,
  },
  {
    id: "commands",
    label: "Команды",
    icon: TerminalIcon,
    render: (mode, onClose) => <CommandsPanelHost mode={mode} onClose={onClose} />,
  },
];

export function overlayPanelById(id: GlobalPanelId): OverlayPanel | null {
  return OVERLAY_PANELS.find((panel) => panel.id === id) ?? null;
}
