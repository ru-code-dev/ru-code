import { CheckIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  selectProjectsForServer,
  useMcpManagerStore,
} from "../store";

/**
 * "Add to project ▾" dropdown shown on a catalog server. Lists every project; projects the
 * server is already bound to are shown with a check and disabled.
 */
export function AddToProjectControl({ serverId }: { serverId: string }) {
  const projects = useMcpManagerStore((state) => state.projects);
  const bindings = useMcpManagerStore((state) => state.bindings);
  const addBindingToProject = useMcpManagerStore((state) => state.addBindingToProject);
  const selectProject = useMcpManagerStore((state) => state.selectProject);
  const setActiveTab = useMcpManagerStore((state) => state.setActiveTab);

  const boundProjectIds = new Set(selectProjectsForServer(bindings, serverId));

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="default">
            <FolderPlusIcon className="size-4" />
            Добавить в проект
          </Button>
        }
      />
      <MenuPopup align="start">
        {projects.map((project) => {
          const alreadyBound = boundProjectIds.has(project.id);
          return (
            <MenuItem
              key={project.id}
              disabled={alreadyBound}
              onClick={() => {
                if (alreadyBound) return;
                addBindingToProject(serverId, project.id);
                selectProject(project.id);
                setActiveTab("projects");
              }}
            >
              {alreadyBound ? <CheckIcon className="size-4" /> : <PlusIcon className="size-4" />}
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
