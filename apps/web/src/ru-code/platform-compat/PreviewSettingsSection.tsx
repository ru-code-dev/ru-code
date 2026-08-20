// ru-code: preview settings section — the port-scanning opt-in (seam: SettingsPanels.tsx
// mount, beside McpSettingsSection). Server-owned setting `preview.portScanEnabled`, schema
// decode-default FALSE on every platform/install: scanning (and the terminal foreground
// inspection it feeds) spawns recurring child processes — needless background churn — so
// nothing runs until the user flips this. The server gates the spawns; this is just the knob.

import { useAtomValue } from "@effect/atom-react";
import { L } from "@ru-code/localization";

import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { serverEnvironment, primaryServerSettingsAtom } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

export function PreviewSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const previewSettings = useAtomValue(primaryServerSettingsAtom).preview;
  const persistSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "preview settings change",
  );

  const setPortScanEnabled = (enabled: boolean) => {
    if (environmentId !== null) {
      void persistSettings({
        environmentId,
        input: { patch: { preview: { portScanEnabled: enabled } } },
      });
    }
  };

  return (
    <SettingsSection title={L("Preview", "Предпросмотр")}>
      <SettingsRow
        title={L("Port scanning", "Сканирование портов")}
        description={L(
          "Discover local dev servers for the preview panel by periodically scanning ports. Runs background checks every few seconds while enabled — leave off unless you use the preview.",
          "Обнаруживать локальные dev-серверы для панели предпросмотра, периодически сканируя порты. Пока включено, фоновая проверка выполняется раз в несколько секунд — не включайте, если не пользуетесь предпросмотром.",
        )}
        control={
          <Switch
            checked={previewSettings.portScanEnabled}
            onCheckedChange={(checked) => setPortScanEnabled(Boolean(checked))}
            aria-label={L("Enable preview port scanning", "Включить сканирование портов")}
          />
        }
      />
    </SettingsSection>
  );
}
