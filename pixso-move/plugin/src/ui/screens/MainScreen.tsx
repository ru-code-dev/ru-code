import { Loader2, Send, Settings as SettingsIcon } from "lucide-react";

import { Button } from "../components/ui/button.tsx";
import type { UiState } from "../state/types.ts";
import { Body } from "./Body.tsx";

interface MainScreenProps {
  readonly state: UiState;
  readonly onOpenSettings: () => void;
  readonly onSend: () => void;
}

export function MainScreen({ state, onOpenSettings, onSend }: MainScreenProps) {
  const configured =
    state.settings.serverUrl.length > 0 && state.settings.designerId.length > 0;
  const ready = state.selectionVerdict.ok && state.preview !== null;
  const canSend = ready && configured && !state.sending;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-border border-b px-4">
        <span className="font-semibold">Pixso Move</span>
        <Button variant="outline" size="icon-xs" aria-label="Настройки" onClick={onOpenSettings}>
          <SettingsIcon />
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        <Body state={state} />
      </main>

      <footer className="flex shrink-0 justify-center border-border border-t p-3">
        <Button onClick={onSend} disabled={!canSend}>
          {state.sending ? (
            <>
              <Loader2 className="animate-spin" /> Отправка…
            </>
          ) : (
            <>
              <Send /> Отправить на сервер
            </>
          )}
        </Button>
      </footer>
    </div>
  );
}
