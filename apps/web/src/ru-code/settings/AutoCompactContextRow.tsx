import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";

/**
 * Settings row for the auto-compact-context toggle — hidden /compress at ≥75%
 * for providers without self-compaction (qwen).
 */
export function AutoCompactContextRow({
  checked,
  isModified,
  onCheckedChange,
  onReset,
}: {
  /** Current `autoCompactContext` setting value. */
  readonly checked: boolean;
  /** Whether the value differs from the default (shows the reset affordance). */
  readonly isModified: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly onReset: () => void;
}) {
  return (
    <SettingsRow
      title="Auto-compact context"
      description="Automatically compact the conversation history when the context is over 75% full (for CLIs without built-in auto-compaction)."
      resetAction={
        isModified ? <SettingResetButton label="auto-compact context" onClick={onReset} /> : null
      }
      control={
        <Switch
          checked={checked}
          onCheckedChange={(checked) => onCheckedChange(Boolean(checked))}
          aria-label="Auto-compact context"
        />
      }
    />
  );
}
