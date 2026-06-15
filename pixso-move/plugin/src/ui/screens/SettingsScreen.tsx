import { Copy, RefreshCw } from "lucide-react";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout.tsx";
import { showSuccess } from "../components/Toaster.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { generateDesignerId } from "../key.ts";
import { DEFAULT_SETTINGS } from "../state/reducer.ts";
import type { Settings } from "../state/types.ts";
import { SettingsHeader } from "./SettingsHeader.tsx";
import { ThemeSettings } from "./ThemeSettings.tsx";

const APP_VERSION = "0.0.0";

interface SettingsScreenProps {
  readonly settings: Settings;
  readonly onChange: (next: Settings) => void;
  readonly onBack: () => void;
}

export function SettingsScreen({ settings, onChange, onBack }: SettingsScreenProps) {
  const set = (patch: Partial<Settings>): void => onChange({ ...settings, ...patch });
  const dirty =
    settings.themeMode !== DEFAULT_SETTINGS.themeMode ||
    settings.themeName !== DEFAULT_SETTINGS.themeName ||
    settings.serverUrl !== DEFAULT_SETTINGS.serverUrl ||
    settings.designerId.length > 0;
  const copyKey = (): void => {
    void navigator.clipboard?.writeText(settings.designerId);
    showSuccess("Ключ скопирован");
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <SettingsHeader dirty={dirty} onBack={onBack} onReset={() => onChange(DEFAULT_SETTINGS)} />
      <SettingsPageContainer>
        <SettingsSection title="Общие">
          <ThemeSettings
            themeMode={settings.themeMode}
            themeName={settings.themeName}
            onChange={(patch) => set(patch)}
          />
          <SettingsRow
            title="Адрес сервера"
            description="Куда отправлять выбранные фреймы."
            resetAction={
              settings.serverUrl !== DEFAULT_SETTINGS.serverUrl ? (
                <SettingResetButton
                  label="server address"
                  onClick={() => set({ serverUrl: DEFAULT_SETTINGS.serverUrl })}
                />
              ) : null
            }
            control={
              <Input
                className="w-full sm:w-56"
                value={settings.serverUrl}
                onChange={(event) => set({ serverUrl: event.target.value })}
                placeholder="https://..."
              />
            }
          />
          <SettingsRow
            title="Ключ дизайнера"
            description="Сохраните ключ и поделитесь им с разработчиком."
            resetAction={
              settings.designerId.length > 0 ? (
                <SettingResetButton label="designer key" onClick={() => set({ designerId: "" })} />
              ) : null
            }
          >
            <div className="flex flex-col gap-2 pt-3 pb-4">
              <Input
                value={settings.designerId}
                onChange={(event) => set({ designerId: event.target.value })}
                placeholder="—"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => set({ designerId: generateDesignerId() })}
                >
                  <RefreshCw />
                  Сгенерировать
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={settings.designerId.length === 0}
                  onClick={copyKey}
                >
                  <Copy />
                  Скопировать
                </Button>
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="О программе">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <span>Версия</span>
                <code className="font-medium text-[11px] text-muted-foreground">{APP_VERSION}</code>
              </span>
            }
            description="Текущая версия приложения."
          />
        </SettingsSection>
      </SettingsPageContainer>
    </div>
  );
}
