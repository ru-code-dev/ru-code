import { ChevronLeftIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "../components/ui/button.tsx";

interface SettingsHeaderProps {
  readonly dirty: boolean;
  readonly onBack: () => void;
  readonly onReset: () => void;
}

// Mirrors apps/web/src/routes/settings.tsx settings header: title + restore-defaults
// (disabled when nothing changed). The back button replaces the app's sidebar nav.
export function SettingsHeader({ dirty, onBack, onReset }: SettingsHeaderProps) {
  return (
    <header className="border-border border-b px-3 py-2 sm:px-5">
      <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon className="size-4" />
          Назад
        </Button>
        <div className="ms-auto flex items-center gap-2">
          <Button size="xs" variant="outline" disabled={!dirty} onClick={onReset}>
            <RotateCcwIcon className="size-3.5" />
            Сбросить настройки
          </Button>
        </div>
      </div>
    </header>
  );
}
