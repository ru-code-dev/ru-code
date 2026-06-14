// ru-fork: a "Проверить" / refresh icon button that force-probes the matching MCP
// instances now (bypassing the auto-recheck interval). Used in the catalog detail,
// each project binding row, and the panel header — the spinner reflects the probe
// in flight; the resulting status + tools arrive over the runtime stream.

import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useMcpMutations } from "../useMcp";

export function RecheckButton({
  filter,
  ariaLabel,
  title = "Проверить",
  disabled = false,
  className,
}: {
  readonly filter: {
    readonly projectId?: string;
    readonly serverId?: string;
    readonly transport?: "stdio" | "http";
  };
  readonly ariaLabel: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const { recheck } = useMcpMutations();
  const [probing, setProbing] = useState(false);

  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className={cn("shrink-0", className)}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled || probing}
      onClick={() => {
        setProbing(true);
        void recheck(filter).finally(() => setProbing(false));
      }}
    >
      <RefreshCwIcon className={cn("size-4", probing && "animate-spin")} />
    </Button>
  );
}
