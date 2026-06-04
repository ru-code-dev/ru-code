import { BoxesIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BoxesIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">MCP-серверы</h2>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Закрыть панель MCP">
          <XIcon className="size-4" />
        </Button>
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
