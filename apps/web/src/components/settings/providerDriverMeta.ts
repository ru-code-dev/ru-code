import {
  // ru-code: temporarily limited to qwen + opencode. To restore a driver,
  // uncomment its settings import here, its icon import below, and its entry
  // in PROVIDER_CLIENT_DEFINITIONS (also re-add it to the server
  // BUILT_IN_DRIVERS array).
  // ClaudeSettings,
  // CodexSettings,
  // CursorSettings,
  // GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  QwenSettings, // ru-code
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
// ru-code: full icon set (kept for reference while drivers are limited):
// import { ClaudeAI, CursorIcon, GrokIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { type Icon, OpenCodeIcon } from "../Icons";
// ru-code: qwen's driver-list glyph + label are the default brand-profile's (not
// OpenAI's / "Qwen") — so the catalog entry reads what a new instance becomes by
// default (Custom Code). Per-instance cards still show each instance's own profile.
import { DEFAULT_CLI_PROFILE_ID, resolveCliProfile } from "@ru-code/branding";
import { iconForProfile } from "~/ru-code/cliProfiles/icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  // ru-code: qwen is this build's primary driver; listed first so the
  // add-provider dialog defaults to it (DRIVER_OPTIONS[0]).
  {
    value: ProviderDriverKind.make("qwen"),
    label: resolveCliProfile(DEFAULT_CLI_PROFILE_ID).name,
    icon: iconForProfile(DEFAULT_CLI_PROFILE_ID),
    settingsSchema: QwenSettings,
  },
  // ru-code: temporarily commented (drivers limited to qwen + opencode).
  // Uncomment any block to bring the provider back — also restore its
  // settings/icon imports above and the server BUILT_IN_DRIVERS entry.
  // {
  //   value: ProviderDriverKind.make("codex"),
  //   label: "Codex",
  //   icon: OpenAI,
  //   settingsSchema: CodexSettings,
  // },
  // {
  //   value: ProviderDriverKind.make("claudeAgent"),
  //   label: "Claude",
  //   icon: ClaudeAI,
  //   settingsSchema: ClaudeSettings,
  // },
  // {
  //   value: ProviderDriverKind.make("cursor"),
  //   label: "Cursor",
  //   icon: CursorIcon,
  //   badgeLabel: "Early access",
  //   settingsSchema: CursorSettings,
  // },
  // {
  //   value: ProviderDriverKind.make("grok"),
  //   label: "Grok",
  //   icon: GrokIcon,
  //   badgeLabel: "Early access",
  //   settingsSchema: GrokSettings,
  // },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
  },
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
