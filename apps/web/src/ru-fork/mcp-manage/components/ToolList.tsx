import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Checkbox } from "~/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import { paramsCountLabel } from "../format";
import type { McpTool, McpToolParam } from "../types";

interface ToolToggle {
  isEnabled: (toolName: string) => boolean;
  onToggle: (toolName: string, enabled: boolean) => void;
  disabled?: boolean;
}

/**
 * Accordion list of an MCP server's tools. Each tool expands to show its description and
 * parameters (when advertised). Two modes:
 *  - read-only (catalog): no checkbox.
 *  - toggleable (project binding): a checkbox enables/disables the tool for that project.
 */
export function ToolList({
  tools,
  toggle,
  emptyHint = "Этот сервер не объявляет инструменты в каталоге.",
}: {
  tools: readonly McpTool[];
  toggle?: ToolToggle;
  emptyHint?: string;
}) {
  if (tools.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">{emptyHint}</p>;
  }

  return (
    <ul className="space-y-1">
      {tools.map((tool) => (
        <ToolAccordionItem key={tool.name} tool={tool} toggle={toggle} />
      ))}
    </ul>
  );
}

function ToolAccordionItem({ tool, toggle }: { tool: McpTool; toggle: ToolToggle | undefined }) {
  const [open, setOpen] = useState(false);
  const enabled = toggle ? toggle.isEnabled(tool.name) : true;
  const paramCount = tool.params?.length ?? 0;

  return (
    <li
      className={cn(
        "overflow-hidden rounded-md border border-border/60 bg-background/40 transition-opacity",
        toggle && !enabled && "opacity-55",
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        {toggle && (
          <Checkbox
            checked={enabled}
            disabled={toggle.disabled}
            onCheckedChange={(checked) => toggle.onToggle(tool.name, checked === true)}
            aria-label={`Инструмент ${tool.name}`}
          />
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <code className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
            {tool.name}
          </code>
          {paramCount > 0 && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {paramsCountLabel(paramCount)}
            </Badge>
          )}
          <ChevronDownIcon
            className={cn(
              "ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border/50 px-2.5 py-2">
            <p className="text-xs leading-snug text-muted-foreground">{tool.description}</p>
            {paramCount > 0 ? (
              <dl className="space-y-1.5">
                {tool.params?.map((param) => <ParamRow key={param.name} param={param} />)}
              </dl>
            ) : (
              <p className="text-[11px] text-muted-foreground/70">Без параметров.</p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function ParamRow({ param }: { param: McpToolParam }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <code className="font-mono text-[11px] font-medium text-foreground">{param.name}</code>
        <span className="font-mono text-[11px] text-sky-600 dark:text-sky-300/90">
          {param.type}
        </span>
        {param.required ? (
          <Badge variant="outline" className="text-[9px] text-amber-700 dark:text-amber-300/90">
            обязательный
          </Badge>
        ) : (
          <span className="text-[10px] text-muted-foreground/60">необязательный</span>
        )}
      </div>
      {param.description && (
        <p className="text-[11px] leading-snug text-muted-foreground">{param.description}</p>
      )}
    </div>
  );
}
