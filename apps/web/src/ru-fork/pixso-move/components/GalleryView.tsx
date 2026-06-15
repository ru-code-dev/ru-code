import { LayersIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { previewDataUrl } from "../api";
import { formatAddedAt } from "../format";
import { usePixsoNodes } from "../queries";
import { usePixsoStore } from "../store";

/** Catalog of stored macets. Fetches only after the user presses refresh (manual sync). */
export function GalleryView() {
  const settings = usePixsoStore((state) => state.settings);
  const nonce = usePixsoStore((state) => state.refreshNonce);
  const openNode = usePixsoStore((state) => state.openNode);
  const openSettings = usePixsoStore((state) => state.openSettings);
  const hasKey = settings.designerId.trim().length > 0;
  const query = usePixsoNodes(settings.serverUrl, settings.designerId, nonce);

  if (!hasKey) {
    return (
      <Empty className="flex-1">
        <EmptyMedia variant="icon">
          <LayersIcon />
        </EmptyMedia>
        <EmptyTitle>Pixso Move</EmptyTitle>
        <EmptyDescription>
          Используйте макеты прямо из Pixso при помощи Pixso Move. Добавьте идентификатор в
          настройках.
        </EmptyDescription>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={openSettings}>
            Открыть настройки
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (nonce === 0) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>Нет данных</EmptyTitle>
        <EmptyDescription>Нажмите «Обновить», чтобы загрузить макеты.</EmptyDescription>
      </Empty>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>Не удалось загрузить</EmptyTitle>
        <EmptyDescription>{(query.error as Error).message}</EmptyDescription>
      </Empty>
    );
  }

  if (query.data.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>Пока пусто</EmptyTitle>
        <EmptyDescription>Отправьте макет из плагина Pixso.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="grid grid-cols-2 gap-2 p-2">
        {query.data.map((node) => (
          <li key={node.nodeId}>
            <button
              type="button"
              onClick={() => openNode(node.nodeId)}
              className={cn(
                "group flex w-full flex-col overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-ring",
              )}
            >
              <img
                src={previewDataUrl(node.preview)}
                alt={node.rootName}
                className="aspect-video w-full bg-white object-contain"
              />
              <span className="truncate px-2 pt-1.5 text-xs font-medium">{node.rootName}</span>
              <span className="px-2 pb-1.5 text-[10px] text-muted-foreground">
                {formatAddedAt(node.addedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
