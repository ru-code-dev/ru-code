import { useState } from "react";
import type { ContextMenuItem } from "@t3tools/contracts";
import { BookOpenIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { readLocalApi } from "~/localApi";
import { isToolEnabled, useMcpManagerStore } from "../store";
import { useMcpMutations } from "../useMcp";
import type { McpProjectBinding, McpRegistryServer } from "../types";
import { statusVisual } from "../visuals";
import { toolsCountLabel } from "../format";
import { ConfigSummary } from "./ConfigSummary";
import { McpItemActions } from "./McpItemActions";
import { McpServerItemCard } from "./McpServerItemCard";
import { ProjectConfigDialog } from "./ProjectConfigDialog";
import { ToolList } from "./ToolList";

/**
 * One server bound to a project — rendered with the SAME shared card as the catalog (McpServerItemCard),
 * the only difference being it's collapsible (the body expands in place instead of navigating). The
 * collapse body holds the config, per-tool toggles, and the show-in-catalog / remove pair.
 */
export function ProjectBindingRow({
  binding,
  server,
}: {
  binding: McpProjectBinding;
  server: McpRegistryServer;
}) {
  const { setBindingEnabled, setToolEnabled, removeBinding, recheck } = useMcpMutations();
  const selectServer = useMcpManagerStore((state) => state.selectServer);
  const setActiveTab = useMcpManagerStore((state) => state.setActiveTab);

  const [expanded, setExpanded] = useState(false);

  // Live tools discovered by the probe for this binding; fall back to the
  // catalog's cached list before the first probe.
  const tools = binding.discoveredTools.length > 0 ? binding.discoveredTools : server.tools;
  const enabledToolCount = tools.filter((tool) => isToolEnabled(binding, tool.name)).length;
  // Identity is locked to the catalog, so the binding runs the catalog template.
  const config = server.config;
  // ⑬ the catalog server is disabled — the binding stays listed but grayed + inactive.
  const catalogDisabled = !server.enabled;
  // P2: the catalog server has unfilled CATALOG-level required vars (server.incomplete). The reactor
  // skips probing it, so this binding has no runtime row and would read «Подключение» (blue) forever.
  // It's the catalog author's job to fix (the project can't), so show a neutral, catalog-pointing state.
  const catalogIncomplete = !catalogDisabled && server.incomplete;
  // The dot/status the row should show: neutral when the catalog server is off OR needs catalog setup.
  const rowStatus = catalogDisabled || catalogIncomplete ? "disabled" : binding.status;
  const statusVis = statusVisual(binding.status);
  // Line 2 leading word, by priority: off-in-catalog → needs-catalog-setup → per-project setup → status.
  const statusLabel = catalogDisabled
    ? { text: "Отключён в каталоге", className: statusVisual("disabled").textClass }
    : catalogIncomplete
      ? { text: "Требует настройки в каталоге", className: statusVisual("disabled").textClass }
      : binding.incomplete
        ? {
            text: `Требует настройки: ${binding.missingVars.join(", ")}`,
            className: "text-amber-700 dark:text-amber-300/90",
          }
        : { text: statusVis.label, className: statusVis.textClass };
  const statusDetail =
    catalogDisabled || catalogIncomplete || binding.incomplete
      ? undefined
      : toolsCountLabel(tools.length);
  const errorMessage =
    !catalogDisabled && !catalogIncomplete && !binding.incomplete && binding.status === "error"
      ? binding.health.detail
      : undefined;

  // ⑩ right-click menu — recheck / show-in-catalog / remove (cross-platform; same as the sidebar).
  const handleRowContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          { id: "recheck", label: "Проверить", disabled: binding.incomplete || catalogIncomplete },
          { id: "show", label: "Показать в каталоге" },
          { id: "delete", label: "Убрать из проекта", destructive: true },
        ] satisfies ContextMenuItem<"recheck" | "show" | "delete">[],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "recheck") void recheck({ projectId: binding.projectId, serverId: server.id });
      else if (clicked === "show") {
        selectServer(server.id);
        setActiveTab("registry");
      } else if (clicked === "delete") {
        removeBinding(server.id, binding.projectId);
      }
    })();
  };

  return (
    <McpServerItemCard
      status={rowStatus}
      name={server.name}
      transport={config.transport}
      source={server.source}
      statusLabel={statusLabel}
      statusDetail={statusDetail}
      description={!catalogDisabled ? server.description || undefined : undefined}
      errorMessage={errorMessage}
      dimmed={catalogDisabled || catalogIncomplete}
      onActivate={() => setExpanded((value) => !value)}
      onContextMenu={handleRowContextMenu}
      expanded={expanded}
      actions={
        <McpItemActions
          recheckFilter={{ projectId: binding.projectId, serverId: server.id }}
          recheckDisabled={binding.incomplete || catalogIncomplete}
          recheckAriaLabel={`Проверить ${server.name}`}
          editTrigger={
            <ProjectConfigDialog
              server={server}
              binding={binding}
              trigger={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title={binding.checking ? "Идёт проверка…" : "Настроить для проекта"}
                  aria-label={`Настроить ${server.name} для проекта`}
                  disabled={binding.checking}
                >
                  <PencilIcon className="size-4" />
                </Button>
              }
            />
          }
          onDelete={() => removeBinding(server.id, binding.projectId)}
          deleteTitle="Убрать из проекта"
          deleteAriaLabel={`Убрать ${server.name} из проекта`}
          enabled={binding.enabled}
          onToggleEnabled={(value) => setBindingEnabled(server.id, binding.projectId, value)}
          switchAriaLabel={`Включить ${server.name}`}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      }
    >
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            {binding.health.latencyMs !== undefined && (
              <p className="text-xs text-muted-foreground">
                Ответ получен за: {binding.health.latencyMs} ms
              </p>
            )}

            <ConfigSummary config={config} vars={server.vars} />

            {/* Hidden entirely when the server exposes no tools. */}
            {tools.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Инструменты
                  </h4>
                  <span className="text-[10px] text-muted-foreground/70">
                    включено {enabledToolCount} из {tools.length}
                  </span>
                </div>
                <ToolList
                  tools={tools}
                  toggle={{
                    isEnabled: (toolName) => isToolEnabled(binding, toolName),
                    onToggle: (toolName, enabled) =>
                      setToolEnabled(server.id, binding.projectId, toolName, enabled),
                    disabled: !binding.enabled,
                  }}
                  emptyHint="Сервер не объявляет инструменты."
                />
              </div>
            )}

            {/* ⑧ «Показать в каталоге» sits right beside «Убрать из проекта» */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  selectServer(server.id);
                  setActiveTab("registry");
                }}
              >
                <BookOpenIcon className="size-4" />
                Показать в каталоге
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                onClick={() => removeBinding(server.id, binding.projectId)}
              >
                <Trash2Icon className="size-4" />
                Убрать из проекта
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </McpServerItemCard>
  );
}
