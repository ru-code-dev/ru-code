// ru-code: read/write the CLI brand profile on a provider instance's opaque config
// blob, and resolve its display data via @ru-code/branding. Used by the add-provider
// dialog (write the chosen profile into the draft) and the provider card (read the
// profile for its title/description + the profile selector). See specs/cli-profiles.md.
import {
  asAuthMethodId,
  QWEN_KIND,
  CLI_PROFILE_IDS,
  resolveCliProfile,
  type AuthMethodId,
  type CliProfile,
  type CliProfileId,
} from "@ru-code/branding";

const asRecord = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};

/** The raw stored profile id, or `undefined` when unset/invalid (no defaulting). */
export function rawProfileId(config: unknown): CliProfileId | undefined {
  const raw = asRecord(config).profile;
  return typeof raw === "string" && (CLI_PROFILE_IDS as readonly string[]).includes(raw)
    ? (raw as CliProfileId)
    : undefined;
}

/** Whether a provider-driver kind is the profile-bearing CLI (qwen). */
export function isCliProfileDriver(driver: unknown): boolean {
  return String(driver) === QWEN_KIND;
}

/** The profile id stored on the config (narrowed to a known id; default when absent). */
export function readProfileId(config: unknown): CliProfileId {
  const raw = asRecord(config).profile;
  return resolveCliProfile(typeof raw === "string" ? raw : undefined).id;
}

/** The resolved profile (name / artifact / description / bin-dir defaults). */
export function readProfile(config: unknown): CliProfile {
  return resolveCliProfile(readProfileId(config));
}

/**
 * ru-code: the instance's EFFECTIVE session-start auth method — the per-instance
 * `defaultAuthMethod` override (when a known id) else the profile default. Mirrors
 * the server's resolveDefaultAuthMethod, so the per-model "Auto" hint matches what
 * qwen will actually use.
 */
export function effectiveDefaultAuthMethod(config: unknown): AuthMethodId {
  const raw = asRecord(config).defaultAuthMethod;
  return (
    asAuthMethodId(typeof raw === "string" ? raw : undefined) ??
    resolveCliProfile(readProfileId(config)).defaultAuthMethod
  );
}

/** A new config blob with `profile` set to `id` (non-destructive of other keys). */
export function writeProfile(config: unknown, id: CliProfileId): Record<string, unknown> {
  return { ...asRecord(config), profile: id };
}
