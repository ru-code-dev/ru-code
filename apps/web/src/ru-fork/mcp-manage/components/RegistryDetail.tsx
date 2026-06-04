import { BookOpenIcon, FolderIcon, PencilIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  selectProjectsForServer,
  useMcpManagerStore,
} from "../store";
import { projectsCountLabel, toolsCountLabel } from "../format";
import type { McpRegistryServer } from "../types";
import { AddToProjectControl } from "./AddToProjectControl";
import { ConfigSummary } from "./ConfigSummary";
import { McpServerDialog } from "./McpServerDialog";
import { ToolList } from "./ToolList";

/** Detail pane for a catalog server: description, config, tool catalog (read-only), actions. */
export function RegistryDetail({ server }: { server: McpRegistryServer }) {
  const projects = useMcpManagerStore((state) => state.projects);
  const bindings = useMcpManagerStore((state) => state.bindings);

  const boundProjectIds = selectProjectsForServer(bindings, server.id);
  const boundProjects = projects.filter((project) => boundProjectIds.includes(project.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-semibold text-foreground">{server.name}</h3>
              <Badge variant={server.source === "builtin" ? "secondary" : "outline"}>
                {server.source === "builtin" ? "встроенный" : "свой"}
              </Badge>
            </div>
            {server.description ? (
              <p className="mt-1 text-xs leading-snug text-muted-foreground">{server.description}</p>
            ) : (
              <p className="mt-1 text-xs italic leading-snug text-muted-foreground/60">
                Без описания
              </p>
            )}
          </div>
          <McpServerDialog
            server={server}
            trigger={
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0"
                title="Редактировать сервер"
                aria-label={`Редактировать ${server.name}`}
              >
                <PencilIcon className="size-4" />
              </Button>
            }
          />
        </div>
        <div className="mt-3">
          <AddToProjectControl serverId={server.id} />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4 py-3">
          <ConfigSummary config={server.config} />

          {boundProjects.length > 0 && (
            <Section title={`Используется: ${projectsCountLabel(boundProjects.length)}`}>
              <ul className="flex flex-wrap gap-1.5">
                {boundProjects.map((project) => (
                  <li key={project.id}>
                    <Badge variant="outline" className="gap-1">
                      <FolderIcon className="size-3" />
                      {project.name}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title={toolsCountLabel(server.tools.length)}
            hint="Не мониторятся в каталоге"
          >
            <ToolList tools={server.tools} />
          </Section>

          {server.docsUrl && (
            <a
              href={server.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <BookOpenIcon className="size-3.5" />
              Документация
            </a>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
