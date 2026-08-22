// ru-code: resolve a provider instance's effective CLI identity from its brand
// profile (@ru-code/branding), its per-instance settings and the boot preflight.
// Profile supplies defaults; `binaryPath`/`homePath` override; a null profile
// default falls back to the preflight-detected value. One resolver so the spawn,
// version probe, text-gen and error classifier all agree on bin+dir+
// name+artifact. See specs/cli-profiles.md.

import {
  asAuthMethodId,
  resolveCliProfile,
  type AuthMethodId,
  type CliProfile,
} from "@ru-code/branding";
import type { QwenSettings } from "@t3tools/contracts";

/** The boot preflight result threaded via ServerConfig (`cliJs`/`cliConfigDir`). */
export interface CliPreflight {
  readonly cliJs: string;
  readonly cliConfigDir: string;
}

export interface ResolvedCliProfile {
  readonly profile: CliProfile;
  /** Display label for this instance (chat picker, settings, messages). */
  readonly name: string;
  /** CONTEXT-file base → `${artifact}.md`. */
  readonly artifact: string;
  /** cli.js / binary to spawn; `""` when neither settings nor preflight resolved one. */
  readonly bin: string;
  /** CLI home dir; `""` ⇒ let the CLI use its own default. */
  readonly dir: string;
}

export const resolveCliProfileSettings = (
  settings: Pick<QwenSettings, "profile" | "binaryPath" | "homePath">,
  preflight: CliPreflight,
): ResolvedCliProfile => {
  const profile = resolveCliProfile(settings.profile);
  const binOverride = settings.binaryPath?.trim() ?? "";
  const dirOverride = settings.homePath?.trim() ?? "";
  const bin = binOverride.length > 0 ? binOverride : (profile.binDefault ?? preflight.cliJs);
  const dir = dirOverride.length > 0 ? dirOverride : (profile.dirDefault ?? preflight.cliConfigDir);
  return { profile, name: profile.name, artifact: profile.artifact, bin, dir };
};

/**
 * ru-code: the session-start ACP `authenticate` methodId for an instance —
 * the per-instance override (`defaultAuthMethod`) when set to a known id, else
 * the profile's default. This is what `session/new`'s `ensureAuthenticated`
 * requires (qwen throws `authRequired` without it).
 */
export const resolveDefaultAuthMethod = (
  settings: Pick<QwenSettings, "profile" | "defaultAuthMethod">,
): AuthMethodId =>
  asAuthMethodId(settings.defaultAuthMethod) ??
  resolveCliProfile(settings.profile).defaultAuthMethod;

/**
 * ru-code: the auth method a given model slug dispatches with. Built-in models
 * carry their own; a custom model uses its stored `authMethod` (when a known id),
 * else the instance default. Unknown slugs fall back to the instance default too.
 */
export const resolveModelAuthMethod = (
  settings: Pick<QwenSettings, "profile" | "defaultAuthMethod" | "customModels">,
  slug: string,
): AuthMethodId => {
  const profile = resolveCliProfile(settings.profile);
  const builtIn = profile.models.find((model) => model.slug === slug);
  if (builtIn) return builtIn.authMethod;
  const custom = settings.customModels.find((model) => model.slug === slug);
  return asAuthMethodId(custom?.authMethod) ?? resolveDefaultAuthMethod(settings);
};

/**
 * ru-code: qwen's ACP model-id wire format — `${slug}(${authMethod})` (matches the
 * CLI's own `formatAcpModelId`, qwen-code/packages/cli/src/utils/acpModelUtils.ts).
 * The slug stays clean everywhere upstream; auth is appended only at this boundary.
 */
export const formatQwenModelId = (slug: string, authMethod: AuthMethodId): string =>
  `${slug}(${authMethod})`;
