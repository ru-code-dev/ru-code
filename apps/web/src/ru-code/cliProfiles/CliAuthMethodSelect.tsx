// ru-code: pick the ACP auth method for a qwen instance — the session-start default
// (on the provider card) and per custom model (in the models section). Options come
// from @ru-code/branding (the five qwen AuthTypes), one source of truth shared with
// the server resolver. An empty value means "Auto" — resolved server-side. The Auto
// label carries the method it resolves to IN THIS CONTEXT (`fallbackAuthMethod`): the
// profile default on the card row, the effective instance default per custom model —
// so the hint always matches what the server will actually use.
import {
  AUTH_METHODS,
  AUTH_METHOD_IDS,
  resolveCliProfile,
  type AuthMethodId,
  type CliProfileId,
} from "@ru-code/branding";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsRow } from "~/components/settings/settingsLayout";

/** The empty sentinel stored for "Auto — resolve server-side". */
export const AUTO_AUTH_METHOD = "";

/**
 * Human label for an auth-method value, or the Auto hint for the empty value.
 * `fallbackAuthMethod` is the method Auto resolves to in the caller's context.
 */
export function authMethodLabel(value: string, fallbackAuthMethod: AuthMethodId): string {
  const match = AUTH_METHODS.find((method) => method.id === value);
  if (match) return match.label;
  const fallback = AUTH_METHODS.find((method) => method.id === fallbackAuthMethod);
  return `Auto (${fallback?.label ?? fallbackAuthMethod})`;
}

export interface CliAuthMethodSelectProps {
  /** Current stored value; `""` ⇒ Auto (resolves to `fallbackAuthMethod`). */
  readonly value: string;
  /** The method Auto resolves to here — drives the Auto label so it never lies. */
  readonly fallbackAuthMethod: AuthMethodId;
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
}

/** The bare Select (Auto + the five methods) — reused on the card and the add form. */
export function CliAuthMethodSelect({
  value,
  fallbackAuthMethod,
  onChange,
  ariaLabel = "Authentication method",
}: CliAuthMethodSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (
          next === AUTO_AUTH_METHOD ||
          (AUTH_METHOD_IDS as readonly string[]).includes(next ?? "")
        ) {
          onChange(next ?? AUTO_AUTH_METHOD);
        }
      }}
    >
      <SelectTrigger className="w-[190px] shrink-0" aria-label={ariaLabel}>
        <SelectValue>{authMethodLabel(value, fallbackAuthMethod)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={AUTO_AUTH_METHOD}>
          {authMethodLabel(AUTO_AUTH_METHOD, fallbackAuthMethod)}
        </SelectItem>
        {AUTH_METHODS.map((method) => (
          <SelectItem hideIndicator key={method.id} value={method.id}>
            {method.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Card row: the instance's session-start default auth method. Auto here means "no
 * override → use the profile default", so the fallback IS the profile default.
 */
export function CliDefaultAuthMethodRow({
  value,
  profileId,
  onChange,
}: {
  readonly value: string;
  readonly profileId: CliProfileId;
  readonly onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      title="Authentication method"
      description={'Sign-in method used when starting a session. "Auto" uses the profile\'s value.'}
      control={
        <CliAuthMethodSelect
          value={value}
          fallbackAuthMethod={resolveCliProfile(profileId).defaultAuthMethod}
          onChange={onChange}
        />
      }
    />
  );
}
