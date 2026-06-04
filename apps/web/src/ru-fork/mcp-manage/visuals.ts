/**
 * MCP Manager — single source of truth for status presentation. Every surface (catalog
 * detail, project rows, badges) reads from here so colours/labels never drift (DRY).
 */

import type { McpStatus, McpTransport } from "./types";

export interface StatusVisual {
  /** Short Russian label for the status. */
  readonly label: string;
  /** Tailwind text colour class for the label. */
  readonly textClass: string;
  /** Tailwind background colour class for the status dot. */
  readonly dotClass: string;
  /** Whether the dot should pulse (transient states). */
  readonly pulse: boolean;
}

const STATUS_VISUALS: Record<McpStatus, StatusVisual> = {
  connected: {
    label: "Подключён",
    textClass: "text-emerald-600 dark:text-emerald-300/90",
    dotClass: "bg-emerald-500",
    pulse: false,
  },
  connecting: {
    label: "Подключение",
    textClass: "text-sky-600 dark:text-sky-300/90",
    dotClass: "bg-sky-500",
    pulse: true,
  },
  degraded: {
    label: "Нестабильно",
    textClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: "bg-amber-500",
    pulse: true,
  },
  error: {
    label: "Ошибка",
    textClass: "text-red-600 dark:text-red-300/90",
    dotClass: "bg-red-500",
    pulse: false,
  },
  disabled: {
    label: "Отключён",
    textClass: "text-muted-foreground",
    dotClass: "bg-zinc-400 dark:bg-zinc-500",
    pulse: false,
  },
};

export function statusVisual(status: McpStatus): StatusVisual {
  return STATUS_VISUALS[status];
}

/** Short uppercase transport label for badges. */
export function transportLabel(transport: McpTransport): string {
  return transport === "stdio" ? "stdio" : "http";
}

/** Human description of a transport for the detail view. */
export function transportDescription(transport: McpTransport): string {
  return transport === "stdio"
    ? "Локальный процесс (stdio)"
    : "Удалённый сервер (streamable HTTP)";
}
