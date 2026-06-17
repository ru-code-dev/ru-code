/**
 * ru-fork: Analytics — top projects leaderboard (clickable → filters to project).
 *
 * @module ru-fork/stats/components/widgets/ProjectsCard
 */
import { FolderGitIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { formatInt, formatTokens } from "../../model/format";
import type { NamedTokenSlice } from "../../model/types";
import { BarRow, chartBackground, WidgetCard } from "../primitives";

interface ProjectsCardProps {
  readonly projects: readonly NamedTokenSlice[];
  readonly onPick: (projectId: string) => void;
  readonly onExpand: () => void;
}

export function ProjectsCard({ projects, onPick, onExpand }: ProjectsCardProps) {
  const maxTokens = projects[0]?.tokens ?? 1;
  const topProjects = projects.slice(0, 6);

  return (
    <WidgetCard title="Проекты" subtitle="Топ по токенам" icon={FolderGitIcon} onExpand={onExpand} bodyClassName="gap-0.5">
      {topProjects.map((project, projectIndex) => (
        <BarRow
          key={project.groupKey}
          label={project.label}
          value={formatTokens(project.tokens)}
          fraction={project.tokens / maxTokens}
          colorClass={project.kind === "temp" ? "bg-muted-foreground/40" : chartBackground(projectIndex)}
          hint={`${formatInt(project.sessions)} сессий · ${project.sharePct.toFixed(0)}%`}
          onClick={() => onPick(project.groupKey)}
          trailing={
            project.kind === "temp" ? (
              <Badge size="sm" variant="outline" className="mt-1">
                песочница
              </Badge>
            ) : undefined
          }
        />
      ))}
      {topProjects.length === 0 ? (
        <p className="px-1.5 text-xs text-muted-foreground/60">Нет данных за период</p>
      ) : null}
    </WidgetCard>
  );
}
