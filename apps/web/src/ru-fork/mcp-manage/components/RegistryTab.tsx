import { type ReactNode, useMemo, useState } from "react";
import type { ContextMenuItem } from "@t3tools/contracts";
import { ChevronLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
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
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { readLocalApi } from "~/localApi";
import {
  selectProjectsForServer,
  selectServerById,
  useMcpManagerStore,
} from "../store";
import { useMcpMutations, useMcpProjectBindings, useMcpProjects, useMcpRegistry } from "../useMcp";
import { inProjectsLabel, toolsCountLabel } from "../format";
import type { McpRegistryServer } from "../types";
import { statusVisual } from "../visuals";
import { McpItemActions } from "./McpItemActions";
import { McpServerDialog } from "./McpServerDialog";
import { McpServerItemCard, type McpItemStatusLabel } from "./McpServerItemCard";
import { RegistryDetail } from "./RegistryDetail";

/**
 * Catalog tab. Narrow-panel master–detail: a searchable list that swaps to a detail view
 * when a server is opened (with a back affordance), so it stays readable at sidebar width.
 */
export function RegistryTab() {
  const registry = useMcpRegistry();
  const bindings = useMcpProjectBindings();
  const projects = useMcpProjects();
  const { recheck, removeServer, setServerEnabled } = useMcpMutations();
  const selectedServerId = useMcpManagerStore((state) => state.selectedServerId);
  const selectServer = useMcpManagerStore((state) => state.selectServer);

  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<McpRegistryServer | null>(null);

  // ⑭ right-click menu — the app's cross-platform context menu (sidebar's pattern; Electron + web).
  const handleRowContextMenu = (event: React.MouseEvent, server: McpRegistryServer) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          { id: "recheck", label: "Проверить", disabled: server.incomplete || server.templateOnly },
          { id: "edit", label: "Редактировать" },
          // delete only for custom servers — built-ins are not deletable (mirror ③)
          ...(server.source !== "builtin"
            ? [{ id: "delete" as const, label: "Удалить", destructive: true }]
            : []),
        ] satisfies ContextMenuItem<"recheck" | "edit" | "delete">[],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "recheck") void recheck({ serverId: server.id });
      else if (clicked === "edit") {
        selectServer(server.id);
        setDetailOpen(true);
      } else if (clicked === "delete") {
        setPendingDelete(server);
      }
    })();
  };

  const pendingDeleteProjects =
    pendingDelete === null
      ? []
      : projects.filter((project) =>
          selectProjectsForServer(bindings, pendingDelete.id).includes(project.id),
        );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return registry;
    return registry.filter(
      (server) =>
        server.name.toLowerCase().includes(needle) ||
        server.description.toLowerCase().includes(needle) ||
        server.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [query, registry]);

  const selectedServer = selectServerById(registry, selectedServerId);

  if (detailOpen && selectedServer) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-2 py-2">
          <Button variant="ghost" size="sm" onClick={() => setDetailOpen(false)}>
            <ChevronLeftIcon className="size-4" />
            Каталог
          </Button>
        </div>
        <RegistryDetail server={selectedServer} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск серверов…"
            className="pl-8"
            aria-label="Поиск MCP-серверов"
          />
        </div>
        <McpServerDialog
          trigger={
            <Button size="icon-xs" variant="outline" aria-label="Добавить MCP-сервер">
              <PlusIcon className="size-4" />
            </Button>
          }
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <Empty className="py-10">
            <EmptyTitle>Ничего не найдено</EmptyTitle>
            <EmptyDescription>Измените запрос или добавьте новый сервер.</EmptyDescription>
          </Empty>
        ) : (
          <div className="space-y-2.5 p-3">
            {filtered.map((server) => {
              const boundCount = selectProjectsForServer(bindings, server.id).length;
              const status = server.status ?? "unchecked";
              const visual = statusVisual(status);
              let statusLabel: McpItemStatusLabel | undefined;
              let statusDetail: string;
              let statusBadge: ReactNode | undefined;
              if (server.incomplete) {
                // Catalog-level required vars are unfilled — fixable HERE (edit the server). The names
                // overflow the truncated line, so show a count badge; the tooltip lists them in full.
                statusLabel = {
                  text: "требует настройки",
                  className: "text-amber-700 dark:text-amber-300/90",
                };
                statusDetail = "";
                statusBadge = (
                  <Badge variant="warning" size="sm" title={server.missingVars.join(", ")}>
                    {server.missingVars.length}
                  </Badge>
                );
              } else if (server.templateOnly) {
                // Only per-project holes remain — a «шаблон», never probed at the catalog level; show
                // usage instead of a misleading «Не проверено» (refresh is disabled below).
                statusLabel = { text: "шаблон", className: "text-muted-foreground" };
                statusDetail =
                  boundCount > 0 ? `используется ${inProjectsLabel(boundCount)}` : "не используется";
              } else {
                // Lead line 2 with the status word only when not connected; counts always.
                statusLabel =
                  status === "connected"
                    ? undefined
                    : { text: visual.label, className: visual.textClass };
                statusDetail = `${toolsCountLabel(server.tools.length)} · ${
                  boundCount > 0 ? inProjectsLabel(boundCount) : "не используется"
                }`;
              }
              return (
                <McpServerItemCard
                  key={server.id}
                  status={status}
                  name={server.name}
                  transport={server.config.transport}
                  source={server.source}
                  statusLabel={statusLabel}
                  statusDetail={statusDetail}
                  statusBadge={statusBadge}
                  description={server.description || undefined}
                  errorMessage={status === "error" ? server.message : undefined}
                  dimmed={!server.enabled}
                  onActivate={() => {
                    selectServer(server.id);
                    setDetailOpen(true);
                  }}
                  onContextMenu={(event) => handleRowContextMenu(event, server)}
                  actions={
                    <McpItemActions
                      recheckFilter={{ serverId: server.id }}
                      recheckDisabled={server.incomplete || server.templateOnly}
                      recheckAriaLabel={`Проверить ${server.name}`}
                      onDelete={
                        server.source !== "builtin" ? () => setPendingDelete(server) : undefined
                      }
                      deleteTitle="Удалить сервер"
                      deleteAriaLabel={`Удалить ${server.name}`}
                      enabled={server.enabled}
                      onToggleEnabled={(value) => setServerEnabled(server.id, value)}
                      switchAriaLabel={
                        server.enabled ? `Отключить ${server.name}` : `Включить ${server.name}`
                      }
                      switchTitle={server.enabled ? "Отключить в каталоге" : "Включить в каталоге"}
                    />
                  }
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* ⑭ delete confirmation for the right-click menu (custom servers only) */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        {pendingDelete !== null && (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить «{pendingDelete.name}»?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDeleteProjects.length > 0
                  ? `Будет удалён из каталога и из проектов: ${pendingDeleteProjects
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
                  removeServer(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                Удалить
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        )}
      </AlertDialog>
    </div>
  );
}
