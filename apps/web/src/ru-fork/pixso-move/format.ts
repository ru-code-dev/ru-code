import type { PixsoProcessingStatus } from "./api";

// Russian labels + badge tone for a processing status. Kept here so every surface agrees.
export const statusLabel: Record<PixsoProcessingStatus, string> = {
  pending: "В очереди",
  processing: "Обрабатывается",
  done: "Готово",
  error: "Ошибка",
};

export const statusTone: Record<
  PixsoProcessingStatus,
  "secondary" | "outline" | "default" | "destructive"
> = {
  pending: "outline",
  processing: "secondary",
  done: "default",
  error: "destructive",
};

// e.g. "14 июн., 16:32" — compact local timestamp for a stored macet.
export function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
