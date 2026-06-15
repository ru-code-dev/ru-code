import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

/**
 * A collapsible code panel, matching the MCP `ToolList` accordion exactly: a single rounded,
 * `overflow-hidden` border; a plain header button (title + optional trailing badge + a chevron
 * that rotates with the controlled open state); and the body separated by a top border (no
 * second border / corners of its own). The body is height-capped and vertically scrollable.
 */
export function CodeCollapsible({
  title,
  trailing,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {trailing}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="max-h-60 overflow-y-auto border-t border-border/50">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
