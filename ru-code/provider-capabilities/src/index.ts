// ru-code: generic per-provider capability registry, shared by web AND server. Gate ANY
// provider-conditional feature here. The catalog is merely one *source value* — the capability
// itself is provider-general. Add a provider row or a capability field in this one place.

export type SkillAgentSource = "catalog" | "native" | "none";

export interface ProviderCapabilities {
  /** Where the composer's `$` skill picker sources items for this provider. */
  readonly skills: SkillAgentSource;
  /** Where the composer's `#` agent picker sources items for this provider. */
  readonly agents: SkillAgentSource;
  /** Where the composer's `/` command picker sources items for this provider. */
  readonly commands: SkillAgentSource;
  // extend freely as features arrive: mcp?, planMode?, vision?, …
}

// Keyed by the provider driver slug (`ProviderDriverKind` is a branded string, so a bare slug
// is assignable). qwen sources skills + agents from our catalog; codex (when enabled) has native
// skills only — add its row when its native source is wired.
const REGISTRY: Record<string, ProviderCapabilities> = {
  qwen: { skills: "catalog", agents: "catalog", commands: "catalog" },
  // codex: { skills: "native", agents: "none", commands: "none" },
};

const NONE: ProviderCapabilities = { skills: "none", agents: "none", commands: "none" };

export const providerCapabilities = (provider: string): ProviderCapabilities =>
  REGISTRY[provider] ?? NONE;

export const providerSkillSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).skills;

export const providerAgentSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).agents;

export const providerCommandSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).commands;
