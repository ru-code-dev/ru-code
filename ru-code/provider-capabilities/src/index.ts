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
  /**
   * ru-code (qwen-compression wave): does the APP run its own auto-compaction
   * for this provider — a hidden `/compress` at the end of a turn that crossed
   * `AUTO_COMPACT_USED_FRACTION`?
   *
   * FALSE for qwen since 0.21.1, and that is a fact about the CLI, not a
   * preference: qwen compresses itself before EVERY model send, including
   * tool-result continuations, on a warn/auto/hard ladder around 85 % of the
   * model window with an absolute ceiling of min(0.85·window, window − 33 000)
   * (qwen Session.ts:4363-4372; chatCompressionService.ts:58-83, :159-254). The
   * app's own 75 % trigger was a SECOND, earlier compaction layered under it —
   * two summarisers racing on one history, the app's one firing first and
   * costing a side-query the CLI was about to make anyway. Its threshold is not
   * client-settable either (`context.autoCompactThreshold` is read once at
   * session creation, config.ts:1893, :2173).
   *
   * Manual compaction is untouched: the meter button and the composer's
   * `/compress` both still work, for every provider.
   */
  readonly appAutoCompaction: boolean;
  // extend freely as features arrive: mcp?, planMode?, vision?, …
}

// Keyed by the provider driver slug (`ProviderDriverKind` is a branded string, so a bare slug
// is assignable). qwen sources skills + agents from our catalog; codex (when enabled) has native
// skills only — add its row when its native source is wired.
const REGISTRY: Record<string, ProviderCapabilities> = {
  qwen: { skills: "catalog", agents: "catalog", commands: "catalog", appAutoCompaction: false },
  // codex: { skills: "native", agents: "none", commands: "none", appAutoCompaction: false },
};

const NONE: ProviderCapabilities = {
  skills: "none",
  agents: "none",
  commands: "none",
  appAutoCompaction: false,
};

export const providerCapabilities = (provider: string): ProviderCapabilities =>
  REGISTRY[provider] ?? NONE;

export const providerSkillSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).skills;

export const providerAgentSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).agents;

export const providerCommandSource = (provider: string): SkillAgentSource =>
  providerCapabilities(provider).commands;

export const providerAppAutoCompaction = (provider: string): boolean =>
  providerCapabilities(provider).appAutoCompaction;

/**
 * Is app-side auto-compaction live for ANY provider? The `autoCompactContext`
 * setting is global (one switch, `packages/contracts/src/settings.ts`), so its
 * settings row has nothing provider-specific to key on — it is worth showing
 * only while some provider still reads it. Derived from the registry so the row
 * and the adapters can never disagree.
 */
export const APP_AUTO_COMPACTION_ANYWHERE: boolean = Object.values(REGISTRY).some(
  (capabilities) => capabilities.appAutoCompaction,
);
