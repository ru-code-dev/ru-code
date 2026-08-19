// ru-code: pick the CLI brand profile (custom fork vs stock qwen) for a qwen
// provider instance. Rendered ONLY in the add-provider dialog, so it uses the
// dialog's field layout (label + control + description stacked, no border/padding)
// to match the neighboring ProviderSettingsForm fields — NOT SettingsRow, whose
// card chrome would double-wrap inside the dialog. One provider kind under the
// hood; the profile only changes the display name, artifact id and bin/dir
// defaults. See specs/cli-profiles.md.
import {
  CLI_PROFILES,
  CLI_PROFILE_IDS,
  resolveCliProfile,
  type CliProfileId,
} from "@ru-code/branding";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export interface CliProfileSelectProps {
  readonly value: CliProfileId;
  readonly onChange: (id: CliProfileId) => void;
}

export function CliProfileSelect({ value, onChange }: CliProfileSelectProps) {
  const profile = resolveCliProfile(value);
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">CLI type</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null && (CLI_PROFILE_IDS as readonly string[]).includes(next)) {
            onChange(next as CliProfileId);
          }
        }}
      >
        <SelectTrigger className="w-full bg-background" aria-label="CLI type">
          <SelectValue>{profile.name}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {CLI_PROFILE_IDS.map((id) => (
            <SelectItem hideIndicator key={id} value={id}>
              {CLI_PROFILES[id].name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <span className="text-[11px] text-muted-foreground">{profile.description}</span>
    </div>
  );
}
