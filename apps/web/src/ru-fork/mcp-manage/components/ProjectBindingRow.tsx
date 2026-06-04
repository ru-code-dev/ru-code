import { useState } from "react";
import { ChevronDownIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { effectiveBindingConfig, isToolEnabled, useMcpManagerStore } from "../store";
import type { McpProjectBinding, McpRegistryServer } from "../types";
import { transportLabel } from "../visuals";
import { ConfigSummary } from "./ConfigSummary";
import { ProjectConfigDialog } from "./ProjectConfigDialog";
import { StatusBadge } from "./StatusBadge";
import { ToolList } from "./ToolList";

/**
 * One server bound to a project: glanceable status + health, an enable switch, and an
 * expandable body with the config and per-tool toggles. Tools default to enabled.
 */
export function ProjectBindingRow({
  binding,
  server,
}: {
  binding: McpProjectBinding;
  server: McpRegistryServer;
}) {
  const setBindingEnabled = useMcpManagerStore((state) => state.setBindingEnabled);
  const setToolEnabled = useMcpManagerStore((state) => state.setToolEnabled);
  const removeBinding = useMcpManagerStore((state) => state.removeBinding);

  const [expanded, setExpanded] = useState(false);

  const enabledToolCount = server.tools.filter((tool) => isToolEnabled(binding, tool.name)).length;
  const hasConfigOverride = binding.configOverride !== undefined;
  const config = effectiveBindingConfig(binding, server);

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <StatusBadge status={binding.status} showLabel={false} className="shrink-0" />
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
              <Badge variant="secondary" className="shrink-0 uppercase">
                {transportLabel(config.transport)}
              </Badge>
              {hasConfigOverride && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300/90"
                >
                  своя конфигурация
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{binding.health.detail}</p>
          </div>
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground/60 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <Switch
          checked={binding.enabled}
          onCheckedChange={(checked) =>
            setBindingEnabled(server.id, binding.projectId, Boolean(checked))
          }
          aria-label={`Включить ${server.name}`}
        />
        <ProjectConfigDialog
          server={server}
          binding={binding}
          trigger={
            <Button
              size="icon-xs"
              variant="ghost"
              title="Настроить для проекта"
              aria-label={`Настроить ${server.name} для проекта`}
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          }
        />
      </div>

      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <StatusBadge status={binding.status} />
              {binding.health.latencyMs !== undefined && (
                <span className="text-xs text-muted-foreground">{binding.health.latencyMs} ms</span>
              )}
            </div>

            <ConfigSummary config={config} />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Инструменты
                </h4>
                <span className="text-[10px] text-muted-foreground/70">
                  включено {enabledToolCount} из {server.tools.length}
                </span>
              </div>
              <ToolList
                tools={server.tools}
                toggle={{
                  isEnabled: (toolName) => isToolEnabled(binding, toolName),
                  onToggle: (toolName, enabled) =>
                    setToolEnabled(server.id, binding.projectId, toolName, enabled),
                  disabled: !binding.enabled,
                }}
                emptyHint="Сервер не объявляет инструменты."
              />
            </div>

            <Button
              variant="destructive-outline"
              size="sm"
              onClick={() => removeBinding(server.id, binding.projectId)}
            >
              <Trash2Icon className="size-4" />
              Убрать из проекта
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
