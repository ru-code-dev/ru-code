import { useState } from "react";
import { BookOpenIcon, FolderIcon, PencilIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { selectProjectsForServer } from "../store";
import { useMcpMutations, useMcpProjectBindings, useMcpProjects } from "../useMcp";
import { inProjectsLabel, toolsCountLabel } from "../format";
import type { McpRegistryServer } from "../types";
import { AddToProjectControl } from "./AddToProjectControl";
import { ConfigSummary } from "./ConfigSummary";
import { McpItemActions } from "./McpItemActions";
import { McpServerDialog } from "./McpServerDialog";
import { StatusBadge } from "./StatusBadge";
import { ToolList } from "./ToolList";

/** Detail pane for a catalog server: description, config, tool catalog (read-only), actions. */
export function RegistryDetail({ server }: { server: McpRegistryServer }) {
  const projects = useMcpProjects();
  const bindings = useMcpProjectBindings();
  const { removeServer, setServerEnabled } = useMcpMutations();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const boundProjectIds = selectProjectsForServer(bindings, server.id);
  const boundProjects = projects.filter((project) => boundProjectIds.includes(project.id));
  const isBuiltin = server.source === "builtin";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          {/* dot · name · tag */}
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge
              status={server.status ?? "unchecked"}
              showLabel={false}
              className="shrink-0"
            />
            <h3 className="truncate font-semibold text-foreground">{server.name}</h3>
            <Badge
              variant={server.source === "builtin" ? "secondary" : "outline"}
              className="shrink-0"
            >
              {server.source === "builtin" ? "встроенный" : "мой"}
            </Badge>
          </div>
          {/* Same control cluster as the item cards (refresh · edit · delete · switch) */}
          <McpItemActions
            recheckFilter={{ serverId: server.id }}
            recheckDisabled={server.incomplete || server.templateOnly}
            recheckAriaLabel={`Проверить ${server.name}`}
            editTrigger={
              <McpServerDialog
                server={server}
                trigger={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title={server.checking ? "Идёт проверка…" : "Редактировать сервер"}
                    aria-label={`Редактировать ${server.name}`}
                    disabled={server.checking}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                }
              />
            }
            // ③ delete — custom servers only (a built-in would be re-seeded; disable it instead)
            onDelete={!isBuiltin ? () => setConfirmOpen(true) : undefined}
            deleteTitle="Удалить сервер"
            deleteAriaLabel={`Удалить ${server.name}`}
            enabled={server.enabled}
            onToggleEnabled={(value) => setServerEnabled(server.id, value)}
            switchAriaLabel={server.enabled ? `Отключить ${server.name}` : `Включить ${server.name}`}
            switchTitle={server.enabled ? "Отключить в каталоге" : "Включить в каталоге"}
          />
        </div>
        {/* Full width below, left-aligned with the name (past the dot + gap ⇒ pl-4). */}
        {server.description ? (
          <p className="mt-1 pl-4 text-xs leading-snug text-muted-foreground">
            {server.description}
          </p>
        ) : (
          <p className="mt-1 pl-4 text-xs leading-snug text-muted-foreground/60">Добавьте описание</p>
        )}
        {/* ⑫ surface the probe failure text, not just the dot */}
        {server.status === "error" && server.message && (
          <p className="mt-1 pl-4 text-xs leading-snug text-red-600 dark:text-red-300/90">
            {server.message}
          </p>
        )}
        {/* P5: catalog-level required vars unfilled — fixable HERE (edit the server). Dot unchanged;
            the detail has room, so list the names inline (the list view uses a count badge instead). */}
        {server.incomplete && (
          <p className="mt-1 pl-4 text-xs leading-snug text-amber-700 dark:text-amber-300/90">
            Требует настройки: {server.missingVars.join(", ")}
          </p>
        )}
        <div className="mt-3">
          <AddToProjectControl serverId={server.id} />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4 py-3">
          <ConfigSummary config={server.config} vars={server.vars} />

          {boundProjects.length > 0 && (
            <Section title={`Используется ${inProjectsLabel(boundProjects.length)}`}>
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

          {/* Hidden entirely when the catalog server exposes no tools. */}
          {server.tools.length > 0 && (
            <Section title={toolsCountLabel(server.tools.length)}>
              <ToolList tools={server.tools} />
            </Section>
          )}

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

      {/* ③ delete confirmation — lists the projects that will lose this server */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить «{server.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {boundProjects.length > 0
                ? `Будет удалён из каталога и из проектов: ${boundProjects
                    .map((project) => project.name)
                    .join(", ")}. Связанные секреты тоже удалятся.`
                : "Будет удалён из каталога. Связанные секреты тоже удалятся."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Отмена</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                removeServer(server.id);
                setConfirmOpen(false);
              }}
            >
              Удалить
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
