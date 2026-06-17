import { useEffect, useRef } from "react";
import { BoxesIcon, XIcon } from "lucide-react";
import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import { Toggle } from "~/components/ui/toggle-group";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
import { useActiveProject } from "~/hooks/useActiveProject";
import { useMcpManagerStore } from "../store";
import type { McpPanelTab } from "../types";
import { ProjectsTab } from "./ProjectsTab";
import { RegistryTab } from "./RegistryTab";

/**
 * The MCP manager panel. Built on `DiffPanelShell` (same as PixsoPanel) so its background
 * and header match the diff/Pixso panels exactly — `bg-background`, the same header row
 * (height + Electron drag-region + titlebar handling + `px-4` + bottom border). The close
 * button is the same outline `Toggle` (`variant="outline" size="xs"`, `pressed={false}`)
 * those headers use. Body: two tabs (Каталог / Проекты). Shared by the inline sidebar
 * (`mode="sidebar"`) and the mobile sheet (`mode="sheet"`).
 */
export function McpPanel({
  onClose,
  mode = "sidebar",
}: {
  onClose: () => void;
  mode?: DiffPanelMode;
}) {
  const activeTab = useMcpManagerStore((state) => state.activeTab);
  const setActiveTab = useMcpManagerStore((state) => state.setActiveTab);
  const selectProject = useMcpManagerStore((state) => state.selectProject);

  // Follow the active project (draft or open thread) — but only when it actually
  // CHANGES (this root stays mounted across tab switches), so an explicit pick
  // inside the panel (add-to-project, the dropdown) is never clobbered.
  const activeProject = useActiveProject();
  const routeProjectId = activeProject?.id ?? null;
  const lastSyncedProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (routeProjectId && routeProjectId !== lastSyncedProjectId.current) {
      lastSyncedProjectId.current = routeProjectId;
      selectProject(routeProjectId);
    }
  }, [routeProjectId, selectProject]);

  const header = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <BoxesIcon className="size-4 text-muted-foreground" />
        <h2 className="truncate text-sm font-semibold">MCP-серверы</h2>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Toggle
          variant="outline"
          size="xs"
          pressed={false}
          onPressedChange={() => onClose()}
          aria-label="Закрыть панель MCP"
        >
          <XIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={header} className="bg-card">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as McpPanelTab)}
        className="min-h-0 flex-1"
      >
        <TabsList className="shrink-0 border-b border-border px-2">
          <TabsTab value="registry">Каталог</TabsTab>
          <TabsTab value="projects">Проекты</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="registry">
          <RegistryTab />
        </TabsPanel>
        <TabsPanel value="projects">
          <ProjectsTab />
        </TabsPanel>
      </Tabs>
    </DiffPanelShell>
  );
}
