import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import {
  selectProjectsForServer,
  selectServerById,
  useMcpManagerStore,
} from "../store";
import { inProjectsLabel, toolsCountLabel } from "../format";
import { transportLabel } from "../visuals";
import { McpServerDialog } from "./McpServerDialog";
import { RegistryDetail } from "./RegistryDetail";

/**
 * Catalog tab. Narrow-panel master–detail: a searchable list that swaps to a detail view
 * when a server is opened (with a back affordance), so it stays readable at sidebar width.
 */
export function RegistryTab() {
  const registry = useMcpManagerStore((state) => state.registry);
  const bindings = useMcpManagerStore((state) => state.bindings);
  const selectedServerId = useMcpManagerStore((state) => state.selectedServerId);
  const selectServer = useMcpManagerStore((state) => state.selectServer);

  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);

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
          <ul className="p-2">
            {filtered.map((server) => {
              const boundCount = selectProjectsForServer(bindings, server.id).length;
              const isSelected = server.id === selectedServerId;
              return (
                <li key={server.id}>
                  <button
                    type="button"
                    onClick={() => {
                      selectServer(server.id);
                      setDetailOpen(true);
                    }}
                    className={cn(
                      "group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                      isSelected ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {server.name}
                        </span>
                        <Badge variant="secondary" className="shrink-0 uppercase">
                          {transportLabel(server.config.transport)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {toolsCountLabel(server.tools.length)}
                        {boundCount > 0 ? ` · ${inProjectsLabel(boundCount)}` : ""}
                      </p>
                      {server.description && (
                        <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
                          {server.description}
                        </p>
                      )}
                    </div>
                    <ChevronRightIcon className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground/60" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
