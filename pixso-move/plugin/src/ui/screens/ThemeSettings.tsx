import {
  SettingResetButton,
  SettingsRow,
} from "../components/settings/settingsLayout.tsx";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import {
  asThemeMode,
  asThemeName,
  DEFAULT_THEME_NAME,
  THEME_MODE_LABELS,
  THEME_MODES,
  THEME_NAME_LABELS,
  THEME_NAMES,
} from "../theme.ts";

const APP_NAME = "Pixso Move";

interface ThemeSettingsProps {
  readonly themeMode: string;
  readonly themeName: string;
  readonly onChange: (patch: { readonly themeMode?: string; readonly themeName?: string }) => void;
}

// Theme + colour-palette rows — identical structure to apps/web GeneralSettingsPanel.
export function ThemeSettings({ themeMode, themeName, onChange }: ThemeSettingsProps) {
  return (
    <>
      <SettingsRow
        title="Тема"
        description={`Выберите, как ${APP_NAME} будет выглядеть в приложении.`}
        resetAction={
          themeMode !== "system" ? (
            <SettingResetButton label="theme" onClick={() => onChange({ themeMode: "system" })} />
          ) : null
        }
        control={
          <Select
            value={themeMode}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") {
                onChange({ themeMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
              <SelectValue>{THEME_MODE_LABELS[asThemeMode(themeMode)]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {THEME_MODES.map((mode) => (
                <SelectItem hideIndicator key={mode} value={mode}>
                  {THEME_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Цветовая палитра"
        description="Выберите палитру. Светлый/тёмный режим по-прежнему задаётся настройкой Тема выше."
        resetAction={
          themeName !== DEFAULT_THEME_NAME ? (
            <SettingResetButton
              label="color theme"
              onClick={() => onChange({ themeName: DEFAULT_THEME_NAME })}
            />
          ) : null
        }
        control={
          <Select
            value={themeName}
            onValueChange={(value) => {
              if (value !== null && (THEME_NAMES as readonly string[]).includes(value)) {
                onChange({ themeName: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Color theme">
              <SelectValue>{THEME_NAME_LABELS[asThemeName(themeName)]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {THEME_NAMES.map((name) => (
                <SelectItem hideIndicator key={name} value={name}>
                  {THEME_NAME_LABELS[name]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}
