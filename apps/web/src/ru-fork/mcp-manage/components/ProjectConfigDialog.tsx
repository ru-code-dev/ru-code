import { type ReactElement, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { effectiveBindingConfig, useMcpManagerStore } from "../store";
import type { McpProjectBinding, McpRegistryServer } from "../types";
import { ServerConfigFields } from "./ServerConfigFields";
import { configFromDraft, draftFromConfig, type ServerConfigDraft } from "./serverConfigForm";

/**
 * Configure a server *for one project*. Pre-filled from the binding's effective config
 * (override or catalog default). Saving stores a per-project override; "reset" reverts to
 * the catalog default so the binding tracks the server again.
 */
export function ProjectConfigDialog({
  trigger,
  server,
  binding,
}: {
  trigger: ReactElement;
  server: McpRegistryServer;
  binding: McpProjectBinding;
}) {
  const setBindingConfig = useMcpManagerStore((state) => state.setBindingConfig);
  const hasOverride = binding.configOverride !== undefined;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ServerConfigDraft>(() =>
    draftFromConfig(effectiveBindingConfig(binding, server)),
  );
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    setError(null);
    const result = configFromDraft(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBindingConfig(server.id, binding.projectId, result.config);
    setOpen(false);
  }

  function handleReset() {
    setBindingConfig(server.id, binding.projectId, null);
    setDraft(draftFromConfig(server.config));
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Re-sync the draft each time the dialog opens (override may have changed).
          setDraft(draftFromConfig(effectiveBindingConfig(binding, server)));
          setError(null);
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройка «{server.name}» для проекта</DialogTitle>
          <DialogDescription>
            Эти параметры действуют только в этом проекте и не меняют сервер в каталоге.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {hasOverride && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300/90">
                Для этого проекта задана своя конфигурация — она отличается от каталога.
              </p>
            )}
            <ServerConfigFields value={draft} onChange={setDraft} idPrefix="mcp-proj" />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={handleReset}
            disabled={!hasOverride}
            title={hasOverride ? "Вернуть конфигурацию из каталога" : "Сейчас используется каталог"}
          >
            <RotateCcwIcon className="size-4" />
            Сбросить к умолчанию
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSave}>Сохранить</Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
