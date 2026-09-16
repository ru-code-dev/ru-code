import { APP_AUTO_COMPACTION_ANYWHERE } from "@ru-code/provider-capabilities";

import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";

interface AutoCompactContextRowProps {
  /** Current `autoCompactContext` setting value. */
  readonly checked: boolean;
  /** Whether the value differs from the default (shows the reset affordance). */
  readonly isModified: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly onReset: () => void;
}

/**
 * Settings row for the auto-compact-context toggle — hidden /compress at ≥75%
 * for providers without self-compaction.
 *
 * ru-code (qwen-compression wave): HIDDEN while no provider reads the setting.
 * qwen 0.21.1 compresses itself before every model send (Session.ts:4363-4372),
 * so its `appAutoCompaction` capability is false and the adapter's trigger bails
 * — a switch the user can still flip would promise a behaviour nothing performs.
 * The setting's contract, its persistence and the adapter's whole trigger path
 * are deliberately untouched; this row returns as soon as some provider needs it
 * again. The gate lives here rather than at the mount in
 * `components/settings/SettingsPanels.tsx` so the upstream file keeps its single
 * unconditional call into our zone.
 */
export function AutoCompactContextRow(props: AutoCompactContextRowProps) {
  if (!APP_AUTO_COMPACTION_ANYWHERE) return null;
  return <AutoCompactContextRowBody {...props} />;
}

/**
 * The row's markup, separate from the gate so it keeps its render coverage while
 * the feature is dormant (see `autoCompactContextRow.render.test.tsx`).
 */
export function AutoCompactContextRowBody({
  checked,
  isModified,
  onCheckedChange,
  onReset,
}: AutoCompactContextRowProps) {
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
