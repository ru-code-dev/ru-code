import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import type { McpServerSource, McpStatus, McpTransport } from "../types";
import { transportLabel } from "../visuals";
import { StatusBadge } from "./StatusBadge";

/** The colored leading word of line 2 (status), e.g. «Подключён» green / «Ошибка» red. */
export interface McpItemStatusLabel {
  readonly text: string;
  readonly className: string;
}

/**
 * The unified MCP item card — ONE shell for the catalog list AND the project list, so they look
 * identical. Left: status dot (vertically centered). Body (4 lines): (1) transport badge + source
 * tag + name, (2) status word + counts, (3) description (clamp-2), (4) error (clamp-2). Right: the
 * caller's `actions` cluster (McpItemActions). The only behavioral difference is the body click:
 * `navigate` (catalog → opens the detail) vs `collapsible` (project → toggles `children` below).
 */
export interface McpServerItemCardProps {
  readonly status: McpStatus;
  readonly name: string;
  readonly transport: McpTransport;
  readonly source: McpServerSource;
  readonly statusLabel?: McpItemStatusLabel | undefined;
  readonly statusDetail?: string | undefined;
  /** Optional small chip after the status word (e.g. a count for «требует настройки»). */
  readonly statusBadge?: ReactNode | undefined;
  readonly description?: string | undefined;
  readonly errorMessage?: string | undefined;
  /** Dim the whole card (catalog server disabled, or a project binding whose catalog server is off). */
  readonly dimmed?: boolean | undefined;
  /** Body click — navigate (catalog) or toggle expand (project). */
  readonly onActivate: () => void;
  readonly onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  /** Right-side controls (an <McpItemActions/>). */
  readonly actions: ReactNode;
  /** Collapsible card: when defined, drives aria-expanded; render the body as `children`. */
  readonly expanded?: boolean | undefined;
  readonly children?: ReactNode;
}

export function McpServerItemCard({
  status,
  name,
  transport,
  source,
  statusLabel,
  statusBadge,
  statusDetail,
  description,
  errorMessage,
  dimmed,
  onActivate,
  onContextMenu,
  actions,
  expanded,
  children,
}: McpServerItemCardProps) {
  // Activate (navigate / toggle) on mouse-up — but NOT when the user just selected text in the
  // card (so they can highlight/copy the description without it collapsing or navigating away).
  const activateUnlessSelecting = () => {
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    onActivate();
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/70 bg-card",
        dimmed && "opacity-50",
      )}
    >
      <div className="px-3 py-2.5" onContextMenu={onContextMenu}>
        {/* Top row: dot + (name/status) + controls — they flank only lines 1–2. */}
        <div className="flex items-start gap-2">
          {/* Dot sits on the first line (top), not centered across the whole card. */}
          <StatusBadge status={status} showLabel={false} className="mt-1.5 shrink-0" />
          <button
            type="button"
            onClick={activateUnlessSelecting}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            {/* line 1: transport badge · source tag · name */}
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="shrink-0 uppercase">
                {transportLabel(transport)}
              </Badge>
              <Badge variant={source === "builtin" ? "secondary" : "outline"} className="shrink-0">
                {source === "builtin" ? "встроенный" : "мой"}
              </Badge>
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
            </div>
            {/* line 2: status word + counts */}
            {(statusLabel || statusDetail || statusBadge) && (
              <p className="truncate text-xs">
                {statusLabel && <span className={statusLabel.className}>{statusLabel.text}</span>}
                {statusBadge && <span className="ml-1 align-middle">{statusBadge}</span>}
                {statusLabel && statusDetail && <span className="text-muted-foreground"> · </span>}
                {statusDetail && <span className="text-muted-foreground">{statusDetail}</span>}
              </p>
            )}
          </button>
          {actions}
        </div>
        {/* Lines 3–4 stretch full width but stay LEFT-aligned with the name above (past the
            dot + gap = size-2 + gap-2 = 16px ⇒ pl-4), not under the dot. Clickable too — but only
            when no text is selected, so the description stays copyable. */}
        {(description || errorMessage) && (
          <div className="mt-1 cursor-pointer space-y-0.5 pl-4" onMouseUp={activateUnlessSelecting}>
            {description && (
              <p className="line-clamp-2 text-xs leading-snug text-muted-foreground/70">
                {description}
              </p>
            )}
            {errorMessage && (
              <p className="line-clamp-2 text-xs leading-snug text-red-600 dark:text-red-300/90">
                {errorMessage}
              </p>
            )}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
