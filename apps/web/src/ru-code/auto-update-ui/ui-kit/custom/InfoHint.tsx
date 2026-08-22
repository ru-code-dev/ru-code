// ru-code: auto-update ui-kit — small (i) trigger with a tooltip explanation.
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../cn";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../tooltip";

export function InfoHint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="More"
        className={cn(
          "inline-flex size-4 cursor-help items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <InfoIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        <div className="px-1 py-0.5 text-xs leading-relaxed">{children}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
