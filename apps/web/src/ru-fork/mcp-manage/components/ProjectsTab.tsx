import { FolderIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  selectProjectBindings,
  selectServerById,
  useMcpManagerStore,
} from "../store";
import { ProjectBindingRow } from "./ProjectBindingRow";

/** Projects tab: pick a project, then manage the MCP servers bound to it. */
export function ProjectsTab() {
  const projects = useMcpManagerStore((state) => state.projects);
  const registry = useMcpManagerStore((state) => state.registry);
  const bindings = useMcpManagerStore((state) => state.bindings);
  const selectedProjectId = useMcpManagerStore((state) => state.selectedProjectId);
  const selectProject = useMcpManagerStore((state) => state.selectProject);
  const setActiveTab = useMcpManagerStore((state) => state.setActiveTab);

  const projectItems = projects.map((project) => ({ value: project.id, label: project.name }));
  const projectBindings = selectProjectBindings(bindings, selectedProjectId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <Select
          value={selectedProjectId}
          onValueChange={(value) => selectProject(value as string)}
          items={projectItems}
        >
          <SelectTrigger size="sm" variant="ghost" className="min-w-0 flex-1 font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {projectBindings.length === 0 ? (
          <Empty className="py-10">
            <EmptyTitle>Нет подключённых MCP</EmptyTitle>
            <EmptyDescription>
              Откройте каталог и добавьте сервер в этот проект.
            </EmptyDescription>
            <Button variant="outline" size="sm" onClick={() => setActiveTab("registry")}>
              Открыть каталог
            </Button>
          </Empty>
        ) : (
          <div className="space-y-2.5 p-3">
            {projectBindings.map((binding) => {
              const server = selectServerById(registry, binding.serverId);
              if (!server) return null;
              return (
                <ProjectBindingRow
                  key={`${binding.projectId}:${binding.serverId}`}
                  binding={binding}
                  server={server}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
