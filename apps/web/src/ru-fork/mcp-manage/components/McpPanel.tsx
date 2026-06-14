import { useEffect, useRef } from "react";
import { BoxesIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
import { useActiveProject } from "~/hooks/useActiveProject";
import { useMcpManagerStore } from "../store";
import type { McpPanelTab } from "../types";
import { ProjectsTab } from "./ProjectsTab";
import { RegistryTab } from "./RegistryTab";

/**
 * The MCP manager panel content: a header with title + close, two tabs (Каталог / Проекты),
 * and their panels. Shared by the inline sidebar and the mobile sheet (both pass `onClose`).
 */
export function McpPanel({ onClose }: { onClose: () => void }) {
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BoxesIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">MCP-серверы</h2>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Закрыть панель MCP">
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>

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
    </div>
  );
}
