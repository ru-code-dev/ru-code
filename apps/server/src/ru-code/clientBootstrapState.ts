// ru-code: server-side holder for the appearance values stamped into the served
// HTML shell (see appearanceBootstrapHtml.ts). Kept in sync with the persisted
// ServerSettings by the serverSettings tap, mirroring @ru-code/localization's
// setLocale. The server doesn't otherwise render theme — these exist purely so
// the web client boots with the right appearance on any origin (port), before
// any JS runs. Defaults mirror the ServerSettings schema defaults.
//
// These five mirror t3's five appearance localStorage keys 1:1. t3's theme engine
// is untouched; only its storage backend moved to the server, because localStorage
// is scoped to host+PORT and the server takes a fresh port on most launches.
//   themePreference     ← t3code:theme                  (selected theme id)
//   appearanceMode      ← t3code:theme-appearance-mode  (light|dark|system)
//   followSystem        ← t3code:theme-follow-system    ("true"|"false")
//   themeHalves         ← t3code:theme-halves:v1        (raw JSON, opaque)
//   customThemes        ← t3code:themes:v1              (raw JSON, opaque)
// The two JSON payloads stay opaque strings so t3's own parseThemeHalves /
// parseStoredTheme remain the single validators and never drift from a duplicate.

export interface BootstrapAppearance {
  readonly themePreference: string;
  readonly appearanceMode: string;
  readonly followSystem: boolean;
  readonly themeHalves: string;
  readonly customThemes: string;
}

let bootstrapAppearance: BootstrapAppearance = {
  themePreference: "",
  appearanceMode: "system",
  followSystem: true,
  themeHalves: "",
  customThemes: "",
};

export function setBootstrapAppearance(next: BootstrapAppearance): void {
  bootstrapAppearance = next;
}

export function getBootstrapAppearance(): BootstrapAppearance {
  return bootstrapAppearance;
}

/** Map the persisted ServerSettings appearance fields onto the bootstrap holder shape.
 *  Structural param so this file stays dependency-free (no contracts import). */
export function appearanceFromSettings(settings: {
  readonly themePreference: string;
  readonly themeAppearanceMode: string;
  readonly themeFollowSystem: boolean;
  readonly themeHalves: string;
  readonly customThemes: string;
}): BootstrapAppearance {
  return {
    themePreference: settings.themePreference,
    appearanceMode: settings.themeAppearanceMode,
    followSystem: settings.themeFollowSystem,
    themeHalves: settings.themeHalves,
    customThemes: settings.customThemes,
  };
}
