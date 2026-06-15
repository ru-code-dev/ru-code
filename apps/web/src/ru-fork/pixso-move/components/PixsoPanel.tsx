import { LayersIcon, RefreshCwIcon, SettingsIcon, XIcon } from "lucide-react";
import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import { Toggle } from "~/components/ui/toggle-group";
import { usePixsoStore } from "../store";
import { GalleryView } from "./GalleryView";
import { NodeDetail } from "./NodeDetail";
import { SettingsView } from "./SettingsView";

/**
 * The Pixso Move panel. Built on `DiffPanelShell` so its background and header match the diff
 * panel exactly — `bg-background`, the same header row (height + Electron drag-region +
 * titlebar handling + `px-4` + bottom border). The action buttons are the same `Toggle`
 * (`variant="outline" size="xs"`, `bg-background` fill so they read transparent) the diff
 * header uses, run as momentary buttons (`pressed={false}`). The body is a master→detail
 * view: gallery → node detail → settings. Shared by the inline sidebar (`mode="sidebar"`)
 * and the mobile sheet (`mode="sheet"`).
 */
export function PixsoPanel({
  onClose,
  mode = "sidebar",
}: {
  onClose: () => void;
  mode?: DiffPanelMode;
}) {
  const view = usePixsoStore((state) => state.view);
  const openSettings = usePixsoStore((state) => state.openSettings);
  const refresh = usePixsoStore((state) => state.refresh);

  const header = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <LayersIcon className="size-4 text-muted-foreground" />
        <h2 className="truncate text-sm font-semibold">Макеты Pixso</h2>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Toggle
          variant="outline"
          size="xs"
          pressed={false}
          onPressedChange={() => refresh()}
          aria-label="Обновить макеты"
        >
          <RefreshCwIcon className="size-3" />
        </Toggle>
        <Toggle
          variant="outline"
          size="xs"
          pressed={false}
          onPressedChange={() => openSettings()}
          aria-label="Настройки Pixso Move"
        >
          <SettingsIcon className="size-3" />
        </Toggle>
        <Toggle
          variant="outline"
          size="xs"
          pressed={false}
          onPressedChange={() => onClose()}
          aria-label="Закрыть панель"
        >
          <XIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      {view === "settings" ? (
        <SettingsView />
      ) : view === "detail" ? (
        <NodeDetail />
      ) : (
        <GalleryView />
      )}
    </DiffPanelShell>
  );
}
