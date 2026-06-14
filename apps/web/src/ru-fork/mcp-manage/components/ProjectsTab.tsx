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
import { useMcpProjectBindings, useMcpProjects, useMcpRegistry } from "../useMcp";
import { ProjectBindingRow } from "./ProjectBindingRow";
import { RecheckButton } from "./RecheckButton";

/** Projects tab: pick a project, then manage the MCP servers bound to it. */
export function ProjectsTab() {
  const projects = useMcpProjects();
  const registry = useMcpRegistry();
  const bindings = useMcpProjectBindings();
  const selectedProjectId = useMcpManagerStore((state) => state.selectedProjectId);
  const selectProject = useMcpManagerStore((state) => state.selectProject);
  const setActiveTab = useMcpManagerStore((state) => state.setActiveTab);

  // The panel root (McpPanel) keeps selectedProjectId synced to the open thread's
  // project. Here we only fall back to the first project until one is picked (or
  // if the current selection points at a project that no longer exists).
  const activeProjectId =
    selectedProjectId && projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : (projects[0]?.id ?? "");
  const projectItems = projects.map((project) => ({ value: project.id, label: project.name }));
  const projectBindings = selectProjectBindings(bindings, activeProjectId);
  // Projects with at least one binding that needs a required per-project value (§D8).
  const incompleteProjectIds = new Set(
    bindings.filter((binding) => binding.incomplete).map((binding) => binding.projectId),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <Select
          value={activeProjectId}
          onValueChange={(value) => selectProject(value as string)}
          items={projectItems}
        >
          <SelectTrigger size="sm" variant="ghost" className="min-w-0 max-w-[60%] font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <span className="flex items-center gap-1.5">
                  {project.name}
                  {incompleteProjectIds.has(project.id) && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-amber-500"
                      title="Есть MCP, требующие настройки"
                    />
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {/* ④ check every server bound to the active project — disabled when there's nothing to check */}
        <RecheckButton
          filter={activeProjectId ? { projectId: activeProjectId } : {}}
          disabled={
            activeProjectId === "" ||
            projectBindings.length === 0 ||
            !projectBindings.some((binding) => binding.enabled)
          }
          ariaLabel="Проверить все серверы проекта"
          title="Проверить все"
          className="ml-auto shrink-0"
        />
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
