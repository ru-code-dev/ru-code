// ru-code: resolve a provider instance's effective CLI identity from its brand
// profile (@ru-code/branding), its per-instance settings and the boot preflight.
// Profile supplies defaults; `binaryPath`/`homePath` override; a null profile
// default falls back to the preflight-detected value. One resolver so the spawn,
// version probe, text-gen and error classifier all agree on bin+dir+
// name+artifact. See specs/cli-profiles.md.

import {
  asAuthMethodId,
  cliEnvAssignments,
  resolveCliProfile,
  type AuthMethodId,
  type CliProfile,
} from "@ru-code/branding";
import type { QwenSettings } from "@t3tools/contracts";

import { expandHomePath } from "../../pathExpansion.ts";
import { identityEnvRuntime } from "../preflight/common/identity.ts";

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
 * ru-code: the spawn env for EVERY qwen invocation — `baseEnv` with the branding CLI registry
 * (@ru-code/branding cliEnv.ts) written over the top. Each site that spawns the CLI (ACP sessions,
 * warm slots, one-shot text generation, the version probe) funnels through here, so a row added to
 * the registry reaches all of them at once and no site can quietly omit one.
 *
 * The registry is written LAST, so its values beat both an inherited shell variable and the
 * per-instance environment merged into `baseEnv` upstream: these are policy, not defaults. (That is
 * a deliberate reversal of the old base-env behaviour, where a per-instance variable could
 * override the CLI's home dir and point the spawn at the wrong profile.)
 *
 * `homeDir` is REQUIRED rather than optional because the CLI cannot run correctly without its
 * profile dir; it is expanded here since a spawned process gets no shell expansion and the stock
 * profile's default is the literal `~/.qwen`.
 */
export const buildCliEnv = (
  baseEnv: NodeJS.ProcessEnv,
  runtime: { readonly homeDir: string; readonly settingsOverlayPath?: string },
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // ru-code: identity is re-read at every spawn (CLI_PASS_IDENTITY, preflight identity.ts) so an
  // updated CLI's new identity is picked up by the very next spawn; a miss omits the variable.
  const assignments = cliEnvAssignments({
    HOME: expandHomePath(runtime.homeDir),
    ...(runtime.settingsOverlayPath ? { SYSTEM_SETTINGS_PATH: runtime.settingsOverlayPath } : {}),
    ...identityEnvRuntime(),
  });
  for (const [name, value] of assignments) env[name] = value;
  return env;
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
